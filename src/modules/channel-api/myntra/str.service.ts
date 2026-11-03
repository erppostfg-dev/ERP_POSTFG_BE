import fs from 'fs/promises';
import path from 'path';
import { In, IsNull } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { APP_STATE_KEY, FILES, FOLDERS, monthFolder, MYNTRA_STR, SOURCE_SYSTEM, yearFolder } from '../../../constants';
import { LOG_SOURCE } from '../../../constants/logging';
import { AppState, ChannelPullItem } from '../../../entities';
import { log } from '../../../utils/logger';
import { s3UrlOfKey, writeS3Text } from '../../email-intake/s3-mirror.service';
import { runSellerHubJob } from '../../intransit/runs.service';
import { readBodyText } from '../../po-processing/common/email-sources';
import { intakeGate } from '../../po-intake-control/intake-settings.service';
import { isStrEmail, StrRef, strsOf } from './str-email';
import { strToProcessed, StrSummary } from './str.parse';
import { FetchedStr } from './str.robot';

/*
 * Myntra STRs, server side (2026-11-03, user: "until processed.json; the checks later"):
 *   1. a NEW Po-Intake email that is a Myntra STR list (subject + "Please find the STR Numbers listed below" in its newest
 *      part), Myntra ON in PO intake and after its start -> every STR not seen before = a channel_pull_items row
 *      (status null = waiting), in the email's order; then the robot starts;
 *   2. the robot (In-transit worker, the Myntra login, one browser job at a time) downloads each waiting STR's CSV;
 *   3. here: CSV + processed.json -> S3 channel-api/FY<yy><yy>/<month>/myntra/<STR>/ (no local copy kept), the row ->
 *      `stored` with the S3 folder and a summary. An STR that fails waits for the next run; after MAX_RUNS runs -> failed.
 * Nothing goes to po_uploads / validation / the PO tables yet. One run at a time; an email during a run -> one more run.
 */

export interface StrItemData {
  email: { folder: string; subject: string; receivedAt: string | null };
  order: number;
  group: string;
  priority: string;
  destination: string;
  runs: number;
  lastError: string | null;
  s3Folder?: string;
  summary?: StrSummary;
}

export interface StrRun {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  trigger: string;
  asked: number;
  stored: number;
  failed: { str: string; error: string }[];
  error: string | null;
  log: string[];
}

const repo = () => AppDataSource.getRepository(ChannelPullItem);
const stateRepo = () => AppDataSource.getRepository(AppState);
const S = SOURCE_SYSTEM.MYNTRA_STR;

export const strRobotConfigured = (): boolean => !!(env.intransit.myntra.user && env.intransit.myntra.password);

export const lastStrRun = async (): Promise<StrRun | null> =>
  ((await stateRepo().findOneBy({ key: APP_STATE_KEY.MYNTRA_STR_ROBOT }))?.value as StrRun | undefined) ?? null;
const saveRun = (run: StrRun) => stateRepo().save({ key: APP_STATE_KEY.MYNTRA_STR_ROBOT, value: run as unknown as Record<string, unknown>, updatedAt: new Date() });

/** S3 folder (no trailing slash) of one STR, by the date in its code. */
export const strS3Folder = (str: string, date: string): string => {
  const d = new Date(`${date}T06:00:00Z`);
  return `${env.s3.prefix}${FOLDERS.CHANNEL_API}/${yearFolder(d)}/${monthFolder(d)}/${MYNTRA_STR.CHANNEL}/${str}`;
};

// ---- 1. the email ----------------------------------------------------------------------------------------------------

/**
 * A stored email (its local folder): when it is a Myntra STR list and Myntra intake takes it, its new STRs become
 * waiting rows and the robot starts. Returns null when it is not an STR list.
 */
export const takeStrEmail = async (folder: string, start: (trigger: string) => void = (t) => void startStrRun(t)):
  Promise<{ gate: 'take' | 'off' | 'before'; strs: number; added: number } | null> => {
  const meta = JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as { subject?: string; receivedAt?: string };
  const body = await readBodyText(folder);
  if (!isStrEmail(meta.subject, body)) return null;
  const receivedAt = meta.receivedAt ? new Date(meta.receivedAt) : null;
  const gate = await intakeGate(MYNTRA_STR.CHANNEL, receivedAt);
  const refs = strsOf(body);
  if (gate !== 'take') {
    log.info(LOG_SOURCE.APP, `[myntra-str] ${path.basename(folder)}: ${refs.length} STR(s) not taken (Myntra intake ${gate})`);
    return { gate, strs: refs.length, added: 0 };
  }
  const known = new Set(refs.length
    ? (await repo().find({ select: { externalId: true }, where: { sourceSystem: S, externalId: In(refs.map((r) => r.str)) } })).map((r) => r.externalId)
    : []);
  const fresh = refs.filter((r) => !known.has(r.str));
  const now = new Date();
  const rowOf = (r: StrRef): Partial<ChannelPullItem> => {
    const data: StrItemData = {
      email: { folder: path.basename(folder), subject: meta.subject ?? '', receivedAt: meta.receivedAt ?? null },
      order: r.order, group: r.group, priority: r.priority, destination: r.destination, runs: 0, lastError: null,
    };
    return {
      sourceSystem: S, externalId: r.str, status: MYNTRA_STR.STATUS.WAITING, warehouse: r.destination, createdOn: r.date,
      label: `${r.str} · ${[r.group, r.priority].filter(Boolean).join(' ')} · ${r.destination}`.slice(0, 300),
      data: { ...data }, fetchedAt: now, takenAt: null,
    };
  };
  let added = 0;
  for (const r of fresh) {
    try {
      await repo().save(repo().create(rowOf(r)));
      added++;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err; // the same STR from another email at once
    }
  }
  log.info(LOG_SOURCE.APP, `[myntra-str] ${path.basename(folder)}: ${refs.length} STR(s), ${added} new, ${refs.length - added} seen before`);
  if (added) start('email');
  return { gate, strs: refs.length, added };
};

// ---- 2 + 3. the robot run and S3 ---------------------------------------------------------------------------------

/** Keeps one STR's CSV + processed.json in S3 and marks the row stored. */
const storeOne = async (item: ChannelPullItem, csv: string): Promise<void> => {
  const data = item.data as unknown as StrItemData;
  const ref = { str: item.externalId, date: item.createdOn ?? '', destination: data.destination, group: data.group, priority: data.priority };
  const { po, summary } = strToProcessed(ref, csv);
  const folder = strS3Folder(item.externalId, ref.date);
  await writeS3Text(s3UrlOfKey(`${folder}/${MYNTRA_STR.CSV_FILE(item.externalId)}`), csv);
  await writeS3Text(s3UrlOfKey(`${folder}/${FILES.PROCESSED}`), `${JSON.stringify(po, null, 2)}\n`);
  const next: StrItemData = { ...data, s3Folder: folder, summary, lastError: null };
  await repo().save({ ...item, status: MYNTRA_STR.STATUS.STORED, data: { ...next } });
};

const failOne = async (item: ChannelPullItem, error: string): Promise<boolean> => {
  const data = item.data as unknown as StrItemData;
  const runs = (data.runs ?? 0) + 1;
  const final = runs >= MYNTRA_STR.MAX_RUNS;
  const next: StrItemData = { ...data, runs, lastError: error.slice(0, 300) };
  await repo().save({ ...item, status: final ? MYNTRA_STR.STATUS.FAILED : MYNTRA_STR.STATUS.WAITING, data: { ...next } });
  return final;
};

/** The robot as a function (tests replace it; the server runs it in the In-transit worker). */
export type StrFetcher = (strs: string[], onLog: (line: string) => void) => Promise<FetchedStr[]>;
const workerFetch: StrFetcher = (strs, onLog) =>
  runSellerHubJob<FetchedStr[]>(MYNTRA_STR.ROBOT_JOB, (cacheDir) => ({ kind: MYNTRA_STR.ROBOT_JOB, myntra: env.intransit.myntra, cacheDir, strs }), MYNTRA_STR.ROBOT_TIMEOUT_MS, onLog);

export const runStrRobot = async (trigger: string, fetcher: StrFetcher = workerFetch): Promise<StrRun> => {
  const out: StrRun = { startedAt: new Date().toISOString(), finishedAt: null, ok: null, trigger, asked: 0, stored: 0, failed: [], error: null, log: [] };
  const line = (l: string) => { out.log.push(l); if (out.log.length > MYNTRA_STR.LOG_LINES) out.log.shift(); };
  const waiting = await repo().find({ where: { sourceSystem: S, status: IsNull() }, order: { id: 'ASC' } });
  out.asked = waiting.length;
  if (!waiting.length) return out;
  await saveRun(out);
  try {
    const results = await fetcher(waiting.map((w) => w.externalId), line);
    const byStr = new Map(results.map((r) => [r.str, r]));
    for (const item of waiting) {
      const r = byStr.get(item.externalId);
      try {
        if (r?.csv) {
          await storeOne(item, r.csv);
          out.stored++;
        } else {
          const error = r?.error ?? 'not downloaded';
          out.failed.push({ str: item.externalId, error: (await failOne(item, error)) ? `${error} (failed: no more tries)` : error });
        }
      } catch (err) {
        const error = `S3: ${err instanceof Error ? err.message : String(err)}`;
        await failOne(item, error);
        out.failed.push({ str: item.externalId, error });
      }
    }
    out.ok = true;
    log.info(LOG_SOURCE.APP, `[myntra-str] ${trigger}: ${out.asked} asked, ${out.stored} stored in S3, ${out.failed.length} failed`);
  } catch (err) {
    out.ok = false;
    out.error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    // the whole run failed (login, browser): each STR counts one try
    for (const item of waiting) await failOne(item, out.error);
    log.error(LOG_SOURCE.APP, `[myntra-str] ${trigger}: failed (waiting STRs are tried again): ${out.error}`);
  }
  out.finishedAt = new Date().toISOString();
  await saveRun(out);
  return out;
};

let running: Promise<StrRun> | null = null;
let again = false;

/** Starts a run unless one is going (then one more run follows it, for STRs that came meanwhile). */
export const startStrRun = (trigger: string): Promise<StrRun> | null => {
  if (!strRobotConfigured()) {
    log.warn(LOG_SOURCE.APP, `[myntra-str] ${trigger}: not run, MYNTRA_PARTNER_USER / _PASSWORD missing`);
    return null;
  }
  if (running) { again = true; return running; }
  running = runStrRobot(trigger).finally(() => {
    running = null;
    if (again) { again = false; void startStrRun('more STRs came during the run'); }
  });
  return running;
};

/** Self-healing: waiting STRs (a failed run, a restart) are tried again every RETRY_MS (not in laptop mode). */
export const startStrRetry = (everyMs = 30 * 60_000): { stop: () => void } => {
  const timer = setInterval(() => {
    void repo().count({ where: { sourceSystem: S, status: IsNull() } })
      .then((n) => { if (n && !running) void startStrRun('retry'); })
      .catch((err: unknown) => log.error(LOG_SOURCE.APP, `[myntra-str] retry check failed: ${err instanceof Error ? err.message : String(err)}`));
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
