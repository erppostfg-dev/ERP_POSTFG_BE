import { randomBytes } from 'crypto';
import { INTRANSIT_TEMPLATE_NAME } from '../../../constants';
import { rootOf, Scope } from './scope';

/*
 * Where every in-transit file lives in S3 (user, 2026-10-26). <R> = inventory/ (live) or inventory-test/ (test):
 *   <R>GRN_SOH/<FY>/<Month>/<day>/<name>/<stamp>__<name>          the six marketplace GRN/SOH files        30 days
 *   <R>Daily Inputs/<FY>/<Month>/<day>/<name>/<stamp>__<name>     the other daily inputs                   30 days
 *   <R>.../<day>/<name>/<stamp>__DELETED.json                     a delete (the older copy of the day is used)
 *   <R>.../<day>/_refused/run<id>__<name>                         what a connector brought that failed the check
 *   <R>Full Report/<FY>/<Month>/<day>/<HH-MM-SS>_run<id>/...      a build: workbook, run.json, masters, sheets  90 days
 *   <R>Daily Snapshot/<FY>/<Month>/<day>/<HH-MM-SS>_run<id>/...   the 3 important sheets of each build      90 days
 *   <R>Daily Snapshot/<FY>/<Month>/<day>/_build.json              which build of the day is final
 *   <R>Weekly Snapshot/<FY>/W43.xlsx, <R>Monthly Snapshot/<FY>/October.xlsx      the period's final workbook  forever
 *   <R>Masters/Template/<stamp>__Intransit_Stock_Report.xlsx                     template versions          forever
 *   <R>Masters/Imports/<master>/<FY>/<Month>/<stamp>__u<by>__<file>              uploaded master files      forever
 *   <R>Masters/Legacy/...                                                        the old disk masters (moved once)
 * <day> is the report's day (IST); <FY> runs April-March (FY26-27); <stamp> is UTC and sorts by time; build folders
 * are named by the build's start time in IST. Days and times are India time throughout.
 */

export const FOLDER = {
  GRN_SOH: 'GRN_SOH',
  DAILY_INPUTS: 'Daily Inputs',
  FULL_REPORT: 'Full Report',
  DAILY_SNAPSHOT: 'Daily Snapshot',
  WEEKLY: 'Weekly Snapshot',
  MONTHLY: 'Monthly Snapshot',
  TEMPLATE: 'Masters/Template',
  IMPORTS: 'Masters/Imports',
  LEGACY: 'Masters/Legacy',
} as const;

export const REFUSED_FOLDER = '_refused';
export const TOMBSTONE = 'DELETED.json';
export const BUILD_JSON = '_build.json';
/** Daily inputs kept (and read) for this many days (lifecycle rule; older stamps are ignored in code too). */
export const INPUT_DAYS = 30;

/** The Daily Snapshot's sheets (user, 2026-10-26), as plain CSVs. */
export const SNAPSHOT_SHEETS = ['Sheet35(2)', 'Final Sheet35(2)', 'Full_Shipment_Enhanced'] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The six marketplace GRN/SOH files go to GRN_SOH/, the other daily inputs to Daily Inputs/. */
export const GRN_SOH_FILES: ReadonlySet<string> = new Set(['FK_GRN.csv', 'FK_SOH.csv', 'Myntra_GRN.csv', 'Myntra_SOH.csv', 'Amazon_GRN.csv', 'Amazon_SOH.csv']);
export const inputFolderOf = (name: string): string => (GRN_SOH_FILES.has(name) ? FOLDER.GRN_SOH : FOLDER.DAILY_INPUTS);

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (day: string): [number, number, number] => day.split('-').map(Number) as [number, number, number];

/** FY of a day: FY26-27 for 2026-04-01 .. 2027-03-31. */
export const fyOf = (day: string): string => {
  const [y, m] = ymd(day);
  const start = m >= 4 ? y : y - 1;
  return `FY${pad(start % 100)}-${pad((start + 1) % 100)}`;
};

export const monthOf = (day: string): string => MONTHS[ymd(day)[1] - 1];

/** The FY/Month/day path of a day. */
const dayPath = (day: string): string => `${fyOf(day)}/${monthOf(day)}/${day}`;

/**
 * The ISO week of a day: its number, the Thursday of that week, and the FY that week belongs to - the FY of its
 * Thursday, i.e. the FY that holds 4 or more of its days (user, 2026-10-26), so a week number never repeats in an FY.
 */
export const isoWeekOf = (day: string): { week: number; thursday: string; fy: string; monday: string; sunday: string } => {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday 0 .. Sunday 6
  const thu = t + (3 - dow) * DAY_MS;
  const thuDate = new Date(thu);
  const jan1 = Date.UTC(thuDate.getUTCFullYear(), 0, 1);
  const week = Math.floor((thu - jan1) / DAY_MS / 7) + 1;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const thursday = iso(thu);
  return { week, thursday, fy: fyOf(thursday), monday: iso(t - dow * DAY_MS), sunday: iso(t + (6 - dow) * DAY_MS) };
};

let lastStampMs = 0;

/**
 * A time-sorted stamp: 2026-10-26T04-51-03-123Z-ab12 (UTC, 4 random characters so two machines never collide). On one
 * machine stamps of "now" always increase (two saves in the same millisecond still sort in order).
 */
export const newStamp = (at?: Date): string => {
  let ms = (at ?? new Date()).getTime();
  if (!at) {
    if (ms <= lastStampMs) ms = lastStampMs + 1;
    lastStampMs = ms;
  }
  return `${new Date(ms).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('base64url').slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
};

/** The time of a stamp (null when it is not one). */
export const stampTime = (stamp: string): Date | null => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(stamp);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
};

/** HH-MM-SS of a moment in IST (a build folder's name). */
export const istClock = (at: Date): string => new Date(at.getTime() + IST_MS).toISOString().slice(11, 19).replace(/:/g, '-');

/** The IST day of a moment. */
export const istDayOf = (at: Date): string => new Date(at.getTime() + IST_MS).toISOString().slice(0, 10);

/** The last path part of a key. */
export const baseName = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

// ---- daily inputs ----------------------------------------------------------------------------------------------

/** The folder of a day's versions of input `name`: <R><group>/<FY>/<Month>/<day>/<name>/ */
export const inputDir = (scope: Scope, name: string, day: string): string => `${rootOf(scope)}${inputFolderOf(name)}/${dayPath(day)}/${name}/`;

export const inputKey = (scope: Scope, name: string, day: string, stamp: string): string => `${inputDir(scope, name, day)}${stamp}__${name}`;

export const tombstoneKey = (scope: Scope, name: string, day: string, stamp: string): string => `${inputDir(scope, name, day)}${stamp}__${TOMBSTONE}`;

export const refusedKey = (scope: Scope, name: string, day: string, runId: string): string =>
  `${rootOf(scope)}${inputFolderOf(name)}/${dayPath(day)}/${REFUSED_FOLDER}/run${runId}__${name}`;

/** The month folders of an input group (for listing a stretch of days). */
export const monthPrefix = (scope: Scope, folder: string, day: string): string => `${rootOf(scope)}${folder}/${fyOf(day)}/${monthOf(day)}/`;

export interface InputEntry {
  key: string;
  scope: Scope;
  name: string;
  day: string;
  stamp: string;
  at: Date;
  deleted: boolean;
}

/** A listed key read back as a day's input version (null for anything else, like _refused/). */
export const parseInputKey = (key: string, scope: Scope): InputEntry | null => {
  const rest = key.slice(rootOf(scope).length);
  const m = /^(?:GRN_SOH|Daily Inputs)\/FY\d{2}-\d{2}\/[A-Za-z]+\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/([^/]+?)__([^/]+)$/.exec(rest);
  if (!m) return null;
  const [, day, name, stamp, file] = m;
  const at = stampTime(stamp);
  if (!at || (file !== name && file !== TOMBSTONE)) return null;
  return { key, scope, name, day, stamp, at, deleted: file === TOMBSTONE };
};

// ---- builds ----------------------------------------------------------------------------------------------------

/** A build's folder name: <HH-MM-SS IST of its start>_run<id>. */
export const buildFolderName = (startedAt: Date, runId: string): string => `${istClock(startedAt)}_run${runId}`;

export const fullReportDir = (scope: Scope, day: string, folder: string): string => `${rootOf(scope)}${FOLDER.FULL_REPORT}/${dayPath(day)}/${folder}/`;

export const snapshotDayDir = (scope: Scope, day: string): string => `${rootOf(scope)}${FOLDER.DAILY_SNAPSHOT}/${dayPath(day)}/`;

export const snapshotDir = (scope: Scope, day: string, folder: string): string => `${snapshotDayDir(scope, day)}${folder}/`;

export const buildJsonKey = (scope: Scope, day: string): string => `${snapshotDayDir(scope, day)}${BUILD_JSON}`;

/** A build's folder from a key inside it: { day, folder, runId }. */
export const parseBuildKey = (key: string): { day: string; folder: string; runId: string } | null => {
  const m = /\/(?:Full Report|Daily Snapshot)\/FY\d{2}-\d{2}\/[A-Za-z]+\/(\d{4}-\d{2}-\d{2})\/((\d{2}-\d{2}-\d{2})_run(\d+))\//.exec(key);
  return m ? { day: m[1], folder: m[2], runId: m[4] } : null;
};

// ---- periods ---------------------------------------------------------------------------------------------------

/** The FY's start year (2026 for FY26-27). */
export const fyStartYear = (fy: string): number => 2000 + Number(fy.slice(2, 4));

/** The ISO week number of an FY's first week (the week whose Thursday is 1-7 April): 13 or 14. */
export const fyFirstWeek = (startYear: number): number => {
  const apr1 = Date.parse(`${startYear}-04-01T00:00:00Z`);
  const firstThu = apr1 + ((4 - new Date(apr1).getUTCDay() + 7) % 7) * DAY_MS;
  return isoWeekOf(new Date(firstThu).toISOString().slice(0, 10)).week;
};

/**
 * The weekly copy of the week holding `day`: <R>Weekly Snapshot/<FY>/W43.xlsx. Rarely an FY starts and ends on the
 * same week number (FY27-28: W13 of 2027 and W13 of 2028); its last week is then W13_2028.xlsx so names never repeat.
 */
export const weeklyKey = (scope: Scope, day: string): { key: string; label: string; fy: string } => {
  const w = isoWeekOf(day);
  const start = fyStartYear(w.fy);
  const year = Number(w.thursday.slice(0, 4));
  const label = year > start && w.week >= fyFirstWeek(start) ? `W${pad(w.week)}_${year}` : `W${pad(w.week)}`;
  return { key: `${rootOf(scope)}${FOLDER.WEEKLY}/${w.fy}/${label}.xlsx`, label, fy: w.fy };
};

/** The monthly copy of the month holding `day`: <R>Monthly Snapshot/<FY>/October.xlsx */
export const monthlyKey = (scope: Scope, day: string): { key: string; label: string; fy: string } => {
  const label = monthOf(day);
  return { key: `${rootOf(scope)}${FOLDER.MONTHLY}/${fyOf(day)}/${label}.xlsx`, label, fy: fyOf(day) };
};

// ---- masters ---------------------------------------------------------------------------------------------------

export const templateDir = (scope: Scope): string => `${rootOf(scope)}${FOLDER.TEMPLATE}/`;

export const templateKey = (scope: Scope, stamp: string): string => `${templateDir(scope)}${stamp}__${INTRANSIT_TEMPLATE_NAME}`;

/** A file name safe for a key: letters, digits, space, . _ - ( ) only. */
export const safeName = (name: string): string => name.replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 150) || 'file';

/** An uploaded master file: <R>Masters/Imports/<master>/<FY>/<Month>/<stamp>__u<by-id>__<file> (the name only in metadata). */
export const importKey = (scope: Scope, master: string, byId: number | null, file: string, at: Date = new Date()): string => {
  const day = istDayOf(at);
  return `${rootOf(scope)}${FOLDER.IMPORTS}/${safeName(master.replace(/\.csv$/i, ''))}/${fyOf(day)}/${monthOf(day)}/${newStamp(at)}__u${byId ?? 0}__${safeName(file)}`;
};

export const legacyPrefix = (scope: Scope): string => `${rootOf(scope)}${FOLDER.LEGACY}/`;
