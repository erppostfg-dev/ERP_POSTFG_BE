import { env } from '../../config/env';
import { ERROR_CODES, PEPIMS_SYNC_RUN_KEY, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { AppDataSource } from '../../config/data-source';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { runPepimsSync } from './import.service';

/*
 * The PEPIMS sync on the server (2026-11-16, user: "do a sync option too"): every PEPIMS_SYNC_MINUTES (0 / unset = no
 * timer; always 0 on the laptop) and the "Sync from PEPIMS" button (admin / developer, PO Overview). One run at a time
 * per server; the last run's result is kept in app_state (PEPIMS_SYNC_RUN_KEY) so every screen sees it.
 */

export interface PepimsSyncRun {
  startedAt: string | null;
  finishedAt: string | null;
  by: string | null;
  ok: boolean | null;
  error: string | null;
  summary: { read: number; inserted: number; linked: number; updated: number; unchanged: number; conflicts: number; logsAdded: number } | null;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

const readRun = async (): Promise<PepimsSyncRun> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [PEPIMS_SYNC_RUN_KEY]);
  const v = (row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {}) as Partial<PepimsSyncRun>;
  return { startedAt: v.startedAt ?? null, finishedAt: v.finishedAt ?? null, by: v.by ?? null, ok: v.ok ?? null, error: v.error ?? null, summary: v.summary ?? null };
};
const saveRun = (r: PepimsSyncRun) => AppDataSource.query(
  `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
  [PEPIMS_SYNC_RUN_KEY, JSON.stringify(r), new Date()],
);

/** One sync run (PEPIMS -> POST_FG, written). Never throws: the result goes into the last-run record and the log. */
export const runPepimsSyncOnce = async (by: string): Promise<void> => {
  if (running) return;
  running = true;
  const run: PepimsSyncRun = { startedAt: new Date().toISOString(), finishedAt: null, by, ok: null, error: null, summary: null };
  try {
    await saveRun(run);
    const r = await runPepimsSync({ apply: true });
    run.ok = true;
    run.summary = { read: r.read, inserted: r.inserted, linked: r.linked, updated: r.updated, unchanged: r.unchanged, conflicts: r.conflictsKeptOurs.length, logsAdded: r.logsAdded };
    log.info(LOG_SOURCE.APP, `[pepims-sync] done by ${by}: read ${r.read}, new ${r.inserted}, linked ${r.linked}, updated ${r.updated}, conflicts kept ours ${r.conflictsKeptOurs.length}`);
  } catch (e) {
    run.ok = false;
    run.error = e instanceof Error ? e.message : String(e);
    log.error(LOG_SOURCE.APP, `[pepims-sync] failed (by ${by}): ${run.error}`, { fix: 'check the DB login can read the PEPIMS database (PEPIMS_SYNC_SOURCE_DB) and that migration PepimsMigration ran' });
  } finally {
    run.finishedAt = new Date().toISOString();
    running = false;
    await saveRun(run).catch(() => undefined);
  }
};

export const pepimsSyncStatus = async () => ({ ...(await readRun()), running, everyMinutes: env.pepimsSync.minutes, timerOn: timer !== null });

/** POST: start a run now (409 while one runs). */
export const startPepimsSync = async (by: string) => {
  if (running) throw appError(ERROR_CODES.PEPIMS_SYNC_RUNNING);
  void runPepimsSyncOnce(by);
  return { state: 'started' as const, ...(await pepimsSyncStatus()) };
};

/** The timer (server start): nothing when PEPIMS_SYNC_MINUTES is 0 / unset. */
export const startPepimsSyncTimer = (): void => {
  const minutes = env.pepimsSync.minutes;
  if (!minutes || timer) return;
  timer = setInterval(() => void runPepimsSyncOnce('timer'), minutes * 60_000);
  timer.unref();
  log.info(LOG_SOURCE.APP, `[pepims-sync] timer on: every ${minutes} min`);
};

