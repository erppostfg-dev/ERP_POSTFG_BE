import fsp from 'fs/promises';
import path from 'path';
import { ERROR_CODES, INPUT_CATALOG, INTRANSIT_TEMPLATE_NAME, isMasterInput } from '../../../constants';
import { appError } from '../../../utils/AppError';
import { DayInput, InputMeta, InputOrigin, InputSource, istToday, MasterVersion } from '../input-store';
import { DB_MASTER_FILES } from '../masters-export';
import {
  baseName, FOLDER, INPUT_DAYS, InputEntry, inputKey, monthPrefix, newStamp, parseInputKey, stampTime, templateDir, templateKey, tombstoneKey,
} from './layout';
import { dataOf, queuedItems } from './queue';
import { rootOf, Scope, scopeOfKey, visibleScopes, writeScope } from './scope';
import { copy, digest, getToFile, head, isUnreachable, list, ObjMeta, onWrite, put, PutResult, putJson } from './store';

/*
 * The day's inputs straight from S3 listings (user, 2026-10-26: nothing about files in the database):
 *   - a daily file: the newest version of the day, else of the latest earlier day that has one (never a later day); a
 *     day whose newest version is a delete (tombstone) is skipped. A test machine's own copy of a day wins there.
 *   - versions older than INPUT_DAYS days are gone (lifecycle rule) and ignored here too: such a file is "missing".
 *   - files waiting in this server's queue count (marked queued).
 *   - masters: the newest template; the 8 database masters count as present (they are the database).
 * Listings are cached for 30 s and dropped on every write of this machine.
 */

const LIST_TTL_MS = 30_000;
const DAY_MS = 86_400_000;
const DAILY_NAMES = INPUT_CATALOG.filter((f) => !isMasterInput(f.name)).map((f) => f.name);

let listed: { at: number; entries: InputEntry[] } | null = null;
let templates: { at: number; keys: string[] } | null = null;
/** Drop the cached listings (after this machine wrote, or in tests). */
export const forgetListings = (): void => {
  listed = null;
  templates = null;
};
onWrite(forgetListings);

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The first day still kept (older versions are gone or going). */
const oldestKept = (): string => addDays(istToday(), -INPUT_DAYS);

/** The month folders covering the kept days. */
const monthDays = (): string[] => {
  const out: string[] = [];
  for (let d = oldestKept(); d <= istToday(); d = addDays(d, 1)) if (!out.some((o) => o.slice(0, 7) === d.slice(0, 7))) out.push(d);
  return out;
};

/** The last listing S3 gave (used while S3 cannot be reached: saves then still go to the queue). */
let lastGood: InputEntry[] = [];

/** Every kept input version in the visible scopes, and this machine's queued ones. */
const entries = async (): Promise<InputEntry[]> => {
  if (listed && Date.now() - listed.at < LIST_TTL_MS) return listed.entries;
  const cut = Date.parse(`${oldestKept()}T00:00:00Z`);
  const prefixes = visibleScopes().flatMap((scope) => [FOLDER.GRN_SOH, FOLDER.DAILY_INPUTS].flatMap((folder) => monthDays().map((d) => ({ scope, prefix: monthPrefix(scope, folder, d) }))));
  let found: InputEntry[];
  let fresh = true;
  try {
    found = (await Promise.all(prefixes.map(async ({ scope, prefix }) =>
      (await list(prefix)).map((o) => parseInputKey(o.key, scope)).filter((e): e is InputEntry => !!e)))).flat();
    lastGood = found;
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    found = [...lastGood];
    fresh = false;
  }
  for (const q of await queuedItems()) {
    const scope = scopeOfKey(q.key);
    const e = scope ? parseInputKey(q.key, scope) : null;
    if (e && !found.some((f) => f.key === e.key)) found.push(e);
  }
  const kept = found.filter((e) => e.at.getTime() >= cut && DAILY_NAMES.includes(e.name));
  if (fresh) listed = { at: Date.now(), entries: kept };
  return kept;
};

export interface StoredInput extends DayInput {
  /** The S3 key of the version used (null = a database master). */
  key: string | null;
}

/** Metadata of a version: from S3, or from the queue while it waits there. */
const metaOf = async (key: string): Promise<{ meta: ObjMeta; size: number; at: Date; queued: boolean } | null> => {
  const q = (await queuedItems()).find((i) => i.key === key);
  if (q) return { meta: q.meta, size: q.size, at: new Date(q.queuedAt), queued: true };
  const h = await head(key);
  return h ? { meta: h.meta, size: h.size, at: stampTime(baseName(key).split('__')[0]) ?? h.modified, queued: false } : null;
};

const inputMeta = (m: { meta: ObjMeta; size: number; at: Date }): InputMeta => ({
  at: m.at.toISOString(), by: m.meta.byId ?? null, byName: m.meta.byName ?? null, source: m.meta.source as InputOrigin, sha256: m.meta.sha256, size: m.size,
});

/** The newest version of `name` on `day` in the first visible scope that has one (null: none, or deleted). */
const versionOfDay = (all: InputEntry[], name: string, day: string): InputEntry | null | 'deleted' => {
  for (const scope of visibleScopes()) {
    const mine = all.filter((e) => e.name === name && e.day === day && e.scope === scope).sort((a, b) => b.stamp.localeCompare(a.stamp));
    if (mine.length) return mine[0].deleted ? 'deleted' : mine[0];
  }
  return null;
};

/** The template versions in the visible scopes, newest first (a test machine's own first). */
const templateKeys = async (): Promise<string[]> => {
  if (templates && Date.now() - templates.at < LIST_TTL_MS) return templates.keys;
  const keys: string[] = [];
  let fresh = true;
  for (const scope of visibleScopes()) {
    let own: string[];
    try {
      own = (await list(templateDir(scope))).map((o) => o.key).filter((k) => k.endsWith(`__${INTRANSIT_TEMPLATE_NAME}`));
      lastTemplates.set(scope, own);
    } catch (err) {
      if (!isUnreachable(err)) throw err;
      own = [...(lastTemplates.get(scope) ?? [])];
      fresh = false;
    }
    for (const q of await queuedItems()) if (q.key.startsWith(templateDir(scope)) && !own.includes(q.key)) own.push(q.key);
    keys.push(...own.sort((a, b) => baseName(b).localeCompare(baseName(a))));
  }
  if (fresh) templates = { at: Date.now(), keys };
  return keys;
};
const lastTemplates = new Map<Scope, string[]>();

/** The inputs used for `date`. */
export const resolveStored = async (date: string): Promise<{ files: StoredInput[]; missing: string[] }> => {
  const all = await entries();
  const files: StoredInput[] = [];
  const missing: string[] = [];
  for (const spec of INPUT_CATALOG) {
    if (isMasterInput(spec.name)) {
      if ((DB_MASTER_FILES as readonly string[]).includes(spec.name)) {
        files.push({ name: spec.name, from: 'master', meta: null, problems: [], key: null });
        continue;
      }
      const [key] = spec.name === INTRANSIT_TEMPLATE_NAME ? await templateKeys() : [];
      const m = key ? await metaOf(key) : null;
      if (key && m) files.push({ name: spec.name, from: 'master', meta: inputMeta(m), problems: [], queued: m.queued, key });
      else missing.push(spec.name);
      continue;
    }
    const days = [...new Set(all.filter((e) => e.name === spec.name && e.day <= date).map((e) => e.day))].sort().reverse();
    let pick: InputEntry | null = null;
    for (const day of days) {
      const v = versionOfDay(all, spec.name, day);
      if (v && v !== 'deleted') {
        pick = v;
        break;
      }
    }
    const m = pick ? await metaOf(pick.key) : null;
    if (!pick || !m) {
      missing.push(spec.name);
      continue;
    }
    files.push({
      name: spec.name, from: pick.day === date ? 'date' : 'earlier', date: pick.day, meta: inputMeta(m), problems: m.meta.problems ?? [], queued: m.queued, key: pick.key,
    });
  }
  return { files, missing };
};

/** The Daily run page's inputs from S3. */
export const s3Source: InputSource = {
  resolve: async (date) => {
    const { files, missing } = await resolveStored(date);
    return { files: files.map(({ key: _key, ...f }) => f), missing };
  },
  versions: async (name) => (name === INTRANSIT_TEMPLATE_NAME ? Math.max(0, (await templateKeys()).length - 1) : 0),
  dates: async () => {
    const all = await entries();
    const days = [...new Set(all.map((e) => e.day))].sort().reverse();
    return days.filter((d) => DAILY_NAMES.some((n) => { const v = versionOfDay(all, n, d); return !!v && v !== 'deleted'; }));
  },
};

/** Per day: how many daily files it has its own copy of (the page's day ribbon). */
export const dailyCounts = async (days: string[]): Promise<Map<string, number>> => {
  const all = await entries();
  return new Map(days.map((d) => [d, DAILY_NAMES.filter((n) => { const v = versionOfDay(all, n, d); return !!v && v !== 'deleted'; }).length]));
};

/** Download a resolved input into `file` (from S3, checked, or from the queue). */
export const fetchInput = async (key: string, file: string): Promise<void> => {
  const q = (await queuedItems()).find((i) => i.key === key);
  if (q) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.copyFile(dataOf(q), file);
    return;
  }
  if (!(await getToFile(key, file))) throw new Error(`${baseName(key)} is no longer in S3 (older than ${INPUT_DAYS} days?)`);
};

// ---- writes ----------------------------------------------------------------------------------------------------

export interface Saver {
  id: number | null;
  name: string | null;
}

/**
 * The version `key` when it holds the same content as `from` (null otherwise, or when S3 cannot be asked now: then the
 * save goes ahead, into the queue).
 */
const sameContent = async (key: string, from: Buffer | string): Promise<{ queued: boolean; sha256: string; size: number } | null> => {
  try {
    const m = await metaOf(key);
    const d = await digest(from);
    return m && m.meta.sha256 === d.sha256 ? { queued: m.queued, sha256: d.sha256, size: d.size } : null;
  } catch (err) {
    if (isUnreachable(err)) return null;
    throw err;
  }
};

/** This machine's newest version of `name` on `day` (null when none). */
const ownNewest = async (name: string, day: string): Promise<InputEntry | null> => {
  const own = (await entries()).filter((e) => e.scope === writeScope() && e.name === name && e.day === day).sort((a, b) => b.stamp.localeCompare(a.stamp));
  return own[0] ?? null;
};

/**
 * Save a day's input file. The same content as that day's newest version changes nothing (only within the same day:
 * a file fetched again on a new day is saved for that day, so a daily refresh never expires).
 */
export const saveDailyFile = async (
  name: string, day: string, from: Buffer | string, who: Saver, source: string, problems: string[] = [],
): Promise<PutResult & { unchanged: boolean }> => {
  const last = await ownNewest(name, day);
  const same = last && !last.deleted ? await sameContent(last.key, from) : null;
  if (last && same) return { key: last.key, stored: same.queued ? 'queued' : 's3', sha256: same.sha256, size: same.size, unchanged: true };
  const r = await put(inputKey(writeScope(), name, day, newStamp()), from, { byId: who.id, byName: who.name, source, day, origName: name, problems });
  return { ...r, unchanged: false };
};

/** Delete this machine's copy of a day's file: a tombstone (the earlier day's copy is used from now on). */
export const deleteDailyFile = async (name: string, day: string, who: Saver): Promise<void> => {
  const last = await ownNewest(name, day);
  if (!last || last.deleted) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
  await putJson(tombstoneKey(writeScope(), name, day, newStamp()), { deleted: last.key, at: new Date().toISOString(), by: who.id, byName: who.name },
    { byId: who.id, byName: who.name, source: 'delete', day, origName: name });
};

/** Save a new version of the report template (the same content as the newest changes nothing). */
export const saveTemplate = async (from: Buffer | string, who: Saver, source = 'upload'): Promise<PutResult & { unchanged: boolean }> => {
  const [newest] = await templateKeys();
  const same = newest && scopeOfKey(newest) === writeScope() ? await sameContent(newest, from) : null;
  if (newest && same) return { key: newest, stored: same.queued ? 'queued' : 's3', sha256: same.sha256, size: same.size, unchanged: true };
  const r = await put(templateKey(writeScope(), newStamp()), from, { byId: who.id, byName: who.name, source, origName: INTRANSIT_TEMPLATE_NAME });
  return { ...r, unchanged: false };
};

/** The template's earlier versions, newest first (the version id is the stamp). */
export const templateVersions = async (): Promise<MasterVersion[]> => {
  const [, ...older] = await templateKeys();
  const out: MasterVersion[] = [];
  for (const key of older) {
    const m = await metaOf(key);
    if (m) out.push({ version: baseName(key).split('__')[0], at: m.at.toISOString(), size: m.size, byName: m.meta.byName ?? null, source: (m.meta.source || null) as MasterVersion['source'] });
  }
  return out;
};

/** Make an earlier template version the newest again (a copy with a new stamp, source restore). */
export const restoreTemplate = async (version: string, who: Saver): Promise<{ unchanged: boolean }> => {
  const keys = await templateKeys();
  const key = keys.find((k) => baseName(k).split('__')[0] === version);
  if (!key) throw appError(ERROR_CODES.INTRANSIT_VERSION_NOT_FOUND, INTRANSIT_TEMPLATE_NAME, version);
  if (key === keys[0]) return { unchanged: true };
  await copy(key, templateKey(writeScope(), newStamp()), { source: 'restore', byId: who.id, byName: who.name });
  return { unchanged: false };
};

/** The S3 root this machine writes (for messages). */
export const ownRoot = (): string => rootOf(writeScope() as Scope);
