import { In, LessThanOrEqual, MoreThan } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { CATCHUP, CATCHUP_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { IntakeCatchup } from '../../entities';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { pipelineFull } from '../po-pipeline/pipeline.service';
import { catchUpChannels } from './label-router.service';

/*
 * Gmail catch-ups as rows (2026-10-29, user: no more "switch it off and on"; constants/gmail-intake.ts CATCHUP):
 *   requestCatchUp  an email channel switched ON / its start moved earlier -> its row waiting (an earlier start of a
 *                   row not finished yet is kept), then a run starts.
 *   the run         every row due (waiting, or failed and its retry time came) in ONE Gmail pass; done -> counts;
 *                   failed -> tried again after 2, 5, 15, 30, 60, 60 ... minutes, by itself.
 *   resumeCatchUps  on start: a row left running by a stop is waiting again; due rows run.
 * One run at a time; a request during a run is picked up right after it. A row asked again while its pass runs is
 * not marked done by that pass (the update only touches rows still running).
 */

const repo = () => AppDataSource.getRepository(IntakeCatchup);
let running: Promise<void> | null = null;
let again = false;
let timer: NodeJS.Timeout | undefined;

const retryAt = (attempts: number) =>
  new Date(Date.now() + CATCHUP.RETRY_MINUTES[Math.min(attempts, CATCHUP.RETRY_MINUTES.length) - 1] * 60_000);

/** Wakes the runner at the next retry time (one timer, never keeps the process alive). */
const scheduleNext = async (): Promise<void> => {
  const next = await repo().findOne({
    select: { channel: true, nextTryAt: true },
    where: { status: In([CATCHUP_STATUS.WAITING, CATCHUP_STATUS.FAILED]), nextTryAt: MoreThan(new Date()) },
    order: { nextTryAt: 'ASC' },
  });
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!next?.nextTryAt) return;
  timer = setTimeout(() => void kickCatchUps(), Math.max(1_000, next.nextTryAt.getTime() - Date.now()));
  timer.unref();
};

const runDue = async (): Promise<void> => {
  for (;;) {
    const due = await repo().find({ where: { status: In([CATCHUP_STATUS.WAITING, CATCHUP_STATUS.FAILED]), nextTryAt: LessThanOrEqual(new Date()) } });
    if (!due.length) break;
    const channels = due.map((d) => d.channel);
    await repo().update({ channel: In(channels) }, { status: CATCHUP_STATUS.RUNNING });
    const stillRunning = (channel: string) => ({ channel, status: CATCHUP_STATUS.RUNNING });
    try {
      const counts = await runJob('intake-catch-up', () => catchUpChannels(new Map(due.map((d) => [d.channel, d.fromAt]))), { channels: channels.join(',') });
      // PIPELINE_LIMIT stopped the pass: not done, the rest is taken on a later try
      if (pipelineFull()) throw new Error('PIPELINE_LIMIT reached: the pass stopped, the rest stays in Gmail');
      const now = new Date();
      for (const d of due) {
        const c = counts.get(d.channel) ?? { found: 0, sent: 0 };
        await repo().update(stillRunning(d.channel), { status: CATCHUP_STATUS.DONE, attempts: 0, nextTryAt: null, lastError: null, found: c.found, sent: c.sent, finishedAt: now });
      }
      log.info(LOG_SOURCE.GMAIL, `[catch-up] ${channels.join(', ')}: done (${channels.map((ch) => `${ch} ${counts.get(ch)?.sent ?? 0} sent`).join(', ')})`);
    } catch (err) {
      const f = logError(LOG_SOURCE.GMAIL, `[catch-up] ${channels.join(', ')} failed: tried again by itself`, err);
      for (const d of due) {
        const attempts = d.attempts + 1;
        await repo().update(stillRunning(d.channel), {
          status: CATCHUP_STATUS.FAILED, attempts, nextTryAt: retryAt(attempts), lastError: `${f.kind}: ${f.error ?? ''}`.slice(0, CATCHUP.LAST_ERROR_MAX),
        });
      }
      break; // the retry time decides when; never straight away
    }
  }
  await scheduleNext();
};

/** Runs the due catch-ups now (or right after the run in progress). */
export const kickCatchUps = (): Promise<void> => {
  if (running) {
    again = true;
    return running;
  }
  running = runDue()
    .catch((err) => { logError(LOG_SOURCE.GMAIL, '[catch-up] run failed (the next request / start tries again)', err); })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void kickCatchUps();
      }
    });
  return running;
};

/** A channel's catch-up from `from` (switched ON / start moved earlier). Kept as a row: never lost, retried. */
export const requestCatchUp = async (channel: string, from: Date): Promise<void> => {
  const row = await repo().findOneBy({ channel });
  const open = row && row.status !== CATCHUP_STATUS.DONE;
  const fromAt = open && row.fromAt < from ? row.fromAt : from;
  const now = new Date();
  await repo().save({
    channel, fromAt, status: CATCHUP_STATUS.WAITING, attempts: 0, nextTryAt: now, lastError: null,
    found: row?.found ?? null, sent: row?.sent ?? null, requestedAt: now, finishedAt: row?.finishedAt ?? null,
  });
  log.info(LOG_SOURCE.GMAIL, `[catch-up] ${channel}: asked from ${fromAt.toISOString()}`);
  void kickCatchUps();
};

/** On start: rows a stop left running are waiting again; whatever is due runs. */
export const resumeCatchUps = async (): Promise<void> => {
  await repo().update({ status: CATCHUP_STATUS.RUNNING }, { status: CATCHUP_STATUS.WAITING, nextTryAt: new Date() });
  await kickCatchUps();
};
