import { Between } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { INTRANSIT_REPORT_NAME, INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS } from '../../../constants';
import { IntransitRun } from '../../../entities';
import { istToday } from '../input-store';
import { baseName, FOLDER, fyFirstWeek, fyStartYear, isoWeekOf, monthlyKey, weeklyKey } from './layout';
import { withLock } from './lock';
import { isDeleted, reportDirOf, scopeOfRun } from './run-store';
import { PROD_SCOPE, rootOf, writeScope } from './scope';
import { copy, head, list } from './store';

/*
 * The weekly and monthly copies (user, 2026-10-26: kept forever): Weekly Snapshot/<FY>/W43.xlsx and Monthly
 * Snapshot/<FY>/October.xlsx hold the workbook of the period's final build - the latest report day in the period, and
 * of that day the highest run id; succeeded, not deleted, live server only. The current week/month's copy follows the
 * newest build until the period ends. A copy is redone only when its run-id differs; a winner whose Full Report has
 * expired keeps the old copy. Runs on the live server only, one machine at a time (GET_LOCK), after each build, at
 * start, every 6 hours and after a delete, for the periods touching the last 100 days.
 */

const DAY_MS = 86_400_000;
const CATCH_UP_DAYS = 100;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const monthBounds = (day: string): [string, string] => {
  const [y, m] = day.split('-').map(Number);
  return [`${day.slice(0, 7)}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
};

/** The final build of [from, to]: latest asOf, then highest id. */
const winnerOf = async (from: string, to: string): Promise<IntransitRun | null> => {
  const runs = (await AppDataSource.getRepository(IntransitRun).find({
    where: { kind: INTRANSIT_RUN_KIND.REPORT, status: INTRANSIT_RUN_STATUS.SUCCEEDED, asOf: Between(from, to) },
  })).filter((r) => scopeOfRun(r) === PROD_SCOPE && !isDeleted(r) && !!reportDirOf(r));
  return runs.sort((a, b) => (b.asOf as string).localeCompare(a.asOf as string) || Number(b.id) - Number(a.id))[0] ?? null;
};

/** Make one period's copy follow its winner. */
const keepPeriod = async (target: string, from: string, to: string, log: string[]): Promise<void> => {
  const winner = await winnerOf(from, to);
  const current = await head(target, { fresh: true });
  if (!winner) return; // no build in the period (any old copy stays)
  if (current?.meta.runId === winner.id) return;
  const source = `${reportDirOf(winner)}${INTRANSIT_REPORT_NAME}`;
  try {
    await copy(source, target, { source: 'period', runId: winner.id, day: winner.asOf });
    log.push(`${baseName(target)} <- run ${winner.id} (${winner.asOf})`);
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return; // its Full Report expired: the old copy stays
    throw err;
  }
};

/** The week and month of `day`. */
export const touchPeriods = async (day: string): Promise<string[]> => {
  if (writeScope() !== PROD_SCOPE) return []; // test machines make no weekly/monthly copies (user)
  const log: string[] = [];
  await withLock('it:periods', async () => {
    const w = isoWeekOf(day);
    await keepPeriod(weeklyKey(PROD_SCOPE, day).key, w.monday, w.sunday, log);
    const [first, last] = monthBounds(day);
    await keepPeriod(monthlyKey(PROD_SCOPE, day).key, first, last, log);
  }, 120);
  return log;
};

/** Every week and month touching the last CATCH_UP_DAYS days. */
export const catchUpPeriods = async (): Promise<string[]> => {
  if (writeScope() !== PROD_SCOPE) return [];
  const log: string[] = [];
  const today = istToday();
  const seen = new Set<string>();
  for (let d = addDays(today, -CATCH_UP_DAYS); d <= today; d = addDays(d, 1)) {
    const w = isoWeekOf(d);
    const [mFirst] = monthBounds(d);
    const id = `${w.monday}|${mFirst}`;
    if (seen.has(id)) continue;
    seen.add(id);
    log.push(...(await touchPeriods(d)));
  }
  return log;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The first day of a weekly (W43) or monthly (October) copy of an FY (FY26-27), for sorting by date. */
export const periodStart = (kind: 'weekly' | 'monthly', fy: string, label: string): string | null => {
  const startYear = fyStartYear(fy);
  if (kind === 'monthly') {
    const m = MONTHS.indexOf(label);
    if (m < 0) return null;
    const year = m >= 3 ? startYear : startYear + 1;
    return `${year}-${String(m + 1).padStart(2, '0')}-01`;
  }
  const lm = /^W(\d{2})(?:_(\d{4}))?$/.exec(label);
  if (!lm) return null;
  const week = Number(lm[1]);
  // an FY holds ISO weeks from its first week (13 or 14) of the start year, then W01.. of the next year
  const year = lm[2] ? Number(lm[2]) : week >= fyFirstWeek(startYear) ? startYear : startYear + 1;
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday + (week - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
};

export interface PeriodCopy {
  kind: 'weekly' | 'monthly';
  fy: string;
  label: string;
  /** The period's first day (sort by this, not by the name: W01 comes after W53 in an FY). */
  from: string | null;
  key: string;
  size: number;
  modified: Date;
}

/** The weekly and monthly copies there are, newest first by date. */
export const listPeriods = async (): Promise<PeriodCopy[]> => {
  const root = rootOf(PROD_SCOPE);
  const out: PeriodCopy[] = [];
  for (const [kind, folder] of [['weekly', FOLDER.WEEKLY], ['monthly', FOLDER.MONTHLY]] as const) {
    for (const o of await list(`${root}${folder}/`)) {
      const m = /\/(FY\d{2}-\d{2})\/([^/]+)\.xlsx$/.exec(o.key);
      if (m) out.push({ kind, fy: m[1], label: m[2], from: periodStart(kind, m[1], m[2]), key: o.key, size: o.size, modified: o.modified });
    }
  }
  return out.sort((a, b) => (b.from ?? '').localeCompare(a.from ?? '') || a.kind.localeCompare(b.kind));
};

let timer: NodeJS.Timeout | null = null;

/** At start and every 6 hours (live server only). */
export const startPeriodKeeper = (): void => {
  if (timer || writeScope() !== PROD_SCOPE) return;
  const run = (): void => void catchUpPeriods()
    .then((log) => log.length && console.log(`[intransit-s3] weekly/monthly copies: ${log.join('; ')}`))
    .catch((err) => console.error('[intransit-s3] weekly/monthly copies:', err instanceof Error ? err.message : err));
  run();
  timer = setInterval(run, 6 * 3600_000);
  timer.unref();
};

export const stopPeriodKeeper = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
