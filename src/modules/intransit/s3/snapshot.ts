import { ERROR_CODES } from '../../../constants';
import { appError } from '../../../utils/AppError';
import { istToday } from '../input-store';
import { BUILD_JSON, FOLDER, monthPrefix, SNAPSHOT_SHEETS } from './layout';
import { BuildJson, buildJsonFor } from './run-store';
import { isVisibleKey, rootOf, visibleScopes } from './scope';
import { head, list, open, Opened } from './store';

/*
 * Inventory Calculation's data (user, 2026-10-26): the Daily Snapshot of the newest day <= the asked day that has a
 * final build (_build.json), read straight from S3; the page shows a banner when that is not the asked day. The browser
 * keeps the CSVs (by ETag), so a second visit reads nothing again.
 */

const DAY_MS = 86_400_000;
const LOOK_BACK_DAYS = 90;
const LIST_TTL_MS = 30_000;

let days: { at: number; list: string[] } | null = null;

/** The days with a _build.json in the visible scopes (last LOOK_BACK_DAYS days), newest first. */
const snapshotDays = async (): Promise<string[]> => {
  if (days && Date.now() - days.at < LIST_TTL_MS) return days.list;
  const months: string[] = [];
  const today = istToday();
  for (let t = Date.parse(`${today}T00:00:00Z`) - LOOK_BACK_DAYS * DAY_MS; t <= Date.parse(`${today}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!months.some((m) => m.slice(0, 7) === d.slice(0, 7))) months.push(d);
  }
  const found = new Set<string>();
  for (const scope of visibleScopes()) {
    for (const d of months) {
      for (const o of await list(monthPrefix(scope, FOLDER.DAILY_SNAPSHOT, d))) {
        const m = /\/(\d{4}-\d{2}-\d{2})\/_build\.json$/.exec(o.key);
        if (m) found.add(m[1]);
      }
    }
  }
  const out = [...found].sort().reverse();
  days = { at: Date.now(), list: out };
  return out;
};

/** Forget the cached day list (after a build or a delete on this machine). */
export const forgetSnapshotDays = (): void => {
  days = null;
};

export interface SnapshotView {
  requested: string;
  /** The build shown (null: none in the last 90 days). */
  shown: { day: string; runId: string; builtAt: string } | null;
  /** The asked day has no final build: the page says so on top. */
  latestMissing: boolean;
  files: { name: string; key: string; etag: string; size: number }[];
}

/** The snapshot to show for `day`. */
export const snapshotFor = async (day: string): Promise<SnapshotView> => {
  let build: BuildJson | null = null;
  for (const d of (await snapshotDays()).filter((x) => x <= day)) {
    build = await buildJsonFor(d);
    if (build) break;
  }
  if (!build) return { requested: day, shown: null, latestMissing: true, files: [] };
  const files: SnapshotView['files'] = [];
  for (const name of SNAPSHOT_SHEETS) {
    const key = build.files[name];
    const h = key ? await head(key) : null;
    if (h) files.push({ name, key, etag: h.etag, size: h.size });
  }
  return { requested: day, shown: { day: build.day, runId: build.runId, builtAt: build.builtAt }, latestMissing: build.day !== day, files };
};

/** A Daily Snapshot / Full Report file to send (null: 304 or gone). Only the in-transit store's own keys. */
export const openSnapshotFile = async (key: string, ifNoneMatch?: string): Promise<Opened | 'not-modified'> => {
  const allowed = isVisibleKey(key) && visibleScopes().some((s) => [FOLDER.DAILY_SNAPSHOT, FOLDER.FULL_REPORT].some((f) => key.startsWith(`${rootOf(s)}${f}/`)));
  if (!allowed || key.endsWith(BUILD_JSON) || key.includes('..')) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, key);
  const o = await open(key, { ifNoneMatch });
  if (!o) throw appError(ERROR_CODES.INTRANSIT_REPORT_EXPIRED, key);
  return o;
};
