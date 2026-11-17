import { env } from '../../config/env';
import { AppDataSource } from '../../config/data-source';
import { DATA_SYNC, DATA_SYNC_JOB, DataSyncJob, ERROR_CODES, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { runDevCopy } from './dev-copy.service';
import { runPepimsSync } from './import.service';

/*
 * Admin > Data sync (2026-11-17; was the PO Overview "Sync from PEPIMS" button of 2026-11-16). ONE WAY only (user):
 *   - PEPIMS -> this database (runPepimsSync): what PEPIMS changed comes in; nothing is ever written into PEPIMS;
 *   - dev -> this database (runDevCopy): what is new / changed on dev comes in; nothing is ever written into dev.
 * Both only when the app's own database is env.pepimsSync.targetDb (prod): the dev server and the laptop read / write
 * mcaff_postfg_dev, so they refuse (409 DATA_SYNC_NOT_HERE) and their timer does nothing.
 * Every night at 01:00 IST (until the switch is turned off in the tab; no row = ON): PEPIMS first, then dev. A server
 * that was down at 01:00 catches up until 07:00 IST, else the next night. One job at a time per server; each job's last
 * run (when, who, result) is kept in app_state so the tab shows it after a restart.
 */

export interface DataSyncRun {
  startedAt: string | null;
  finishedAt: string | null;
  by: string | null;
  ok: boolean | null;
  error: string | null;
  summary: Record<string, number> | null;
}
interface NightlyState { enabled?: boolean; lastDate?: string | null; changedBy?: string | null; changedAt?: string | null }

const LABEL: Record<DataSyncJob, string> = { pepims: 'Sync from PEPIMS', devCopy: 'Copy from dev' };
let running: DataSyncJob | null = null;
let timer: NodeJS.Timeout | null = null;

const readKey = async <T>(key: string): Promise<Partial<T>> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [key]);
  return (row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {}) as Partial<T>;
};
const saveKey = (key: string, v: unknown) => AppDataSource.query(
  `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
  [key, JSON.stringify(v), new Date()],
);
const readRun = async (job: DataSyncJob): Promise<DataSyncRun> => {
  const v = await readKey<DataSyncRun>(DATA_SYNC.RUN_KEY[job]);
  return { startedAt: v.startedAt ?? null, finishedAt: v.finishedAt ?? null, by: v.by ?? null, ok: v.ok ?? null, error: v.error ?? null, summary: v.summary ?? null };
};

/** The app's own database and whether the jobs may write into it. */
const where = () => {
  const database = String(AppDataSource.options.database);
  return { database, targetDb: env.pepimsSync.targetDb, allowed: database === env.pepimsSync.targetDb };
};

const work: Record<DataSyncJob, () => Promise<Record<string, number>>> = {
  pepims: async () => {
    const r = await runPepimsSync({ apply: true });
    return { read: r.read, inserted: r.inserted, linked: r.linked, updated: r.updated, unchanged: r.unchanged, conflicts: r.conflictsKeptOurs.length, logsAdded: r.logsAdded };
  },
  devCopy: async () => {
    const r = await runDevCopy({ apply: true });
    return {
      posLinked: r.posLinked, posAdded: r.posAdded, posUpdated: r.posUpdated, linesAdded: r.linesAdded, usersAdded: r.usersAdded.length,
      history: r.tables[TABLES.SHIPMENT_LOGS] ?? 0, uploads: r.tables[TABLES.PO_UPLOADS] ?? 0,
    };
  },
};

/** One run of a job, written. Never throws: the result goes into its last-run record and the log. false = busy / not here. */
export const runDataSyncJob = async (job: DataSyncJob, by: string): Promise<boolean> => {
  if (running || !where().allowed) return false;
  running = job;
  const run: DataSyncRun = { startedAt: new Date().toISOString(), finishedAt: null, by, ok: null, error: null, summary: null };
  try {
    await saveKey(DATA_SYNC.RUN_KEY[job], run);
    run.summary = await work[job]();
    run.ok = true;
    log.info(LOG_SOURCE.APP, `[data-sync] ${LABEL[job]} done by ${by}: ${JSON.stringify(run.summary)}`);
  } catch (e) {
    run.ok = false;
    run.error = e instanceof Error ? e.message : String(e);
    log.error(LOG_SOURCE.APP, `[data-sync] ${LABEL[job]} failed (by ${by}): ${run.error}`, {
      fix: job === DATA_SYNC_JOB.PEPIMS ? 'check the DB login can read the PEPIMS database (PEPIMS_SYNC_SOURCE_DB)' : 'check the DB login can read the dev database (DEV_COPY_SOURCE_DB) and both have the same migrations',
    });
  } finally {
    run.finishedAt = new Date().toISOString();
    running = null;
    await saveKey(DATA_SYNC.RUN_KEY[job], run).catch(() => undefined);
  }
  return true;
};

/** IST calendar day + minutes after IST midnight. */
export const istClock = (now: Date) => {
  const ist = new Date(now.getTime() + DATA_SYNC.IST_OFFSET_MINUTES * 60_000);
  return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
};
const nightlyState = async () => {
  const v = await readKey<NightlyState>(DATA_SYNC.NIGHTLY_KEY);
  return { enabled: v.enabled ?? true, lastDate: v.lastDate ?? null, changedBy: v.changedBy ?? null, changedAt: v.changedAt ?? null };
};

export const dataSyncStatus = async () => {
  const n = await nightlyState();
  const at = `${String(DATA_SYNC.NIGHTLY_IST.HOUR).padStart(2, '0')}:${String(DATA_SYNC.NIGHTLY_IST.MINUTE).padStart(2, '0')}`;
  return {
    ...where(),
    running,
    pepims: await readRun(DATA_SYNC_JOB.PEPIMS),
    devCopy: await readRun(DATA_SYNC_JOB.DEV_COPY),
    nightly: { ...n, atIst: at, timerOn: timer !== null },
  };
};

/** POST: start a job now (202). 409 when another runs or this server's database is not the target. */
export const startDataSync = async (job: DataSyncJob, by: string) => {
  const w = where();
  if (!w.allowed) throw appError(ERROR_CODES.DATA_SYNC_NOT_HERE, w.database, w.targetDb);
  if (running) throw appError(ERROR_CODES.DATA_SYNC_RUNNING, LABEL[running]);
  void runDataSyncJob(job, by);
  return { state: 'started' as const, ...(await dataSyncStatus()) };
};

/** PUT: the nightly switch (kept until changed again). */
export const setNightlySync = async (enabled: boolean, by: string) => {
  const n = await nightlyState();
  await saveKey(DATA_SYNC.NIGHTLY_KEY, { enabled, lastDate: n.lastDate, changedBy: by, changedAt: new Date().toISOString() });
  log.info(LOG_SOURCE.APP, `[data-sync] nightly run switched ${enabled ? 'ON' : 'OFF'} by ${by}`);
  return dataSyncStatus();
};

/** The nightly run when due (ON, between 01:00 and 07:00 IST, not run this IST day yet): PEPIMS, then dev. */
export const runNightlyIfDue = async (now = new Date()): Promise<boolean> => {
  if (running || !where().allowed) return false;
  const n = await nightlyState();
  const c = istClock(now);
  const from = DATA_SYNC.NIGHTLY_IST.HOUR * 60 + DATA_SYNC.NIGHTLY_IST.MINUTE;
  if (!n.enabled || n.lastDate === c.date || c.minutes < from || c.minutes >= DATA_SYNC.NIGHTLY_IST.END_HOUR * 60) return false;
  // the day is marked first: a crash in the middle never makes it run again and again the same night
  await saveKey(DATA_SYNC.NIGHTLY_KEY, { enabled: n.enabled, lastDate: c.date, changedBy: n.changedBy, changedAt: n.changedAt });
  log.info(LOG_SOURCE.APP, `[data-sync] nightly run for ${c.date} (IST): PEPIMS, then dev`);
  await runDataSyncJob(DATA_SYNC_JOB.PEPIMS, DATA_SYNC.BY_NIGHTLY);
  await runDataSyncJob(DATA_SYNC_JOB.DEV_COPY, DATA_SYNC.BY_NIGHTLY);
  return true;
};

/** Server start (not on the laptop): looks once a minute; does nothing unless this server's database is the target. */
export const startDataSyncTimer = (): void => {
  if (timer) return;
  const w = where();
  if (!w.allowed) {
    log.info(LOG_SOURCE.APP, `[data-sync] nightly run not on this server (database ${w.database}, target ${w.targetDb})`);
    return;
  }
  timer = setInterval(() => {
    runNightlyIfDue().catch((e: unknown) => log.error(LOG_SOURCE.APP, `[data-sync] nightly check failed: ${e instanceof Error ? e.message : String(e)}`));
  }, DATA_SYNC.CHECK_EVERY_MS);
  timer.unref();
  log.info(LOG_SOURCE.APP, `[data-sync] nightly run at ${DATA_SYNC.NIGHTLY_IST.HOUR}:${String(DATA_SYNC.NIGHTLY_IST.MINUTE).padStart(2, '0')} IST (switch in Admin > Data sync)`);
};
