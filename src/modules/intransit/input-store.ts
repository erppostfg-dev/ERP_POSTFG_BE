import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import {
  ERROR_CODES,
  HEADER_SCAN_BYTES,
  INPUT_BY_NAME,
  INPUT_CATALOG,
  INPUT_GROUP,
  INTRANSIT_FOLDERS,
  INTRANSIT_SOURCE,
  INTRANSIT_TEMPLATE_NAME,
  IntransitSource,
  isMasterInput,
  PEPIMS_CONNECTOR,
  IST_OFFSET_MS,
} from '../../constants';
import { appError } from '../../utils/AppError';
import { validateInput } from './catalog';

/*
 * Where the report's inputs live (user, 2026-10-19), under INTRANSIT_DIR/inputs:
 *   masters/<name>                         the current master, used by every build
 *   masters/_history/<name>/<time>__<name> the versions it replaced (restorable)
 *   daily/<YYYY-MM-DD>/<name>              that day's daily files (uploaded or fetched)
 * Each file has a <name>.meta.json beside it: who/what wrote it, when, its sha256 and size.
 * A daily file missing for a day: the latest copy of an earlier day is used, marked as such (never a later one).
 * Disk only - no database.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const META_EXT = '.meta.json';

export const inputsRoot = (): string => path.join(path.resolve(env.intransit.dir), INTRANSIT_FOLDERS.INPUTS);
export const mastersDir = (): string => path.join(inputsRoot(), INTRANSIT_FOLDERS.MASTERS);
export const dailyRoot = (): string => path.join(inputsRoot(), INTRANSIT_FOLDERS.DAILY);
export const dailyDir = (date: string): string => path.join(dailyRoot(), date);
export const masterPath = (name: string): string => path.join(mastersDir(), name);
export const masterHistoryDir = (name: string): string => path.join(mastersDir(), INTRANSIT_FOLDERS.HISTORY, name);

/** Today in IST as YYYY-MM-DD. */
export const istToday = (): string => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The IST day of a moment. */
export const istDay = (at: Date | number): string => new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** `date` as a day to work on (default today): YYYY-MM-DD, a real day, not in the future. 400 otherwise. */
export const checkDate = (date?: unknown): string => {
  if (date === undefined || date === null || date === '') return istToday();
  if (typeof date !== 'string' || !DAY_RE.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > istToday()) {
    throw appError(ERROR_CODES.INTRANSIT_DATE_INVALID, String(date));
  }
  return date;
};

/** The day before `date`. */
export const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

// ---- meta ------------------------------------------------------------------------------------------------------

export type InputOrigin = 'upload' | IntransitSource | typeof PEPIMS_CONNECTOR | 'restore' | 'edit' | 'migrated';

export interface InputMeta {
  at: string;
  by: number | null;
  byName: string | null;
  source: InputOrigin;
  sha256: string;
  size: number;
}

export interface Writer {
  by?: number | null;
  byName?: string | null;
  source: InputOrigin;
}

const sha256 = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex');

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

/** The meta beside `file`; without one (an older file), what the file itself tells. Null when the file is absent. */
export const readMeta = async (file: string): Promise<InputMeta | null> => {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return null;
  try {
    const meta = JSON.parse(await fsp.readFile(`${file}${META_EXT}`, 'utf8')) as InputMeta;
    if (meta.size === st.size) return meta;
  } catch {
    // no meta yet
  }
  return { at: st.mtime.toISOString(), by: null, byName: null, source: 'migrated', sha256: '', size: st.size };
};

/** A temporary name beside `file`, unique per write, so two writers never share one. */
const partOf = (file: string): string => `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.part`;

/** The meta written via a .part + rename, so a copy that shares the old meta file is never changed by it. */
const writeMeta = async (file: string, meta: InputMeta): Promise<void> => {
  const part = partOf(`${file}${META_EXT}`);
  await fsp.writeFile(part, JSON.stringify(meta, null, 2), 'utf8');
  await fsp.rename(part, `${file}${META_EXT}`);
};

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const isUnder = (file: string, dir: string): boolean => {
  const rel = path.relative(dir, path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Keep `file` (and its meta) as `to` before it is replaced or removed (user, 2026-10-22: keep everything): the data
 * as a hard link where the disk allows (no extra space; the live name is later replaced by a rename, never written in
 * place), else a copy; the meta always as a copy.
 */
const keepCopy = async (file: string, to: string): Promise<void> => {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.link(file, to);
  } catch {
    await fsp.copyFile(file, to);
  }
  if (fs.existsSync(`${file}${META_EXT}`)) await fsp.copyFile(`${file}${META_EXT}`, `${to}${META_EXT}`);
};

/** The current content's sha256 of `file` (from its meta, else hashed); null when there is no file. */
const currentSha = async (file: string): Promise<{ meta: InputMeta; sha256: string } | null> => {
  const meta = await readMeta(file);
  return meta ? { meta, sha256: meta.sha256 || (await sha256File(file)) } : null;
};

/**
 * Write `raw` as `file` (complete files only take the real name) with its meta. The same content again changes
 * nothing (the existing meta is returned). A daily file being replaced is kept first as
 * daily/<day>/_replaced/<stamp>__<name>; masters are kept by archiveMaster before their callers write.
 */
export const writeWithMeta = async (file: string, raw: Uint8Array, who: Writer): Promise<InputMeta> => {
  const hash = sha256(raw);
  const current = await currentSha(file);
  if (current?.sha256 === hash) return { ...current.meta, sha256: hash };
  if (current && isUnder(file, dailyRoot())) {
    await keepCopy(file, path.join(path.dirname(file), INTRANSIT_FOLDERS.REPLACED, `${stamp()}__${path.basename(file)}`));
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const part = partOf(file);
  await fsp.writeFile(part, raw);
  await fsp.rename(part, file);
  const meta: InputMeta = { at: new Date().toISOString(), by: who.by ?? null, byName: who.byName ?? null, source: who.source, sha256: hash, size: raw.length };
  await writeMeta(file, meta);
  return meta;
};

// ---- masters ---------------------------------------------------------------------------------------------------

const masterLocks = new Map<string, Promise<unknown>>();

/**
 * Run `job` after every earlier change of master `name` in this process (upload, restore, page edit), so two changes
 * never read the same current file and one of them is lost.
 */
export const withMasterLock = <T>(name: string, job: () => Promise<T>): Promise<T> => {
  const next = (masterLocks.get(name) ?? Promise.resolve()).catch(() => undefined).then(job);
  masterLocks.set(name, next);
  void next.finally(() => {
    if (masterLocks.get(name) === next) masterLocks.delete(name);
  }).catch(() => undefined);
  return next;
};

/** Keep the current master in its history folder (nothing when there is none). */
export const archiveMaster = async (name: string): Promise<void> => {
  const file = masterPath(name);
  if (!fs.existsSync(file)) return;
  await keepCopy(file, path.join(masterHistoryDir(name), `${stamp()}__${name}`));
};

export interface MasterVersion {
  version: string;
  at: string;
  size: number;
  byName: string | null;
  source: InputOrigin | null;
}

/** The replaced versions of a master, newest first. */
export const masterVersions = async (name: string): Promise<MasterVersion[]> => {
  const dir = masterHistoryDir(name);
  const files = (await fsp.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(`__${name}`));
  const out: MasterVersion[] = [];
  for (const f of files) {
    const meta = await readMeta(path.join(dir, f));
    if (!meta) continue;
    const fromName = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z__/.exec(f);
    const archived = fromName ? `${fromName[1]}T${fromName[2]}:${fromName[3]}:${fromName[4]}.${fromName[5]}Z` : meta.at;
    out.push({ version: f.slice(0, f.indexOf('__')), at: meta.source === 'migrated' ? archived : meta.at, size: meta.size, byName: meta.byName, source: meta.source === 'migrated' ? null : meta.source });
  }
  return out.sort((a, b) => (a.version < b.version ? 1 : -1));
};

/**
 * Make an older version the current master again, as a new version (the current one is archived first).
 * Unchanged when that version is the current content.
 */
export const restoreMaster = async (name: string, version: string, who: Omit<Writer, 'source'>): Promise<{ meta: InputMeta; unchanged: boolean }> => {
  if (!isMasterInput(name)) throw appError(ERROR_CODES.INTRANSIT_NOT_MASTER, name);
  const from = path.join(masterHistoryDir(name), `${version}__${name}`);
  if (!/^[\w-]+$/.test(version) || !fs.existsSync(from)) throw appError(ERROR_CODES.INTRANSIT_VERSION_NOT_FOUND, name, version);
  return withMasterLock(name, async () => {
    const raw = new Uint8Array(await fsp.readFile(from));
    const current = await currentSha(masterPath(name));
    if (current?.sha256 === sha256(raw)) return { meta: { ...current.meta, sha256: current.sha256 }, unchanged: true };
    await archiveMaster(name);
    return { meta: await writeWithMeta(masterPath(name), raw, { ...who, source: 'restore' }), unchanged: false };
  });
};

// ---- saving an input -------------------------------------------------------------------------------------------

export interface SaveResult {
  name: string;
  path: string;
  meta: InputMeta;
  /** A master uploaded again with the same content: nothing changed. */
  unchanged: boolean;
}

/** Save a checked file as input `name`: a master replaces the current one (archived), a daily file goes to `date`. */
export const storeInput = async (name: string, raw: Uint8Array, date: string, who: Writer): Promise<SaveResult> => {
  const master = isMasterInput(name);
  const file = master ? masterPath(name) : path.join(dailyDir(date), name);
  const save = async (): Promise<SaveResult> => {
    const current = await currentSha(file);
    if (current?.sha256 === sha256(raw)) return { name, path: file, meta: { ...current.meta, sha256: current.sha256 }, unchanged: true };
    if (master) await archiveMaster(name);
    return { name, path: file, meta: await writeWithMeta(file, raw, who), unchanged: false };
  };
  return master ? withMasterLock(name, save) : save();
};

/**
 * Keep an uploaded master file that was imported into the database (user, 2026-10-25: "save the csv for historical
 * purposes") as masters/_imports/<name>/<stamp>__<name>. On disk where the S3 store is off (with it: Masters/Imports/ in S3).
 */
export const keepMasterImport = async (name: string, raw: Uint8Array, who: Writer): Promise<string> => {
  const file = path.join(mastersDir(), '_imports', name, `${stamp()}__${name}`);
  await writeWithMeta(file, raw, who);
  return file;
};

/** Where the page's deletes are kept: INTRANSIT_DIR/_deleted/<path under INTRANSIT_DIR>. */
export const deletedRoot = (): string => path.join(path.resolve(env.intransit.dir), INTRANSIT_FOLDERS.DELETED);

/**
 * Move `target` (a file with its meta, or a folder) under _deleted/, keeping its place under INTRANSIT_DIR and adding a
 * stamp: never removed (user, 2026-10-22: keep everything). Returns where it went.
 */
export const moveToDeleted = async (target: string): Promise<string> => {
  const rel = path.relative(path.resolve(env.intransit.dir), path.resolve(target));
  const to = path.join(deletedRoot(), path.dirname(rel), `${stamp()}__${path.basename(rel)}`);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(target, to);
  if (fs.existsSync(`${target}${META_EXT}`)) await fsp.rename(`${target}${META_EXT}`, `${to}${META_EXT}`);
  return to;
};

/**
 * Remove a daily file of `date` (the day then falls back to an earlier copy); the file is kept under _deleted/.
 * Returns [where it was, where it went].
 */
export const deleteDaily = async (name: string, date: string): Promise<[string, string]> => {
  if (isMasterInput(name)) throw appError(ERROR_CODES.INTRANSIT_NOT_DAILY, name);
  const file = path.join(dailyDir(date), name);
  if (!fs.existsSync(file)) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
  return [file, await moveToDeleted(file)];
};

// ---- resolving a day's inputs ----------------------------------------------------------------------------------

/** The days with a daily folder, newest first. */
export const listDailyDates = async (): Promise<string[]> =>
  (await fsp.readdir(dailyRoot()).catch(() => [] as string[])).filter((d) => DAY_RE.test(d)).sort().reverse();

export interface ResolvedInput {
  name: string;
  path: string;
  /** master | the day itself | the latest earlier day that has it */
  from: 'master' | 'date' | 'earlier';
  /** The day the daily file is of. */
  date?: string;
}

/** Where each input of `date` comes from; `missing` = no copy at all (on that day or before). */
export const resolveInputs = async (date: string): Promise<{ files: ResolvedInput[]; missing: string[] }> => {
  const days = (await listDailyDates()).filter((d) => d <= date);
  const files: ResolvedInput[] = [];
  const missing: string[] = [];
  for (const f of INPUT_CATALOG) {
    if (isMasterInput(f.name)) {
      const p = masterPath(f.name);
      if (fs.existsSync(p)) files.push({ name: f.name, path: p, from: 'master' });
      else missing.push(f.name);
      continue;
    }
    const day = days.find((d) => fs.existsSync(path.join(dailyDir(d), f.name)));
    if (day) files.push({ name: f.name, path: path.join(dailyDir(day), f.name), from: day === date ? 'date' : 'earlier', date: day });
    else missing.push(f.name);
  }
  return { files, missing };
};

/** The file a viewer opens for input `name`: the master, or the daily file used for `date` (default today). */
export const inputPathFor = async (name: string, date?: string): Promise<string | null> => {
  if (!INPUT_BY_NAME.has(name)) return null;
  const { files } = await resolveInputs(date ?? istToday());
  return files.find((f) => f.name === name)?.path ?? null;
};

// ---- file checks (cached per file version) ---------------------------------------------------------------------

const checkCache = new Map<string, { key: string; problems: string[] }>();

/** The column check of a stored file (as at upload), cached until the file changes. */
export const problemsOf = async (name: string, file: string): Promise<string[]> => {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return [];
  if (!st.size) return ['the file is empty'];
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = checkCache.get(file);
  if (hit?.key === key) return hit.problems;
  let raw: Uint8Array;
  if (name === INTRANSIT_TEMPLATE_NAME) raw = new Uint8Array(await fsp.readFile(file));
  else {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(HEADER_SCAN_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEADER_SCAN_BYTES, 0);
      raw = new Uint8Array(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  }
  const problems = validateInput(name, raw);
  checkCache.set(file, { key, problems });
  return problems;
};

// ---- the day's plan --------------------------------------------------------------------------------------------

export interface MasterItem {
  name: string;
  source: string;
  refresh: 'daily' | 'on-change';
  present: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  via: InputOrigin | null;
  size: number | null;
  sha256: string | null;
  /** A daily-refreshed master last updated before the day. */
  stale: boolean;
  versions: number;
  problems: string[];
}

export interface DailyItem {
  name: string;
  /** upload = from a portal by hand; api = fetched by a connector */
  group: 'upload' | 'api';
  source: string;
  /** 'pepims' = read from PEPIMS at the build (Shipment_Status, PO_Format). */
  connector: IntransitSource | typeof PEPIMS_CONNECTOR | null;
  /** Can a connector fetch it for this day (PEPIMS: will the build read it)? */
  fetchable: boolean;
  /** Why not, when it has a connector. */
  notFetchable: string | null;
  on: 'date' | 'earlier' | 'missing';
  /** The day of the copy used. */
  fileDate: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  via: InputOrigin | null;
  size: number | null;
  problems: string[];
  /** Waiting in this server's queue for S3 (S3 store only). */
  queued: boolean;
}

export interface FetchStep {
  source: IntransitSource;
  /** The connector's option per file (soh, b2b ...). */
  only: string[];
  files: string[];
}

export interface DayPlan {
  date: string;
  today: string;
  dates: string[];
  masters: { ok: number; total: number; items: MasterItem[] };
  daily: { ok: number; total: number; items: DailyItem[] };
  /** Per connector: is it set up, and which files it can fetch for the day. */
  sources: { source: IntransitSource; configured: boolean; missingKeys: string[]; files: string[]; fetchable: string[] }[];
  build: {
    /** Can be built now (with fetch-first when toFetch is not empty). */
    ready: boolean;
    uses: { masters: number; ofDate: number; earlier: { name: string; date: string }[] };
    /** API files not of the day that a fetch-first build fetches. */
    toFetch: FetchStep[];
    /** Files with no copy at all that only a fetch can bring (a build without fetch-first is refused). */
    fetchRequired: string[];
    /** What stops any build: a missing master, a daily file with no copy that cannot be fetched, a file with problems. */
    blockers: string[];
    warnings: string[];
    /** The day's files saved far apart (also in warnings). */
    spread: string[];
  };
}

const longDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** One input as the day uses it, with what the page shows about it. */
export interface DayInput {
  name: string;
  from: 'master' | 'date' | 'earlier';
  date?: string;
  meta: InputMeta | null;
  problems: string[];
  /** Waiting in this server's queue for S3 (S3 store only). */
  queued?: boolean;
}

/** Where the Daily run page's inputs come from: the disk (as before) or S3 (s3/inputs.ts). */
export interface InputSource {
  resolve(date: string): Promise<{ files: DayInput[]; missing: string[] }>;
  /** A master's earlier versions (count). */
  versions(name: string): Promise<number>;
  /** The days with daily files, newest first. */
  dates(): Promise<string[]>;
}

/** The disk store (INTRANSIT_DIR/inputs). */
export const diskSource: InputSource = {
  async resolve(date) {
    const { files, missing } = await resolveInputs(date);
    const out: DayInput[] = [];
    for (const f of files) out.push({ name: f.name, from: f.from, date: f.date, meta: await readMeta(f.path), problems: await problemsOf(f.name, f.path) });
    return { files: out, missing };
  },
  versions: async (name) => (await masterVersions(name).catch(() => [])).length,
  dates: listDailyDates,
};

/** Everything the Daily run page shows for `date`. `missingKeys(source)` = the .env keys a connector still needs. */
export const planDay = async (date: string, missingKeys: (s: IntransitSource) => string[], source: InputSource = diskSource): Promise<DayPlan> => {
  const today = istToday();
  const { files } = await source.resolve(date);
  const byName = new Map(files.map((f) => [f.name, f]));
  const keys = Object.fromEntries((Object.values(INTRANSIT_SOURCE) as IntransitSource[]).map((s) => [s, missingKeys(s)])) as Record<IntransitSource, string[]>;

  const masters: MasterItem[] = [];
  const daily: DailyItem[] = [];
  for (const spec of INPUT_CATALOG) {
    const r = byName.get(spec.name);
    const meta = r?.meta ?? null;
    const problems = r?.problems ?? [];
    const who = { updatedAt: meta?.at ?? null, updatedBy: meta?.byName ?? null, via: meta?.source ?? null, size: meta?.size ?? null };
    if (spec.group === INPUT_GROUP.MASTER) {
      const refresh = spec.refresh ?? 'on-change';
      masters.push({
        name: spec.name, source: spec.source, refresh, present: !!r, ...who, sha256: meta?.sha256 || null,
        stale: !!meta && refresh === 'daily' && istDay(Date.parse(meta.at)) < date,
        versions: await source.versions(spec.name), problems,
      });
      continue;
    }
    const connector = spec.connector ?? null;
    let notFetchable: string | null = null;
    if (connector === PEPIMS_CONNECTOR) {
      if (env.intransit.poSource !== 'pepims') notFetchable = 'reading from PEPIMS is off (INTRANSIT_PO_SOURCE in .env): upload it';
      else if (date !== today) notFetchable = 'PEPIMS holds the current statuses only: read when building today';
    } else if (connector && keys[connector].length) notFetchable = `${connector} is not set up (${keys[connector].join(', ')} in .env)`;
    else if (connector && spec.fetchable === 'today-only' && date !== today) notFetchable = 'the API gives the current state only: fetchable for today';
    daily.push({
      name: spec.name, group: spec.group === INPUT_GROUP.DAILY_FETCH ? 'api' : 'upload', source: spec.source, connector,
      fetchable: !!connector && !notFetchable, notFetchable: connector ? notFetchable : null,
      on: r ? (r.from === 'date' ? 'date' : 'earlier') : 'missing', fileDate: r?.date ?? null, ...who, problems, queued: !!r?.queued,
    });
  }

  // PEPIMS files are read by the build itself (every build for today), not by a fetch step
  const toFetchFiles = daily.filter((d) => d.on !== 'date' && d.fetchable && d.connector !== PEPIMS_CONNECTOR);
  const toFetch: FetchStep[] = [];
  for (const d of toFetchFiles) {
    const src = d.connector as IntransitSource;
    let step = toFetch.find((s) => s.source === src);
    if (!step) toFetch.push((step = { source: src, only: [], files: [] }));
    step.files.push(d.name);
    step.only.push(INPUT_BY_NAME.get(d.name)?.fetchKey ?? '');
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const m of masters) {
    if (!m.present) blockers.push(`${m.name}: upload it (Masters)`);
    else if (m.problems.length) blockers.push(`${m.name}: ${m.problems.join('; ')}`);
    else if (m.stale) warnings.push(`${m.name} last updated ${longDay(istDay(Date.parse(m.updatedAt as string)))} (expected daily)`);
  }
  const fetchRequired: string[] = [];
  for (const d of daily) {
    if (d.connector === PEPIMS_CONNECTOR && d.fetchable) continue; // read fresh from PEPIMS at the build
    // an optional file never holds a build up: without a copy its sheet says so and the build warns
    if (INPUT_BY_NAME.get(d.name)?.optional) {
      if (d.on === 'missing') warnings.push(`${d.name}: no copy yet (optional: the build goes on without it)`);
      continue;
    }
    if (d.on === 'missing') {
      if (d.fetchable) fetchRequired.push(d.name);
      else blockers.push(`${d.name}: ${d.group === 'api' && d.notFetchable ? `${d.notFetchable}; ` : ''}upload it for ${longDay(date)}`);
    } else if (d.problems.length && !(d.fetchable && d.on === 'earlier')) blockers.push(`${d.name}: ${d.problems.join('; ')}`);
    else if (d.on === 'earlier' && !d.fetchable) warnings.push(`${d.name}: using the ${longDay(d.fileDate as string)} copy${d.notFetchable ? ` (${d.notFetchable})` : ''}`);
  }

  // The day's own files (and the daily masters) saved far apart: a report mixing them compares shipments of one
  // moment with GRNs or stock of another (fix plan W5). INTRANSIT_INPUT_SPREAD_WARN_HOURS; a warning only.
  const sameSession = [
    ...daily.filter((d) => d.on === 'date' && d.updatedAt),
    ...masters.filter((m) => m.refresh === 'daily' && m.updatedAt && istDay(Date.parse(m.updatedAt)) === date),
  ].map((f) => ({ name: f.name, at: Date.parse(f.updatedAt as string) }));
  const spread: string[] = [];
  if (sameSession.length > 1) {
    const newest = Math.max(...sameSession.map((f) => f.at));
    for (const f of sameSession.filter((x) => newest - x.at > env.intransit.inputSpreadWarnHours * 3600000).sort((a, b) => a.at - b.at)) {
      spread.push(`${f.name} was saved ${Math.round((newest - f.at) / 3600000)} h before the newest file of the day`);
    }
  }

  const sources = (Object.values(INTRANSIT_SOURCE) as IntransitSource[]).map((source) => {
    const own = INPUT_CATALOG.filter((f) => f.connector === source);
    return {
      source,
      configured: !keys[source].length,
      missingKeys: keys[source],
      files: own.map((f) => f.name),
      fetchable: keys[source].length ? [] : own.filter((f) => f.fetchable === 'any-date' || date === today).map((f) => f.name),
    };
  });

  const ok = (problems: string[], present: boolean): boolean => present && !problems.length;
  return {
    date,
    today,
    dates: await source.dates(),
    masters: { ok: masters.filter((m) => ok(m.problems, m.present) && !m.stale).length, total: masters.length, items: masters },
    daily: { ok: daily.filter((d) => d.on === 'date' && !d.problems.length).length, total: daily.length, items: daily },
    sources,
    build: {
      ready: !blockers.length,
      uses: {
        masters: masters.filter((m) => m.present).length,
        ofDate: daily.filter((d) => d.on === 'date').length,
        earlier: daily.filter((d) => d.on === 'earlier').map((d) => ({ name: d.name, date: d.fileDate as string })),
      },
      toFetch,
      fetchRequired,
      blockers,
      warnings: [...warnings, ...spread],
      spread,
    },
  };
};

// ---- one-time move from the flat inputs folder ------------------------------------------------------------------

/**
 * Before 2026-10-19 every input sat in inputs/ itself, and master edits were backed up in inputs/_history/<file>/.
 * Moves masters to inputs/masters/ (with their history) and daily files to inputs/daily/<their IST day>/. Files
 * already moved are left alone, so it can run at every start. Returns what was moved.
 */
export const migrateFlatInputs = async (): Promise<string[]> => {
  const root = inputsRoot();
  const moved: string[] = [];
  for (const f of INPUT_CATALOG) {
    const flat = path.join(root, f.name);
    const st = await fsp.stat(flat).catch(() => null);
    if (!st?.isFile()) continue;
    const master = isMasterInput(f.name);
    const to = master ? masterPath(f.name) : path.join(dailyDir(istDay(st.mtime)), f.name);
    if (fs.existsSync(to)) continue; // a newer one is already in place: keep the flat file for a person to look at
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(flat, to);
    await writeMeta(to, { at: st.mtime.toISOString(), by: null, byName: null, source: 'migrated', sha256: await sha256File(to), size: st.size });
    moved.push(path.relative(root, to));
  }
  const oldHistory = path.join(root, INTRANSIT_FOLDERS.HISTORY);
  for (const name of await fsp.readdir(oldHistory).catch(() => [] as string[])) {
    const from = path.join(oldHistory, name);
    const to = masterHistoryDir(name);
    await fsp.mkdir(to, { recursive: true });
    for (const v of await fsp.readdir(from)) if (!fs.existsSync(path.join(to, v))) await fsp.rename(path.join(from, v), path.join(to, v));
    if (!(await fsp.readdir(from)).length) await fsp.rmdir(from);
    moved.push(`${INTRANSIT_FOLDERS.HISTORY}/${name}`);
  }
  if (fs.existsSync(oldHistory) && !(await fsp.readdir(oldHistory)).length) await fsp.rmdir(oldHistory);
  // Inputs that stopped being masters (Shipment_Status / PO_Format became daily files read from PEPIMS, 2026-10-23):
  // the copy in masters/ moves to daily/<the IST day it was saved>/ (its earlier versions stay in masters/_history/).
  for (const f of INPUT_CATALOG.filter((x) => !isMasterInput(x.name))) {
    const from = masterPath(f.name);
    const meta = fs.existsSync(from) ? await readMeta(from) : null;
    if (!meta) continue;
    const to = path.join(dailyDir(istDay(Date.parse(meta.at))), f.name);
    if (fs.existsSync(to)) continue; // the day already has its own copy: keep the master copy for a person to look at
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    if (fs.existsSync(`${from}${META_EXT}`)) await fsp.rename(`${from}${META_EXT}`, `${to}${META_EXT}`);
    moved.push(path.relative(root, to));
  }
  return moved;
};
