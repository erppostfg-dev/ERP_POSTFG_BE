import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { gunzipSync } from 'zlib';
import { In } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { env } from '../../../config/env';
import { blockingMissing, COMBO_CHECK, INTRANSIT_REPORT_NAME, INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS, INTRANSIT_TEMPLATE_NAME, MAIL_FILE_NAMES, RUN_RECORD_FILE } from '../../../constants';
import { IntransitRun } from '../../../entities';
import { ConnectorResult } from '../connectors';
import { DB_MASTER_FILES, exportMastersFromDb } from '../masters-export';
import { runRecord } from '../run-record';
import { fetchInput, resolveStored, saveDailyFile } from './inputs';
import { BUILD_JSON, buildJsonKey, fullReportDir, refusedKey, SNAPSHOT_SHEETS, snapshotDir } from './layout';
import { withLock } from './lock';
import { PROD_SCOPE, Scope, TEST_SCOPE, visibleScopes, writeScope } from './scope';
import { onS3Reachable } from './queue';
import { getBytes, isUnreachable, put, putJson, remove } from './store';
import { LOG_SOURCE } from '../../../constants/logging';
import { log as appLog } from '../../../utils/logger';

/*
 * A run's files in S3 (user, 2026-10-26: nothing stays on the server). A job works in INTRANSIT_DIR/tmp/job-<id>/ only,
 * emptied when it ends (what S3 cannot take then waits in the queue):
 *   - a connector run: the files that passed the column check become the day's inputs; the refused ones go to the
 *     day's _refused/ folder (30 days). Its raw downloads and run.json are not kept (user); its log stays in the DB.
 *   - PEPIMS (a build for today): its two files become the day's inputs.
 *   - a build: its inputs downloaded from S3 (checked) plus the 8 masters from the database; afterwards Full Report/
 *     gets the workbook, the combo-check files, the masters it used, every sheet as a gzipped CSV and run.json; the
 *     Daily Snapshot gets the 3 important sheets as plain CSVs; the day's _build.json points at the final build.
 * The final build of a day is the one started last (the highest run id) among its succeeded, not deleted builds
 * (user, 2026-10-26: both kept, the later one final). Each build keeps its own timestamped folder.
 */

const repo = () => AppDataSource.getRepository(IntransitRun);

export const jobDir = (id: string): string => path.join(path.resolve(env.intransit.dir), 'tmp', `job-${id}`);

const KEPT_MARKER = 'KEPT.txt';

/**
 * At start: remove the job folders of stopped jobs (their files went to S3 or the queue, or the job failed) - except
 * a job whose files could not be saved at all (marked KEPT): it stays until someone deals with it (counted in the
 * queue's limit).
 */
export const clearJobs = async (): Promise<void> => {
  const tmp = path.join(path.resolve(env.intransit.dir), 'tmp');
  for (const d of await fsp.readdir(tmp).catch(() => [] as string[])) {
    if (!d.startsWith('job-') || fs.existsSync(path.join(tmp, d, KEPT_MARKER))) continue;
    await fsp.rm(path.join(tmp, d), { recursive: true, force: true });
  }
};

/** Mark a job folder as kept (its files are not in S3 nor queued): a note of why. */
export const markJobKept = (id: string, why: string): Promise<void> =>
  fsp.writeFile(path.join(jobDir(id), KEPT_MARKER), `Not saved to S3 (${new Date().toISOString()}): ${why}\n`, 'utf8');

const who = (run: IntransitRun) => ({ id: run.createdBy, name: ((run.options ?? {}) as { byName?: string | null }).byName ?? null });

type RunOptions = { scope?: string; folder?: string; deletedAt?: string; byName?: string | null };
const optionsOf = (run: IntransitRun): RunOptions => (run.options ?? {}) as RunOptions;

/** A run's scope: 'prod' for the live server's runs (and older runs naming none), 'test' for a test machine's. */
export const scopeOfRun = (run: IntransitRun): Scope => {
  const s = optionsOf(run).scope;
  return !s || s === PROD_SCOPE ? PROD_SCOPE : TEST_SCOPE;
};

export const isDeleted = (run: IntransitRun): boolean => !!optionsOf(run).deletedAt;

/** The build's Full Report folder (null before it started). */
export const reportDirOf = (run: IntransitRun): string | null => {
  const folder = optionsOf(run).folder;
  return folder && run.asOf ? fullReportDir(scopeOfRun(run), run.asOf, folder) : null;
};

// ---- connectors ------------------------------------------------------------------------------------------------

/** Before a connector runs: the day's Shipment_Status.csv in the job folder (Amazon GRN reads it). Returns that folder. */
export const prepareConnector = async (run: IntransitRun, day: string): Promise<string> => {
  const dir = path.join(jobDir(run.id), 'input');
  await fsp.mkdir(dir, { recursive: true });
  const ss = (await resolveStored(day)).files.find((f) => f.name === 'Shipment_Status.csv');
  if (ss?.key) await fetchInput(ss.key, path.join(dir, ss.name));
  return dir;
};

/** After a connector ran: the checked files become the day's inputs, the refused ones go to _refused/. name -> key. */
export const storeConnectorFiles = async (run: IntransitRun, exportDir: string, result: ConnectorResult, day: string): Promise<Record<string, string>> => {
  const keys: Record<string, string> = {};
  for (const name of result.saved) {
    const file = path.join(exportDir, name);
    if (fs.existsSync(file)) keys[name] = (await saveDailyFile(name, day, file, who(run), run.kind)).key;
  }
  for (const [name, problems] of Object.entries(result.rejected)) {
    const file = path.join(exportDir, name);
    if (!fs.existsSync(file)) continue;
    keys[name] = (await put(refusedKey(writeScope(), name, day, run.id), file, { byId: run.createdBy, byName: who(run).name, source: run.kind, runId: run.id, day, origName: name, problems })).key;
  }
  return keys;
};

/** PEPIMS' files of a build for today: the day's input files. */
export const storePepimsFiles = async (run: IntransitRun, dir: string, names: string[], day: string): Promise<void> => {
  for (const name of names) await saveDailyFile(name, day, path.join(dir, name), who(run), 'pepims');
};

// ---- builds ----------------------------------------------------------------------------------------------------

export interface InputUsed {
  name: string;
  key: string;
  day: string | null;
  sha256: string;
}

/** A build's inputs into `into`: the day's files from S3 (checked), the template, and the 8 masters from the database. */
export const snapshotFromStore = async (asOf: string, into: string) => {
  await fsp.mkdir(into, { recursive: true });
  const { files: resolved, missing: allMissing } = await resolveStored(asOf);
  const missing = blockingMissing(allMissing);
  if (missing.length) throw new Error(`no copy of ${missing.join(', ')} for ${asOf}`);
  const stored = resolved.filter((f) => f.key);
  for (let i = 0; i < stored.length; i += 4) {
    await Promise.all(stored.slice(i, i + 4).map((f) => fetchInput(f.key as string, path.join(into, f.name))));
  }
  await exportMastersFromDb(into);
  return {
    used: {
      masters: resolved.filter((f) => f.from === 'master').length,
      ofDate: resolved.filter((f) => f.from === 'date').map((f) => f.name),
      earlier: resolved.filter((f) => f.from === 'earlier').map((f) => ({ name: f.name, date: f.date as string })),
    },
    inputsUsed: stored.map((f): InputUsed => ({ name: f.name, key: f.key as string, day: f.date ?? null, sha256: f.meta?.sha256 ?? '' })),
    template: stored.find((f) => f.name === INTRANSIT_TEMPLATE_NAME)?.key ?? null,
  };
};

export interface BuildJson {
  day: string;
  runId: string;
  folder: string;
  builtAt: string;
  /** sheet -> key of its CSV in the build's Daily Snapshot folder */
  files: Record<string, string>;
  workbook: string;
}

/** The day's final build: succeeded, not deleted, of this scope, the highest id (`plus` counts as succeeded). */
const finalRunOf = async (scope: Scope, day: string, plus?: IntransitRun): Promise<IntransitRun | null> => {
  const runs = (await repo().find({ where: { kind: INTRANSIT_RUN_KIND.REPORT, asOf: day, status: In([INTRANSIT_RUN_STATUS.SUCCEEDED]) } }))
    .filter((r) => scopeOfRun(r) === scope && !isDeleted(r) && !!optionsOf(r).folder);
  if (plus && !runs.some((r) => r.id === plus.id)) runs.push(plus);
  return runs.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
};

const buildJsonOf = (run: IntransitRun): BuildJson => {
  const folder = optionsOf(run).folder as string;
  const snap = snapshotDir(scopeOfRun(run), run.asOf as string, folder);
  return {
    day: run.asOf as string, runId: run.id, folder, builtAt: (run.finishedAt ?? new Date()).toISOString(),
    files: Object.fromEntries(SNAPSHOT_SHEETS.map((s) => [s, `${snap}${s}.csv`])), workbook: `${reportDirOf(run)}${INTRANSIT_REPORT_NAME}`,
  };
};

/**
 * Days whose _build.json could not be written (S3 unreachable): pointed again once the queue has reached S3, after the
 * build's queued files. The pointer itself is never queued: a queued copy, sent later outside the day's lock, could
 * overwrite a newer build's pointer with an older one (review, 2026-10-27).
 */
const repointLater = new Map<string, { scope: Scope; day: string }>();

onS3Reachable(async () => {
  for (const [k, { scope, day }] of [...repointLater]) {
    repointLater.delete(k);
    await repointDay(scope, day);
  }
});

/** Point the day's _build.json at its final build (or remove it when none is left). Under the day's lock. */
export const repointDay = (scope: Scope, day: string, plus?: IntransitRun): Promise<IntransitRun | null> =>
  withLock(`it:snap:${scope}:${day}`, async () => {
    const final = await finalRunOf(scope, day, plus);
    const key = buildJsonKey(scope, day);
    try {
      if (final) {
        await putJson(key, buildJsonOf(final), { byId: final.createdBy, source: 'build', runId: final.id, day }, { noQueue: true });
        return final;
      }
      await remove(key).catch(async (err) => {
        // without s3:DeleteObject: an empty pointer (the page then shows the day before)
        if ((err as { name?: string }).name !== 'AccessDenied') throw err;
        await putJson(key, { day, runId: null }, { source: 'build', day }, { noQueue: true });
      });
    } catch (err) {
      if (!isUnreachable(err)) throw err;
      repointLater.set(`${scope}|${day}`, { scope, day });
      appLog.warn(LOG_SOURCE.S3, `[intransit-s3] S3 unreachable: ${key} is written again once it is back`);
    }
    return final;
  });

/**
 * After a build succeeded: its files to Full Report/, the 3 important sheets to its Daily Snapshot folder (plain CSV),
 * then the day's _build.json when it is the final build (written last). Returns the stored keys.
 */
export const publishBuild = async (run: IntransitRun, dir: string): Promise<{ report: string; files: Record<string, string>; final: boolean; queued: number }> => {
  const base = reportDirOf(run);
  if (!base) throw new Error(`run ${run.id} has no build folder`);
  const meta = { byId: run.createdBy, byName: who(run).name, source: 'build', runId: run.id, day: run.asOf };
  const files: Record<string, string> = {};
  let queued = 0;
  const keep = async (key: string, file: string, label: string): Promise<void> => {
    const r = await put(key, file, { ...meta, origName: path.basename(file) });
    files[label] = r.key;
    if (r.stored === 'queued') queued++;
  };
  for (const name of [INTRANSIT_REPORT_NAME, COMBO_CHECK.ALERT_FILE, COMBO_CHECK.SPLIT1_ROWS_FILE, ...MAIL_FILE_NAMES]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) await keep(`${base}${name}`, file, name);
  }
  for (const name of DB_MASTER_FILES) {
    const file = path.join(dir, 'input', name);
    if (fs.existsSync(file)) await keep(`${base}masters/${name}`, file, `masters/${name}`);
  }
  const sheets = path.join(dir, 'sheets');
  for (const name of await fsp.readdir(sheets).catch(() => [] as string[])) await keep(`${base}sheets/${name}`, path.join(sheets, name), `sheets/${name}`);
  // the Daily Snapshot: plain CSVs (they open straight from the S3 console)
  const snap = snapshotDir(scopeOfRun(run), run.asOf as string, optionsOf(run).folder as string);
  for (const sheet of SNAPSHOT_SHEETS) {
    const gz = path.join(sheets, `${sheet}.csv.gz`);
    if (!fs.existsSync(gz)) continue;
    const r = await put(`${snap}${sheet}.csv`, gunzipSync(await fsp.readFile(gz)), { ...meta, origName: `${sheet}.csv` });
    files[`snapshot/${sheet}`] = r.key;
    if (r.stored === 'queued') queued++;
  }
  const final = await repointDay(scopeOfRun(run), run.asOf as string, run);
  return { report: files[INTRANSIT_REPORT_NAME], files, final: final?.id === run.id, queued };
};

/** run.json of a build, in its Full Report folder (written when it ends, and again when it is deleted). */
export const storeRunJson = async (run: IntransitRun): Promise<void> => {
  if (run.kind !== INTRANSIT_RUN_KIND.REPORT) return; // connector runs: their log is in the database (user)
  const base = reportDirOf(run);
  if (!base || scopeOfRun(run) !== writeScope()) return;
  await putJson(`${base}${RUN_RECORD_FILE}`, runRecord(run), { byId: run.createdBy, source: 'run', runId: run.id, day: run.asOf });
};

/** A build deleted from the page: kept in S3 until its 90 days are up, but no longer the day's final build. */
export const unpublishRun = async (run: IntransitRun): Promise<void> => {
  if (run.kind !== INTRANSIT_RUN_KIND.REPORT || !run.asOf || scopeOfRun(run) !== writeScope()) return;
  await storeRunJson(run);
  await repointDay(scopeOfRun(run), run.asOf);
};

/** The day's _build.json in the first visible scope that has one (null: none). */
export const buildJsonFor = async (day: string): Promise<BuildJson | null> => {
  for (const scope of visibleScopes()) {
    const raw = await getBytes(buildJsonKey(scope, day));
    if (!raw) continue;
    const b = JSON.parse(raw.toString('utf8')) as BuildJson | { runId: null };
    if (b.runId) return b as BuildJson;
  }
  return null;
};

export { BUILD_JSON };
