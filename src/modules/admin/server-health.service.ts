import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { APP_STATE_KEY, DISK_CHECK, LOCAL_CLEANUP } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { AppState } from '../../entities';
import { log } from '../../utils/logger';
import { CleanupSummary, runLocalCleanup } from '../email-intake/local-cleanup.service';

/*
 * Admin > Server (2026-11-04, user: "does it fill the server disk?"; developers only). The disk the PO folders live on
 * (EMAIL_STORAGE_DIR): how full it is, checked every hour (a warning in the log at WARN_PCT, an error at ERROR_PCT, so
 * CloudWatch can alert on it), and the local cleanup: switched on or not, its rules, its last run, run it now.
 */

export interface DiskUsage { path: string; totalBytes: number; freeBytes: number; usedPct: number; at: string }

const stateRepo = () => AppDataSource.getRepository(AppState);

/** How full the disk holding EMAIL_STORAGE_DIR is (null when the OS cannot tell). */
export const diskUsage = async (): Promise<DiskUsage | null> => {
  const dir = path.resolve(env.storage.emailDir);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  try {
    const s = await fs.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path: dir, totalBytes: total, freeBytes: free, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : 0, at: new Date().toISOString() };
  } catch {
    return null;
  }
};

/** One check: logged by level, kept in app_state for the page. */
export const checkDisk = async (): Promise<DiskUsage | null> => {
  const d = await diskUsage();
  if (!d) return null;
  const line = `[disk] ${d.usedPct}% used (${(d.freeBytes / 1_073_741_824).toFixed(1)} GB free of ${(d.totalBytes / 1_073_741_824).toFixed(1)} GB) at ${d.path}`;
  if (d.usedPct >= DISK_CHECK.ERROR_PCT) log.error(LOG_SOURCE.APP, `${line}: almost full, free space now (Admin > Server > Run cleanup)`);
  else if (d.usedPct >= DISK_CHECK.WARN_PCT) log.warn(LOG_SOURCE.APP, `${line}: getting full`);
  else log.info(LOG_SOURCE.APP, line);
  await stateRepo().save({ key: APP_STATE_KEY.DISK_LAST, value: { ...d }, updatedAt: new Date() }).catch(() => undefined);
  return d;
};

/** Every DISK_CHECK.EVERY_MS (first one a minute after start). */
export const startDiskCheck = (): { stop: () => void } => {
  const first = setTimeout(() => void checkDisk().catch(() => undefined), 60_000);
  const timer = setInterval(() => void checkDisk().catch(() => undefined), DISK_CHECK.EVERY_MS);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
};

export interface ServerView {
  disk: DiskUsage | null;
  thresholds: { warnPct: number; errorPct: number };
  cleanup: { enabled: boolean; s3: boolean; minAgeHours: number; staleDays: number; everyHours: number; last: CleanupSummary | null };
}

export const serverView = async (): Promise<ServerView> => {
  const last = (await stateRepo().findOneBy({ key: APP_STATE_KEY.LOCAL_CLEANUP_LAST }))?.value as CleanupSummary | undefined;
  return {
    disk: await diskUsage(),
    thresholds: { warnPct: DISK_CHECK.WARN_PCT, errorPct: DISK_CHECK.ERROR_PCT },
    cleanup: {
      enabled: env.storage.cleanupEnabled, s3: env.s3.enabled, minAgeHours: LOCAL_CLEANUP.MIN_AGE_HOURS, staleDays: LOCAL_CLEANUP.STALE_DAYS,
      everyHours: LOCAL_CLEANUP.EVERY_HOURS, last: last ?? null,
    },
  };
};

/** Run the cleanup now (dry run = what it would remove; apply = remove), then the page view. */
export const runCleanupNow = async (apply: boolean): Promise<ServerView & { run: CleanupSummary | null }> => {
  await runLocalCleanup({ apply });
  const view = await serverView();
  return { ...view, run: view.cleanup.last };
};
