import { fork } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  COMBO_CHECK,
  ERROR_CODES,
  errorMessage,
  INPUT_BY_NAME,
  INTRANSIT_FOLDERS,
  INTRANSIT_INVENTORY_FILE,
  INTRANSIT_LOG_TAIL_LINES,
  INTRANSIT_REPORT_NAME,
  INTRANSIT_RESTART_ERROR,
  INTRANSIT_RUN_KIND,
  INTRANSIT_RUN_STATUS,
  INTRANSIT_SOURCE,
  INTRANSIT_TEMPLATE_NAME,
  IntransitRunKind,
  IntransitSource,
  PEPIMS_CONNECTOR,
} from '../../constants';
import { IntransitRun } from '../../entities';
import { appError } from '../../utils/AppError';
import { ComboCheckResult } from './combo-check';
import { ConnectorConfig, ConnectorOptions, ConnectorResult, onlyList } from './connectors';
import { IntransitSettings, resolveFromDate } from './context';
import { validateInput } from './catalog';
import { cachesIn, cachesOut } from './s3/caches';
import { s3Source } from './s3/inputs';
import { buildFolderName, monthlyKey, weeklyKey } from './s3/layout';
import { touchPeriods } from './s3/periods';
import {
  isDeleted, jobDir, markJobKept, prepareConnector, publishBuild, scopeOfRun as storeScopeOfRun, snapshotFromStore, storeConnectorFiles, storePepimsFiles, storeRunJson,
  unpublishRun,
} from './s3/run-store';
import { PROD_SCOPE, storageOn, visibleScopes, writeScope } from './s3/scope';
import { forgetSnapshotDays } from './s3/snapshot';
import { checkDate, dailyDir, diskSource, FetchStep, istToday, moveToDeleted, planDay, resolveInputs, writeWithMeta } from './input-store';
import { writeRunRecord } from './run-record';
import { INVENTORY_COLUMNS, InventorySnapshot } from './inventory-snapshot';
import { exportMastersFromDb } from './masters-export';
import { PipelineResult } from './pipeline';
import type { WorkerJob, WorkerMessage } from './run-worker';
import { AMAZON_KEYS } from './sources/amazon';
import { FLIPKART_KEYS } from './sources/flipkart';
import { fetchPepimsTracker } from './sources/pepims';
import { UNIWARE_KEYS } from './sources/uniware';
import { uniwareConfig } from './uniware-facilities';
import { LOG_SOURCE } from '../../constants/logging';
import { logError } from '../../utils/classify-error';
import { logContext } from '../../utils/log-context';
import { runJob } from '../../utils/log-call';

/*
 * In-transit Stock jobs (2026-10-15, user): report builds and connector fetches, recorded in intransit_runs.
 *   - Each job runs in a forked child (run-worker.ts) so the API stays responsive; its log streams back here.
 *   - Report builds run one at a time (FIFO), for a day (asOf): first, when asked (fetchFirst), the API files not of
 *     that day are fetched for it (a connector run each, after a fetch of that source already queued or running); then
 *     the build runs on a copy of the day's inputs (masters + that day's files, or the latest earlier copy, recorded
 *     in result.inputsUsed) taken when it starts, so an upload during a build never mixes two versions.
 *   - Each connector source runs one fetch at a time, for a day; its files go to inputs/daily/<day>/.
 *   - While a report runs, options.step ('fetching <source>' | 'building' | 'done') and options.progress (its last
 *     log line) tell the page where it is.
 *   - A job left queued/running when the server stops is marked failed at the next start (recoverRuns).
 */

const DIR = (): string => path.resolve(env.intransit.dir);
const runDir = (id: string): string => path.join(DIR(), INTRANSIT_FOLDERS.RUNS, id);
const exportDir = (source: string, id: string): string => path.join(DIR(), INTRANSIT_FOLDERS.EXPORTS, source, id);
/** Where a run's own files are: its run folder (report) or its export folder (connector). */
const filesDirOf = (run: IntransitRun): string => (run.kind === INTRANSIT_RUN_KIND.REPORT ? runDir(run.id) : exportDir(run.kind, run.id));
const cacheDir = (): string => path.join(DIR(), INTRANSIT_FOLDERS.CACHE);
const LOG_FLUSH_MS = 2000;
const HEARTBEAT_MS = 30_000;
/** Another machine's queued/running run quiet for this long is failed ("host stopped"). */
const STALE_RUN_MS = 10 * 60_000;
const ERROR_MAX = 1000;

const repo = () => AppDataSource.getRepository(IntransitRun);

/**
 * A run's scope (user, 2026-10-26): 'prod' for the live server's runs (and older runs that name none), 'test' for a
 * test machine's - hidden from the live pages, never blocking the live fetches. A run deleted from the page is kept
 * (options.deletedAt) and hidden.
 */
const scopeOfRun = storeScopeOfRun;
const visibleRun = (r: IntransitRun): boolean => !storageOn() || (visibleScopes().includes(scopeOfRun(r)) && !isDeleted(r));
/** The scope a new run gets: only where the S3 store is on (the disk store keeps runs as before). */
const runScope = (): { scope?: string } => (storageOn() ? { scope: writeScope() } : {});
const ownScope = (): string => runScope().scope ?? PROD_SCOPE;

/** Full Reports are kept 90 days in S3 (lifecycle rule); the weekly/monthly copies forever. */
const REPORT_DAYS = 90;

// ---- views -----------------------------------------------------------------------------------------------------

export interface RunView {
  id: string;
  kind: IntransitRunKind;
  status: string;
  asOf: string | null;
  options: Record<string, unknown> | null;
  createdBy: { id: number; name: string } | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  timings: Record<string, number> | null;
  summary: Record<string, unknown>[] | null;
  sheetRows: Record<string, number> | null;
  result: Record<string, unknown> | null;
  /** True when the report can be downloaded (GET /intransit/runs/:id/report). */
  hasReport: boolean;
  /**
   * S3 store: where the workbook is - stored (90 days from its day), expired (then the week's / month's copy has the
   * period's final build), and the weekly/monthly copy names of its period.
   */
  report?: { state: 'stored' | 'expired'; expiresOn: string; weekly: string; monthly: string } | null;
  logTail?: string[];
}

const reportInfo = (r: IntransitRun): RunView['report'] => {
  if (!storageOn() || r.kind !== INTRANSIT_RUN_KIND.REPORT || r.status !== INTRANSIT_RUN_STATUS.SUCCEEDED || !r.asOf || !r.reportPath?.startsWith('s3:')) return null;
  const expiresOn = new Date(Date.parse(`${r.asOf}T00:00:00Z`) + REPORT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const w = weeklyKey(PROD_SCOPE, r.asOf);
  const m = monthlyKey(PROD_SCOPE, r.asOf);
  return { state: istToday() >= expiresOn ? 'expired' : 'stored', expiresOn, weekly: `${w.fy}/${w.label}`, monthly: `${m.fy}/${m.label}` };
};

const view = (r: IntransitRun, withLog = false): RunView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  asOf: r.asOf,
  options: r.options,
  createdBy: r.creator ? { id: r.creator.id, name: r.creator.name } : null,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  error: r.error,
  timings: r.timings,
  summary: r.summary,
  sheetRows: r.sheetRows,
  result: r.result,
  hasReport: r.status === INTRANSIT_RUN_STATUS.SUCCEEDED && !!r.reportPath,
  report: reportInfo(r),
  ...(withLog ? { logTail: (r.log ?? '').split('\n').filter(Boolean).slice(-INTRANSIT_LOG_TAIL_LINES) } : {}),
});

const findRun = async (id: string): Promise<IntransitRun> => {
  const run = /^\d+$/.test(id) ? await repo().findOne({ where: { id }, relations: { creator: true } }) : null;
  if (!run) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_FOUND, id);
  return run;
};

export const listRuns = async (kind?: string, limit = 50): Promise<RunView[]> => {
  const where = kind && (Object.values(INTRANSIT_RUN_KIND) as string[]).includes(kind) ? { kind: kind as IntransitRunKind } : {};
  const rows = await repo().find({ where, relations: { creator: true }, order: { id: 'DESC' }, take: limit * 4 });
  return rows.filter(visibleRun).slice(0, limit).map((r) => view(r));
};

export const getRun = async (id: string): Promise<RunView> => view(await findRun(id), true);

export const getRunLog = async (id: string): Promise<string> => (await findRun(id)).log ?? '';

/** report_path as stored: relative to INTRANSIT_DIR (runs/<id>/<file>, since 2026-10-23). */
const relReportPath = (abs: string | null): string | null => (abs ? path.relative(DIR(), abs).split(path.sep).join('/') : null);

/** The report file of a run on this disk: relative paths, older absolute ones, or else the file in its run folder. */
const reportFileOf = (run: IntransitRun): string | null => {
  if (!run.reportPath) return null;
  const p = path.isAbsolute(run.reportPath) ? run.reportPath : path.join(DIR(), run.reportPath);
  if (fs.existsSync(p)) return p;
  const own = path.join(runDir(run.id), path.basename(run.reportPath.replace(/\\/g, '/')));
  return fs.existsSync(own) ? own : null;
};

/** The report of a succeeded run: [path, download name]. */
export const getReportFile = async (id: string): Promise<[string, string]> => {
  const run = await findRun(id);
  const file = run.status === INTRANSIT_RUN_STATUS.SUCCEEDED ? reportFileOf(run) : null;
  if (!file) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_DONE, id, run.status);
  const day = (run.asOf ?? '').replace(/-/g, '');
  return [file, INTRANSIT_REPORT_NAME.replace('.xlsx', `${day ? `_${day}` : ''}_run${id}.xlsx`)];
};

/**
 * A file a run wrote: for a connector run, the names in its result (saved or refused by the column check), in its
 * export folder; for a report run, the combo-check files next to its workbook. The path can never leave that folder.
 */
export const runFilePath = async (id: string, name: string): Promise<string> => {
  const run = await findRun(id);
  const result = (run.result ?? {}) as { saved?: string[]; rejected?: Record<string, string[]> };
  const names = [...(result.saved ?? []), ...Object.keys(result.rejected ?? {})];
  // a report run: only the combo-check files written next to its workbook
  if (run.kind === INTRANSIT_RUN_KIND.REPORT) names.splice(0, names.length, COMBO_CHECK.ALERT_FILE, COMBO_CHECK.SPLIT1_ROWS_FILE);
  if (!names.includes(name)) throw appError(ERROR_CODES.INTRANSIT_RUN_FILE_UNKNOWN, id, name);
  const file = path.join(run.kind === INTRANSIT_RUN_KIND.REPORT ? runDir(id) : exportDir(run.kind, id), name);
  if (!fs.existsSync(file)) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
  return file;
};

export const deleteRun = async (id: string): Promise<void> => {
  const run = await findRun(id);
  if (run.status === INTRANSIT_RUN_STATUS.QUEUED || run.status === INTRANSIT_RUN_STATUS.RUNNING) {
    throw appError(ERROR_CODES.INTRANSIT_RUN_BUSY, id, run.status);
  }
  if (storageOn()) {
    // S3: the run stays (hidden) with its files until they expire; the day's final build and the weekly/monthly
    // copies are worked out again without it
    if (scopeOfRun(run) !== writeScope()) throw appError(ERROR_CODES.INTRANSIT_SCOPE_READ_ONLY, `run ${id}`, writeScope());
    await repo().update({ id }, { options: { ...(run.options ?? {}), deletedAt: new Date().toISOString() } as QueryDeepPartialEntity<IntransitRun>['options'] });
    const deleted = (await repo().findOne({ where: { id }, relations: { creator: true } })) as IntransitRun;
    await unpublishRun(deleted);
    forgetSnapshotDays();
    if (deleted.asOf && deleted.kind === INTRANSIT_RUN_KIND.REPORT) void touchPeriods(deleted.asOf).catch((err) => logError(LOG_SOURCE.APP, `[intransit] run ${id} deleted: weekly/monthly copies not redone`, err));
    return;
  }
  {
    // kept under _deleted/ with its run.json (user, 2026-10-22: keep everything), the row removed from the page
    const dir = filesDirOf(run);
    await writeRunRecord(run, dir);
    await moveToDeleted(dir);
    await repo().delete({ id });
  }
};

// ---- starting jobs ---------------------------------------------------------------------------------------------

const chains = new Map<string, Promise<void>>();

/** Runs `job` after every earlier job of the same lane (report, or one connector source). */
const enqueue = (lane: string, job: () => Promise<void>): void => {
  const next = (chains.get(lane) ?? Promise.resolve()).then(job).catch((err) => void logError(LOG_SOURCE.APP, `[intransit] ${lane} job failed`, err));
  chains.set(lane, next);
};

const reportSettings = (dir: string, asOf: string, fromDate: string | null): IntransitSettings => ({
  inputDir: path.join(dir, 'input'),
  templateXlsx: path.join(dir, 'input', INTRANSIT_TEMPLATE_NAME),
  outputDir: dir,
  asOf,
  fromDate,
});

export interface Requester {
  id: number | null;
  name: string | null;
}

/** The day's plan with the connectors' set-up state: from S3 where the S3 store is on, else from the disk. */
export const dayPlan = (date: string) => planDay(date, missingConnectorKeys, storageOn() ? s3Source : diskSource);

/**
 * Queue a report build for `asOf` (default today). With fetchFirst (default), the API files not of that day are
 * fetched first; 422 with the blockers when it cannot be built (a missing master, a daily file with no copy ...).
 * fromDate: "YYYY-MM-DD", a number of days before as-of, or "" for none; absent = INTRANSIT_FROM_DATE. Stored resolved
 * in the run's options.
 */
export const startReport = async (who: Requester, opts: { asOf?: unknown; fromDate?: string; fetchFirst?: boolean } = {}): Promise<RunView> => {
  const day = checkDate(opts.asOf);
  const from = resolveFromDate(opts.fromDate ?? env.intransit.fromDate, day);
  const fetchFirst = opts.fetchFirst !== false;
  const { build } = await dayPlan(day);
  const blockers = [...build.blockers, ...(fetchFirst ? [] : build.fetchRequired.map((n) => `${n}: no copy yet - fetch it`))];
  if (blockers.length) throw appError(ERROR_CODES.INTRANSIT_INPUTS_MISSING, blockers.join('; ')).withDetails({ missing: blockers });
  const toFetch = fetchFirst ? build.toFetch : [];
  const run = await repo().save(repo().create({
    kind: INTRANSIT_RUN_KIND.REPORT,
    status: INTRANSIT_RUN_STATUS.QUEUED,
    asOf: day,
    options: {
      fromDate: from, fetchFirst, toFetch, byName: who.name, host: env.intransit.hostId, ...runScope(),
      step: toFetch.length ? `fetching ${toFetch[0].source}` : 'building', progress: null,
    },
    createdBy: who.id,
  }));
  // its own job (2026-10-27): JOB_START / DONE / FAILED, and named with its step on "server blocked" lines
  enqueue(INTRANSIT_RUN_KIND.REPORT, () => runJob(`intransit-${INTRANSIT_RUN_KIND.REPORT}`, () => execute(run.id), { runId: run.id }));
  return getRun(run.id);
};

/** The connectors' settings; Uniware's facilities come from master_facilities.uniware_export (user, 2026-10-26). */
const connectorConfig = async (): Promise<ConnectorConfig> => ({
  amazon: env.intransit.amazon,
  flipkart: env.intransit.flipkart,
  uniware: await uniwareConfig(),
});

/** The .env keys a source still needs (empty = configured). */
export const missingConnectorKeys = (source: IntransitSource): string[] => {
  const { amazon, flipkart, uniware } = env.intransit;
  const keys: Record<IntransitSource, [string[], unknown[]]> = {
    amazon: [AMAZON_KEYS, [amazon.clientId, amazon.clientSecret, amazon.refreshToken]],
    flipkart: [FLIPKART_KEYS, [flipkart.appId, flipkart.appSecret]],
    uniware: [UNIWARE_KEYS, [uniware.tenant, uniware.username, uniware.password]],
  };
  const [names, values] = keys[source];
  return names.filter((_, i) => !values[i]);
};

/**
 * The connector options for `date`: a past day keeps only the files fetchable for any day (the others are the
 * current state only: Amazon_GRN, Inventory Snapshot); 400 when nothing of the source is left (Flipkart).
 */
const optionsForDate = (src: IntransitSource, options: ConnectorOptions, date: string): ConnectorOptions => {
  if (date === istToday()) return { ...options, date };
  const own = [...INPUT_BY_NAME.values()].filter((f) => f.connector === src);
  const asked = onlyList(options.only);
  const wanted = own.filter((f) => !asked.length || asked.includes(f.fetchKey ?? ''));
  const ok = wanted.filter((f) => f.fetchable === 'any-date').map((f) => f.fetchKey ?? '');
  if (!ok.length) throw appError(ERROR_CODES.INTRANSIT_FETCH_TODAY_ONLY, src, date);
  return { ...options, date, only: ok };
};

const queueConnector = async (src: IntransitSource, who: Requester, options: ConnectorOptions): Promise<IntransitRun> => {
  const run = await repo().save(repo().create({
    kind: src, status: INTRANSIT_RUN_STATUS.QUEUED, asOf: options.date ?? null, options: { ...options, by: who.id, byName: who.name, host: env.intransit.hostId, ...runScope() }, createdBy: who.id,
  }));
  enqueue(src, () => runJob(`intransit-${src}`, () => execute(run.id), { runId: run.id }));
  return run;
};

/** Queue a connector fetch for `options.date` (default today); 409 while that source already has one queued or running. */
export const startConnector = async (source: string, who: Requester, options: ConnectorOptions): Promise<RunView> => {
  const sources = Object.values(INTRANSIT_SOURCE) as string[];
  if (!sources.includes(source)) throw appError(ERROR_CODES.INTRANSIT_SOURCE_UNKNOWN, source, sources.join(', '));
  const src = source as IntransitSource;
  const missing = missingConnectorKeys(src);
  if (missing.length) throw appError(ERROR_CODES.INTRANSIT_CONNECTOR_NOT_CONFIGURED, src, missing.join(', '));
  const opts = optionsForDate(src, options, checkDate(options.date));
  // one fetch per source at a time, per scope (a laptop's fetch never blocks production's)
  const busy = (await repo().find({ where: { kind: src, status: In([INTRANSIT_RUN_STATUS.QUEUED, INTRANSIT_RUN_STATUS.RUNNING]) } }))
    .find((r) => scopeOfRun(r) === ownScope());
  if (busy) throw appError(ERROR_CODES.INTRANSIT_CONNECTOR_RUNNING, src, busy.id);
  return getRun((await queueConnector(src, who, opts)).id);
};

/** Builds and fetches queued or running now. */
export const activeRuns = async (): Promise<RunView[]> =>
  (await repo().find({ where: { status: In([INTRANSIT_RUN_STATUS.QUEUED, INTRANSIT_RUN_STATUS.RUNNING]) }, relations: { creator: true }, order: { id: 'ASC' } }))
    .filter(visibleRun).map((r) => view(r));

/** The newest report run of a day (any status) this machine sees - its own first - or null. */
export const latestReportOf = async (date: string): Promise<RunView | null> => {
  const rows = (await repo().find({ where: { kind: INTRANSIT_RUN_KIND.REPORT, asOf: date }, relations: { creator: true }, order: { id: 'DESC' } })).filter(visibleRun);
  const own = rows.find((r) => scopeOfRun(r) === ownScope());
  const r = own ?? rows[0];
  return r ? view(r) : null;
};

/** The newest report run of each of `dates` (id + status), for the day ribbon. */
export const reportsOfDays = async (dates: string[]): Promise<Map<string, { id: string; status: string }>> => {
  const rows = dates.length ? await repo().find({ select: { id: true, asOf: true, status: true, options: true }, where: { kind: INTRANSIT_RUN_KIND.REPORT, asOf: In(dates) }, order: { id: 'ASC' } }) : [];
  return new Map(rows.filter(visibleRun).map((r) => [r.asOf as string, { id: r.id, status: r.status }]));
};

// ---- running a job ---------------------------------------------------------------------------------------------

/** Fork run-worker with the job; resolves with its result (or rejects with its error). Logs go to onLog. */
const runInWorker = (job: WorkerJob, timeoutMs: number, onLog: (line: string) => void): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const ext = path.extname(__filename); // .ts under ts-node(-dev), .js from dist
    const child = fork(path.join(__dirname, `run-worker${ext}`), [], {
      execArgv: [...(ext === '.ts' ? ['-r', 'ts-node/register/transpile-only'] : []), `--max-old-space-size=${env.intransit.workerMaxMemoryMb}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let settled = false;
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(errorMessage(ERROR_CODES.INTRANSIT_RUN_TIMED_OUT, timeoutMs)));
    }, timeoutMs);
    child.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'log') onLog(msg.line);
      else if (msg.type === 'done') finish(null, msg.result);
      else finish(new Error(msg.message));
    });
    child.on('error', (err) => finish(err));
    child.on('exit', (code, signal) => finish(new Error(`the worker stopped (${signal ?? `exit ${code}`}) before finishing`)));
    child.send(job);
  });

/** A connector run's log lines, forwarded to the report run that started it. */
const forwards = new Map<string, (line: string) => void>();

/** Copy the day's inputs into the run's folder (a consistent snapshot); returns what was used. */
const snapshotInputs = async (dir: string, asOf: string) => {
  const into = path.join(dir, 'input');
  await fsp.mkdir(into, { recursive: true });
  const { files, missing } = await resolveInputs(asOf);
  if (missing.length) throw new Error(`no copy of ${missing.join(', ')} for ${asOf}`);
  for (const f of files) await fsp.copyFile(f.path, path.join(into, f.name));
  // INTRANSIT_MASTERS_SOURCE=db: the masters come from the database instead of the files (same names and shape)
  if (env.intransit.mastersSource === 'db') await exportMastersFromDb(into);
  return {
    masters: files.filter((f) => f.from === 'master').length,
    ofDate: files.filter((f) => f.from === 'date').map((f) => f.name),
    earlier: files.filter((f) => f.from === 'earlier').map((f) => ({ name: f.name, date: f.date as string })),
  };
};

type Fetched = { source: IntransitSource | typeof PEPIMS_CONNECTOR; runId: string | null; status: string; files: string[]; error: string | null };

/**
 * Step 0 of a build for today when INTRANSIT_PO_SOURCE=pepims (user, 2026-10-23): Shipment_Status / PO_Format read
 * from PEPIMS (last PEPIMS_TRACKER_DAYS days, sources/pepims.ts), checked like an upload, and saved as the day's files.
 * A past day keeps its own (or the latest earlier) copy: PEPIMS only holds today's statuses. On failure the build goes
 * on with the latest earlier copies (logged; none at all -> the snapshot step stops the build with the reason).
 */
const readPepims = async (run: IntransitRun, log: (line: string) => void, setStep: (step: string) => Promise<void>): Promise<Fetched | null> => {
  const asOf = run.asOf as string;
  if (env.intransit.poSource !== 'pepims' || asOf !== istToday()) return null;
  await setStep(`fetching ${PEPIMS_CONNECTOR}`);
  const tmp = storageOn() ? path.join(jobDir(run.id), 'pepims') : exportDir(PEPIMS_CONNECTOR, run.id);
  const files: string[] = [];
  try {
    const r = await fetchPepimsTracker(env.db, tmp, asOf, log);
    const byName = ((run.options ?? {}) as { byName?: string | null }).byName ?? null;
    for (const name of r.files) {
      const raw = new Uint8Array(await fsp.readFile(path.join(tmp, name)));
      const problems = validateInput(name, raw);
      if (problems.length) throw new Error(`${name} from PEPIMS failed the column check: ${problems.join('; ')}`);
      if (!storageOn()) await writeWithMeta(path.join(dailyDir(asOf), name), raw, { by: run.createdBy, byName, source: PEPIMS_CONNECTOR });
      files.push(name);
    }
    // S3: PEPIMS' files become the day's inputs
    if (storageOn()) await storePepimsFiles(run, tmp, files, asOf);
    log(`pepims: ${r.pos} POs, ${r.lines} lines (Entry Date ${r.from} .. ${r.to}) are the day's ${r.files.join(' / ')}`);
    return { source: PEPIMS_CONNECTOR, runId: null, status: INTRANSIT_RUN_STATUS.SUCCEEDED, files, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`pepims: NOT read - ${msg} - the latest earlier copies are used`);
    return { source: PEPIMS_CONNECTOR, runId: null, status: INTRANSIT_RUN_STATUS.FAILED, files, error: msg.slice(0, ERROR_MAX) };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Step 1 of a fetch-first build: each source still not of the day is fetched for it (a fetch of that source already
 * queued or running is waited for first, and counts if it brought the files). A failure is logged and the build goes
 * on with the earlier copies.
 */
const fetchFirst = async (run: IntransitRun, steps: FetchStep[], log: (line: string) => void, setStep: (step: string) => Promise<void>): Promise<Fetched[]> => {
  const asOf = run.asOf as string;
  const out: Fetched[] = [];
  const byName = ((run.options ?? {}) as { byName?: string | null }).byName ?? null;
  for (const planned of steps) {
    const src = planned.source;
    await setStep(`fetching ${src}`);
    if (chains.has(src)) await chains.get(src); // a fetch of this source started by hand: wait for it
    const still = (await dayPlan(asOf)).build.toFetch.find((s) => s.source === src);
    if (!still) {
      log(`${src}: already fetched for ${asOf}`);
      out.push({ source: src, runId: null, status: 'already fetched', files: planned.files, error: null });
      continue;
    }
    log(`${src}: fetching ${still.files.join(', ')} for ${asOf} ...`);
    let crun: IntransitRun;
    try {
      crun = await queueConnector(src, { id: run.createdBy, name: byName }, optionsForDate(src, { only: still.only }, asOf));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${src}: NOT fetched - ${msg}`);
      out.push({ source: src, runId: null, status: INTRANSIT_RUN_STATUS.FAILED, files: still.files, error: msg });
      continue;
    }
    forwards.set(crun.id, (line) => log(`  [${src}] ${line}`));
    await chains.get(src);
    forwards.delete(crun.id);
    const done = await repo().findOneBy({ id: crun.id });
    const ok = done?.status === INTRANSIT_RUN_STATUS.SUCCEEDED;
    log(ok ? `${src}: fetched (run ${crun.id})` : `${src}: fetch failed (run ${crun.id}): ${done?.error ?? 'unknown'} - the earlier copies are used`);
    out.push({ source: src, runId: crun.id, status: done?.status ?? INTRANSIT_RUN_STATUS.FAILED, files: still.files, error: ok ? null : (done?.error ?? null) });
  }
  return out;
};

const execute = async (id: string): Promise<void> => {
  const run = await repo().findOneBy({ id });
  if (!run || run.status !== INTRANSIT_RUN_STATUS.QUEUED) return;
  const lines: string[] = [];
  let dirty = false;
  const flush = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    await repo().update({ id }, { log: lines.join('\n') });
  };
  // a report's step and last line, saved with the log (options.step / options.progress)
  const options = { ...(run.options ?? {}) } as Record<string, unknown>;
  let optionsDirty = false;
  const flushAll = async (): Promise<void> => {
    if (optionsDirty) {
      optionsDirty = false;
      await repo().update({ id }, { options: { ...options } as QueryDeepPartialEntity<IntransitRun>['options'] });
    }
    await flush();
  };
  let beat = 0;
  const timer = setInterval(() => {
    // the heartbeat: another machine fails this run only once it has gone quiet (see expireStaleRuns)
    if (Date.now() - beat > HEARTBEAT_MS) {
      beat = Date.now();
      options.heartbeatAt = new Date().toISOString();
      optionsDirty = true;
    }
    void flushAll().catch(() => undefined);
  }, LOG_FLUSH_MS);
  const onLog = (line: string): void => {
    lines.push(line);
    dirty = true;
    forwards.get(id)?.(line);
    if (run.kind === INTRANSIT_RUN_KIND.REPORT) {
      options.progress = line.trim().slice(0, 300);
      optionsDirty = true;
    }
  };
  const setStep = async (step: string): Promise<void> => {
    options.step = step;
    const lc = logContext();
    if (lc) lc.step = step; // the log lines and "server blocked" lines name the run's step (2026-10-27)
    optionsDirty = true;
    await flushAll();
  };
  const stored = storageOn();
  const startedAt = new Date();
  // S3: a build's folder is named by its start (user, 2026-10-26: every build of a day kept, timestamped)
  if (stored && run.kind === INTRANSIT_RUN_KIND.REPORT) options.folder = buildFolderName(startedAt, id);
  await repo().update({ id }, { status: INTRANSIT_RUN_STATUS.RUNNING, startedAt, options: { ...options } as QueryDeepPartialEntity<IntransitRun>['options'] });
  run.options = { ...options };
  run.startedAt = startedAt;

  /** Set when a job's work is done but saving its files failed (not just S3 down: that queues them): folder kept. */
  let keepJob = false;
  /** Store a finished job's files; on failure keep the job folder (never lose a built workbook) and say where it is. */
  const storeOrKeep = async <T>(what: string, step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      keepJob = true;
      await markJobKept(id, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      throw new Error(`${what} done, but not saved to S3 (${err instanceof Error ? err.message : err}); its files are kept in ${jobDir(id)} on ${env.intransit.hostId}`);
    }
  };
  try {
    if (run.kind === INTRANSIT_RUN_KIND.REPORT) {
      // S3: the build works in a temporary folder (emptied at the end), its files then kept in S3
      const dir = stored ? jobDir(id) : runDir(id);
      const steps = (options.toFetch ?? []) as FetchStep[];
      const pepims = await readPepims(run, onLog, setStep);
      const fetched = [...(pepims ? [pepims] : []), ...(options.fetchFirst && steps.length ? await fetchFirst(run, steps, onLog, setStep) : [])];
      await setStep('building');
      const snap = stored ? await snapshotFromStore(run.asOf as string, path.join(dir, 'input')) : null;
      const inputsUsed = snap ? snap.used : await snapshotInputs(dir, run.asOf as string);
      if (inputsUsed.earlier.length) onLog(`earlier copies used: ${inputsUsed.earlier.map((e) => `${e.name} (${e.date})`).join(', ')}`);
      const caches = stored ? path.join(dir, 'cache') : cacheDir();
      const loaded = stored ? await cachesIn(caches) : null;
      const combo = { uniware: missingConnectorKeys(INTRANSIT_SOURCE.UNIWARE).length ? null : env.intransit.uniware, cacheDir: caches };
      // every sheet as its own gzipped CSV too (previews read one sheet; the Daily Snapshot takes three of them)
      const result = (await runInWorker({
        kind: 'report', settings: reportSettings(dir, run.asOf as string, (run.options?.fromDate as string | null | undefined) ?? null), combo, sheets: true,
      }, env.intransit.runTimeoutMs, onLog)) as PipelineResult & { comboCheck?: ComboCheckResult };
      let reportPath = relReportPath(result.reportPath);
      let files: Record<string, string> | null = null;
      if (stored) {
        await setStep('saving to S3');
        const published = await storeOrKeep('the build', async () => {
          if (loaded) await cachesOut(caches, loaded);
          return publishBuild(run, dir);
        });
        reportPath = published.report ? `s3:${published.report}` : null;
        files = published.files;
        onLog(`saved to S3${published.queued ? ` (${published.queued} file(s) queued: S3 unreachable, sent when it is back)` : ''}${published.final ? '; the final build of the day' : ''}`);
        forgetSnapshotDays();
      }
      options.step = 'done';
      optionsDirty = true;
      await flushAll();
      await repo().update({ id }, {
        status: INTRANSIT_RUN_STATUS.SUCCEEDED,
        finishedAt: new Date(),
        timings: result.timings,
        summary: result.summary as QueryDeepPartialEntity<IntransitRun>['summary'],
        sheetRows: result.sheetRows,
        reportPath,
        result: {
          comboCheck: result.comboCheck ?? null, inputsUsed, fetched, ...(snap ? { inputs: snap.inputsUsed, template: snap.template, files } : {}),
        } as unknown as QueryDeepPartialEntity<IntransitRun>['result'],
      });
      // the week's and month's copies follow the newest build (live server)
      if (stored) void touchPeriods(run.asOf as string).catch((err) => logError(LOG_SOURCE.APP, `[intransit] run ${id}: weekly/monthly copies not made`, err));
    } else {
      const opts = (run.options ?? {}) as ConnectorOptions;
      const day = checkDate(opts.date ?? run.asOf ?? undefined);
      // the day's Shipment_Status.csv (Amazon GRN reads it) in the job's own folder: from S3, or from the disk copy
      const inputDir = stored ? await prepareConnector(run, day) : await diskShipmentStatus(run.id, day);
      const exportTo = stored ? path.join(jobDir(id), 'export') : exportDir(run.kind, id);
      const caches = stored ? path.join(jobDir(id), 'cache') : cacheDir();
      const loaded = stored ? await cachesIn(caches) : null;
      const job: WorkerJob = {
        kind: run.kind,
        config: await connectorConfig(),
        dirs: { targetDir: stored ? null : dailyDir(day), mastersDir: inputDir, exportDir: exportTo, cacheDir: caches },
        options: opts,
      };
      const started = Date.now();
      const result = (await runInWorker(job, env.intransit.connectorTimeoutMs, onLog)) as ConnectorResult;
      if (stored) {
        const keys = await storeOrKeep('the fetch', async () => {
          if (loaded) await cachesOut(caches, loaded);
          return storeConnectorFiles(run, exportTo, result, day);
        });
        (result as ConnectorResult & { files?: Record<string, string> }).files = keys;
      }
      await flushAll();
      const rejected = Object.keys(result.rejected);
      await repo().update({ id }, {
        status: rejected.length && !result.saved.length ? INTRANSIT_RUN_STATUS.FAILED : INTRANSIT_RUN_STATUS.SUCCEEDED,
        error: rejected.length ? `not used (failed the column check): ${rejected.join(', ')}` : null,
        finishedAt: new Date(),
        timings: { total: Math.round((Date.now() - started) / 10) / 100 },
        result: result as unknown as QueryDeepPartialEntity<IntransitRun>['result'],
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`ERROR ${message}`);
    dirty = true;
    await flushAll().catch(() => undefined);
    await repo().update({ id }, { status: INTRANSIT_RUN_STATUS.FAILED, finishedAt: new Date(), error: message.slice(0, ERROR_MAX) });
  } finally {
    clearInterval(timer);
    if (run.kind === INTRANSIT_RUN_KIND.REPORT) await fsp.rm(path.join(runDir(id), 'input'), { recursive: true, force: true }).catch(() => undefined);
    await closeRun(id).catch((err) => logError(LOG_SOURCE.APP, `[intransit] run ${id}: run.json not written`, err));
    // nothing of a job stays on the server (S3 store), unless its files could not be saved (nor queued)
    if (!keepJob) await fsp.rm(jobDir(id), { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Disk store: the day's Shipment_Status.csv copied into the job's folder (it is a daily file, not a master). */
const diskShipmentStatus = async (id: string, day: string): Promise<string> => {
  const dir = path.join(jobDir(id), 'input');
  await fsp.mkdir(dir, { recursive: true });
  const ss = (await resolveInputs(day)).files.find((f) => f.name === 'Shipment_Status.csv');
  if (ss) await fsp.copyFile(ss.path, path.join(dir, ss.name));
  return dir;
};

/** A run has ended: its run.json, beside its files (disk) or in its Full Report folder (S3; builds only). */
const closeRun = async (id: string): Promise<void> => {
  const run = await repo().findOne({ where: { id }, relations: { creator: true } });
  if (!run) return;
  if (storageOn()) await storeRunJson(run);
  else await writeRunRecord(run, filesDirOf(run));
};

/** This machine's runs (or older runs that name no machine): the only ones its restart may close. */
const ownRun = (r: IntransitRun): boolean => {
  const host = ((r.options ?? {}) as { host?: string }).host;
  return !host || host === env.intransit.hostId;
};

/**
 * At server start: this machine's jobs that were queued or running when it stopped will never finish; mark them
 * failed (with their run.json). Another machine's running jobs are left alone - machines share the database.
 */
export const recoverRuns = async (): Promise<number> => {
  const stuck = (await repo().find({ where: { status: In([INTRANSIT_RUN_STATUS.QUEUED, INTRANSIT_RUN_STATUS.RUNNING]) } })).filter(ownRun);
  if (!stuck.length) return 0;
  await repo().update({ id: In(stuck.map((r) => r.id)) }, { status: INTRANSIT_RUN_STATUS.FAILED, finishedAt: new Date(), error: INTRANSIT_RESTART_ERROR });
  for (const r of stuck) await closeRun(r.id).catch(() => undefined);
  return stuck.length;
};

/**
 * Another machine's runs that stay queued/running with no heartbeat for STALE_RUN_MS: that machine stopped (machines
 * share the database), so they are failed here. Runs from before the heartbeat existed are left alone.
 */
export const expireStaleRuns = async (): Promise<number> => {
  const now = Date.now();
  const stale = (await repo().find({ where: { status: In([INTRANSIT_RUN_STATUS.QUEUED, INTRANSIT_RUN_STATUS.RUNNING]) } })).filter((r) => {
    if (ownRun(r)) return false;
    const beatAt = ((r.options ?? {}) as { heartbeatAt?: string }).heartbeatAt;
    return !!beatAt && now - Date.parse(beatAt) > STALE_RUN_MS;
  });
  if (!stale.length) return 0;
  await repo().update({ id: In(stale.map((r) => r.id)) }, { status: INTRANSIT_RUN_STATUS.FAILED, finishedAt: new Date(), error: 'The machine running it stopped answering; start it again.' });
  return stale.length;
};

// ---- Inventory Calculation -------------------------------------------------------------------------------------

export interface InventoryView extends InventorySnapshot {
  /** The report run the figures come from; null when no report has been built yet. */
  runId: string | null;
  asOf: string | null;
  builtAt: Date | null;
}

let inventoryCache: { runId: string; view: InventoryView } | null = null;

/**
 * SOH + in-transit of the latest succeeded report (cached per run). Empty rows when none has been built. Disk store
 * only (until the move, plan phase S5): with the S3 store the page reads the Daily Snapshot (GET /intransit/snapshot).
 */
export const latestInventory = async (): Promise<InventoryView> => {
  const runs = storageOn() ? [] : await repo().find({
    where: { kind: INTRANSIT_RUN_KIND.REPORT, status: INTRANSIT_RUN_STATUS.SUCCEEDED },
    order: { id: 'DESC' },
    take: 10,
  });
  for (const run of runs.filter((r) => scopeOfRun(r) === PROD_SCOPE)) {
    if (inventoryCache?.runId === run.id) return inventoryCache.view;
    // the disk store has inventory.json beside the workbook
    const file = path.join(runDir(run.id), INTRANSIT_INVENTORY_FILE);
    if (!fs.existsSync(file)) continue; // built before snapshots existed, or its folder was removed
    const text = await fsp.readFile(file, 'utf8');
    const snap = JSON.parse(text) as InventorySnapshot;
    const view: InventoryView = { ...snap, runId: run.id, asOf: run.asOf, builtAt: run.finishedAt };
    inventoryCache = { runId: run.id, view };
    return view;
  }
  return { columns: INVENTORY_COLUMNS, rows: [], runId: null, asOf: null, builtAt: null };
};
