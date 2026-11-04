import { fork } from 'child_process';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  blockingMissing,
  CHANNEL_PULLS,
  COMBO_CHECK,
  ERROR_CODES,
  errorMessage,
  type FacilityGroups,
  type FacilityStock,
  INPUT_BY_NAME,
  INTRANSIT_FOLDERS,
  INTRANSIT_INVENTORY_FILE,
  INTRANSIT_LOG_TAIL_LINES,
  INTRANSIT_REPORT_NAME,
  INTRANSIT_RESTART_ERROR,
  INTRANSIT_RUN_KIND,
  INTRANSIT_RUN_STATUS,
  INTRANSIT_SOURCE,
  INTRANSIT_STEP,
  INTRANSIT_TEMPLATE_NAME,
  INPUT_CATALOG,
  INPUTS_BOOK_FILE,
  IntransitRunKind,
  IntransitSource,
  PEPIMS_CONNECTOR,
  RUN_EXTRA_FILES,
  D2C_TRANSFERS_CONNECTOR,
  D2C_TRANSFERS_FILE,
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
  storeTransferFeed,
  unpublishRun,
} from './s3/run-store';
import { PROD_SCOPE, storageOn, visibleScopes, writeScope } from './s3/scope';
import { forgetSnapshotDays } from './s3/snapshot';
import { checkDate, dailyDir, diskSource, FetchStep, istToday, moveToDeleted, planDay, resolveInputs, writeWithMeta } from './input-store';
import { writeRunRecord } from './run-record';
import { INVENTORY_COLUMNS, InventorySnapshot } from './inventory-snapshot';
import { exportMastersFromDb } from './masters-export';
import type { BookInput } from './inputs-book';
import type { NewSku } from './sku-fill';
import { applyIssueAnswers, IssueAnswer, reviewSettings, saveSkuFills } from './sku-review';
import { PipelineResult } from './pipeline';
import type { WorkerJob, WorkerMessage } from './run-worker';
import { AMAZON_KEYS } from './sources/amazon';
import { FLIPKART_KEYS, usesSellerHub } from './sources/flipkart';
import { SELLER_HUB_KEYS } from './sources/flipkart-seller-hub';
import { MYNTRA_KEYS } from './sources/myntra-partner-portal';
import { fetchPepimsTracker, PEPIMS_FILES } from './sources/pepims';
import { writeTransferFeed } from '../d2c-transfers/intransit-feed';
import { UNIWARE_KEYS } from './sources/uniware';
import { facilityGroups, facilityStock, uniwareConfig } from './uniware-facilities';
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
/**
 * A portal or API is asked again only this long after its last fetch on this server ended (user, 2026-10-29: fetches
 * of the same source back to back - GRN only, then SOH only - failed with errors and network failures).
 */
const SOURCE_COOLDOWN_MS = 60_000;
/** When each source's last fetch ended on this server (for SOURCE_COOLDOWN_MS). */
const fetchEnded = new Map<string, number>();
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
  /** Who pressed Stop (stopped, or stopping while it finishes its step). */
  stoppedBy: { id: number; name: string } | null;
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
  stoppedBy: r.stopper ? { id: r.stopper.id, name: r.stopper.name } : null,
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

const RELATIONS = { creator: true, stopper: true } as const;

const findRun = async (id: string): Promise<IntransitRun> => {
  const run = /^\d+$/.test(id) ? await repo().findOne({ where: { id }, relations: RELATIONS }) : null;
  if (!run) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_FOUND, id);
  return run;
};

export const listRuns = async (kind?: string, limit = 50): Promise<RunView[]> => {
  const where = kind && (Object.values(INTRANSIT_RUN_KIND) as string[]).includes(kind) ? { kind: kind as IntransitRunKind } : {};
  const rows = await repo().find({ where, relations: RELATIONS, order: { id: 'DESC' }, take: limit * 4 });
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
  if (run.kind === INTRANSIT_RUN_KIND.REPORT) names.splice(0, names.length, COMBO_CHECK.ALERT_FILE, COMBO_CHECK.SPLIT1_ROWS_FILE, ...RUN_EXTRA_FILES);
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
    const deleted = (await repo().findOne({ where: { id }, relations: RELATIONS })) as IntransitRun;
    await unpublishRun(deleted);
    forgetSnapshotDays();
    if (deleted.asOf && deleted.kind === INTRANSIT_RUN_KIND.REPORT) void touchPeriods(deleted.asOf).catch((err) => logError(LOG_SOURCE.APP, `[intransit] run ${id} deleted: weekly/monthly copies not redone`, err));
    return;
  }
  {
    // the disk store deletes only its own runs: their files are on this disk. Another machine's run - above all an S3
    // run of the live server (it names a scope) - is never hard-deleted from the shared database here (review, 2026-10-27)
    const o = (run.options ?? {}) as { host?: string; scope?: string };
    if (o.scope || !ownRun(run)) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_HERE, id, o.host ?? (o.scope ? `the ${o.scope} S3 store` : 'another machine'));
    // kept under _deleted/ with its run.json (user, 2026-10-22: keep everything), the row removed from the page
    const dir = filesDirOf(run);
    await writeRunRecord(run, dir);
    await moveToDeleted(dir);
    await repo().delete({ id });
  }
};

// ---- starting jobs ---------------------------------------------------------------------------------------------

const chains = new Map<string, Promise<void>>();

// ---- stopping (user, 2026-11-02) --------------------------------------------------------------------------------

/** A job stopped from the page (or a build nobody answered the new-SKU question for); its message is the reason. */
export class StoppedError extends Error {}

/**
 * What stops a job running on this machine: its abort signal (its worker gets SIGTERM, every wait ends), whether it is
 * past the point of no return (saving its files: a stop then is ignored), and the fetch a build waits for.
 */
interface Control {
  ac: AbortController;
  committed: boolean;
  waitingFor: string | null;
}
const controls = new Map<string, Control>();

/** `p`, or the stop when the job is stopped first. */
const raceStop = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  raceStop(new Promise<void>((resolve) => setTimeout(resolve, ms).unref()), signal);

const stoppedBy = (name: string | null): string => `Stopped by ${name ?? 'someone'}`;

/** Who asked to stop a run, when someone did (the signal from another machine). */
const stopRequest = async (id: string): Promise<{ by: number; name: string | null } | null> => {
  const [row] = (await repo().query(
    `SELECT r.stop_requested_by AS byId, u.name AS name FROM intransit_runs r LEFT JOIN users u ON u.id = r.stop_requested_by WHERE r.id = ? AND r.stop_requested_by IS NOT NULL`, [id])) as { byId: number; name: string | null }[];
  return row ? { by: row.byId, name: row.name } : null;
};

/** A local job waiting on fetches of `source` is stopped too (user: stopping a fetch a build waits for stops the build). */
const stopWaitingBuilds = (source: string, who: Requester): void => {
  for (const c of controls.values()) {
    if (c.waitingFor === source && !c.committed) c.ac.abort(new StoppedError(`${stoppedBy(who.name)}: the ${source} fetch it waited for was stopped`));
  }
};

/**
 * Stop a queued or running job (POST /runs/:id/stop). A queued one is stopped at once; a running one is asked to stop
 * (its machine stops it within seconds, then it is "stopped"), unless it is already saving its files - then it ends as
 * it would have. A build waiting for this fetch stops with it.
 */
export const stopRun = async (id: string, who: Requester, reason?: string): Promise<RunView> => {
  let run = await findRun(id);
  if (run.status === INTRANSIT_RUN_STATUS.QUEUED) {
    const res = await repo().update({ id, status: INTRANSIT_RUN_STATUS.QUEUED }, {
      status: INTRANSIT_RUN_STATUS.STOPPED, stopRequestedBy: who.id, finishedAt: new Date(), error: (reason ?? stoppedBy(who.name)).slice(0, ERROR_MAX),
    });
    if (res.affected) {
      waitingHere.delete(id);
      if (run.kind !== INTRANSIT_RUN_KIND.REPORT) stopWaitingBuilds(run.kind, who);
      await closeRun(id).catch(() => undefined);
      return getRun(id);
    }
    run = await findRun(id); // it started meanwhile
  }
  if (run.status !== INTRANSIT_RUN_STATUS.RUNNING) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_STOPPABLE, id, run.status);
  await repo().update({ id, status: INTRANSIT_RUN_STATUS.RUNNING }, { stopRequestedBy: who.id });
  const c = controls.get(id);
  if (c && !c.committed) c.ac.abort(new StoppedError(reason ?? stoppedBy(who.name)));
  if (run.kind !== INTRANSIT_RUN_KIND.REPORT) stopWaitingBuilds(run.kind, who);
  return getRun(id);
};

/** Runs queued here that have not started yet: they get a heartbeat too, while they wait their turn. */
const waitingHere = new Set<string>();
let queuedBeat: NodeJS.Timeout | null = null;

/**
 * The heartbeat of this machine's queued runs (a running one beats from execute). Without it a run queued when its
 * machine stopped had no sign of life at all, so no other machine ever failed it - and every new Docker container is
 * another machine (its hostname is new), so after a redeploy that source answered "already running" for good (review,
 * 2026-10-27).
 */
const beatQueued = async (): Promise<void> => {
  if (!waitingHere.size) return;
  await repo().query(
    `UPDATE intransit_runs SET options = JSON_SET(COALESCE(options, JSON_OBJECT()), '$.heartbeatAt', ?) WHERE status = ? AND id IN (${[...waitingHere].map(() => '?').join(',')})`,
    [new Date().toISOString(), INTRANSIT_RUN_STATUS.QUEUED, ...waitingHere],
  );
};

/**
 * Runs job `id` after every earlier job of the same lane (report, or one connector source), as its own logged job
 * (2026-10-27): JOB_START / DONE / FAILED, and named with its step on "server blocked" lines.
 */
const enqueue = (lane: string, id: string): void => {
  waitingHere.add(id);
  queuedBeat ??= setInterval(() => void beatQueued().catch(() => undefined), HEARTBEAT_MS).unref();
  const next = (chains.get(lane) ?? Promise.resolve())
    .then(() => {
      waitingHere.delete(id);
      return runJob(`intransit-${lane}`, () => execute(id), { runId: id });
    })
    .catch((err) => void logError(LOG_SOURCE.APP, `[intransit] ${lane} job failed`, err));
  chains.set(lane, next);
};

const reportSettings = (
  dir: string, asOf: string, fromDate: string | null, groups: FacilityGroups, stock: Record<string, FacilityStock>,
): IntransitSettings => ({
  inputDir: path.join(dir, 'input'),
  templateXlsx: path.join(dir, 'input', INTRANSIT_TEMPLATE_NAME),
  outputDir: dir,
  asOf,
  fromDate,
  facilityGroups: groups,
  facilityStock: stock,
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
  enqueue(INTRANSIT_RUN_KIND.REPORT, run.id);
  return getRun(run.id);
};

/** The connectors' settings; Uniware's facilities come from master_facilities.uniware_export (user, 2026-10-26). */
const connectorConfig = async (): Promise<ConnectorConfig> => ({
  amazon: env.intransit.amazon,
  flipkart: env.intransit.flipkart,
  myntra: env.intransit.myntra,
  uniware: await uniwareConfig(),
});

/** The .env keys a source still needs (empty = configured). */
export const missingConnectorKeys = (source: IntransitSource): string[] => {
  const { amazon, flipkart, myntra, uniware } = env.intransit;
  const keys: Record<IntransitSource, [string[], unknown[]]> = {
    amazon: [AMAZON_KEYS, [amazon.clientId, amazon.clientSecret, amazon.refreshToken]],
    // the Seller Hub robot once its user is set, else the Seller API
    flipkart: usesSellerHub(flipkart)
      ? [SELLER_HUB_KEYS, [flipkart.sellerHub.user, flipkart.sellerHub.password]]
      : [FLIPKART_KEYS, [flipkart.appId, flipkart.appSecret]],
    myntra: [MYNTRA_KEYS, [myntra.user, myntra.password]],
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
  enqueue(src, run.id);
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
  (await repo().find({ where: { status: In([INTRANSIT_RUN_STATUS.QUEUED, INTRANSIT_RUN_STATUS.RUNNING]) }, relations: RELATIONS, order: { id: 'ASC' } }))
    .filter(visibleRun).map((r) => view(r));

/** The newest report run of a day (any status) this machine sees - its own first - or null. */
export const latestReportOf = async (date: string): Promise<RunView | null> => {
  const rows = (await repo().find({ where: { kind: INTRANSIT_RUN_KIND.REPORT, asOf: date }, relations: RELATIONS, order: { id: 'DESC' } })).filter(visibleRun);
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

/**
 * At most INTRANSIT_MAX_WORKERS child processes at a time (user, 2026-10-27: a build next to a fetch ran the 1 GB server
 * out of memory). A job only holds its place while its child runs, never while it waits on another job, so the report
 * lane waiting on a fetch cannot deadlock.
 */
let workersBusy = 0;
const workerWaiters: (() => void)[] = [];
/** When the last worker job ended (2026-11-04, load: robots spaced out, ROBOT_GAP). */
let lastWorkerEnd = 0;
/** How long a job asking for `gapMs` still has to wait after the last job ended. */
export const robotGapWaitMs = (gapMs: number, now = Date.now()): number => Math.max(0, lastWorkerEnd + gapMs - now);
const withWorkerSlot = async <T>(onLog: (line: string) => void, work: () => Promise<T>, signal?: AbortSignal, gapMs = 0): Promise<T> => {
  signal?.throwIfAborted();
  if (workersBusy >= env.intransit.maxWorkers) {
    onLog('waiting for another in-transit job to finish (one at a time on this server) ...');
    // stopped while waiting: it leaves the line (it never had a place to give back)
    await new Promise<void>((resolve, reject) => {
      const go = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const i = workerWaiters.indexOf(go);
        if (i >= 0) workerWaiters.splice(i, 1);
        reject(signal?.reason);
      };
      workerWaiters.push(go);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } else workersBusy++;
  try {
    // a browser robot right after another job: a short pause first (the server catches its breath; no two browsers
    // back to back). The place is kept meanwhile, so nothing else slips in.
    const wait = robotGapWaitMs(gapMs);
    if (wait > 0) {
      onLog(`spacing robots: starting in ${Math.ceil(wait / 1000)} s (another job just ended)`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return await work();
  } finally {
    lastWorkerEnd = Date.now();
    // hand the place straight to the next waiter, else free it
    const next = workerWaiters.shift();
    if (next) next();
    else workersBusy--;
  }
};

/** Fork run-worker with the job (when a place is free); resolves with its result (or rejects with its error). */
const runInWorker = (job: WorkerJob, timeoutMs: number, onLog: (line: string) => void, signal?: AbortSignal, gapMs = 0): Promise<unknown> =>
  withWorkerSlot(onLog, () => forkWorker(job, timeoutMs, onLog, signal), signal, gapMs);

/** A stopped worker gets this long to close what it opened (browsers, Xvfb) before it is killed. */
const STOP_GRACE_MS = 10_000;

/** Fork run-worker with the job; resolves with its result (or rejects with its error). Logs go to onLog. */
const forkWorker = (job: WorkerJob, timeoutMs: number, onLog: (line: string) => void, signal?: AbortSignal): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const ext = path.extname(__filename); // .ts under ts-node(-dev), .js from dist
    const child = fork(path.join(__dirname, `run-worker${ext}`), [], {
      execArgv: [...(ext === '.ts' ? ['-r', 'ts-node/register/transpile-only'] : []), `--max-old-space-size=${env.intransit.workerMaxMemoryMb}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    // lower priority (Linux "nice"; inherited by the browser it starts): the API keeps the CPU it needs
    if (child.pid && env.intransit.workerNice) {
      try {
        os.setPriority(child.pid, env.intransit.workerNice);
      } catch (err) {
        onLog(`(job priority not lowered: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    let settled = false;
    let stopping = false;
    const onAbort = (): void => {
      // Stop: SIGTERM lets it close its browser first; the job ends once the worker has exited
      stopping = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (stopping) reject(signal?.reason);
      else if (err) reject(err);
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
    // V8 aborts (exit 134 / SIGABRT) when the heap limit is reached
    child.on('exit', (code, signal) => finish(new Error(code === 134 || signal === 'SIGABRT'
      ? `the worker ran out of memory (INTRANSIT_WORKER_MAX_MEMORY_MB=${env.intransit.workerMaxMemoryMb}) before finishing`
      : `the worker stopped (${signal ?? `exit ${code}`}) before finishing`)));
    child.send(job);
  });

/**
 * A Seller Hub job of another module (the Flipkart consignments robot, channel-api/flipkart; 2026-10-30): the same worker
 * slot (one browser job at a time on this server), the same child process (low priority) and the same saved login
 * (the caches, as a connector run gets them), so the two Seller Hub robots never run together or log in twice.
 */
export const runSellerHubJob = async <T>(name: string, makeJob: (cacheDir: string) => WorkerJob, timeoutMs: number, onLog: (line: string) => void): Promise<T> => {
  const stored = storageOn();
  const dir = stored ? path.join(DIR(), INTRANSIT_FOLDERS.CACHE, 'jobs', `${name}-${Date.now()}`) : cacheDir();
  const loaded = stored ? await cachesIn(dir) : null;
  try {
    // our browser robots (Flipkart consignments, Myntra STRs) keep ROBOT_GAP after the last worker job (2026-11-04)
    return (await runInWorker(makeJob(dir), timeoutMs, onLog, undefined, robotGapMs())) as T;
  } finally {
    if (loaded) {
      await cachesOut(dir, loaded).catch((err: unknown) => onLog(`(the saved login was not stored back: ${err instanceof Error ? err.message : String(err)})`));
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
};
/** The gap between browser robots: ROBOT_GAP_SECONDS, else CHANNEL_PULLS.ROBOT_GAP_MS (2 min). */
const robotGapMs = (): number => {
  const s = Number(process.env.ROBOT_GAP_SECONDS);
  return Number.isFinite(s) && process.env.ROBOT_GAP_SECONDS !== undefined && process.env.ROBOT_GAP_SECONDS !== '' ? Math.max(0, s) * 1000 : CHANNEL_PULLS.ROBOT_GAP_MS;
};

/** A connector run's log lines, forwarded to the report run that started it. */
const forwards = new Map<string, (line: string) => void>();

/** Copy the day's inputs into the run's folder (a consistent snapshot); returns what was used. */
const snapshotInputs = async (dir: string, asOf: string) => {
  const into = path.join(dir, 'input');
  await fsp.mkdir(into, { recursive: true });
  const { files, missing: allMissing } = await resolveInputs(asOf);
  const missing = blockingMissing(allMissing);
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

type Fetched = { source: IntransitSource | typeof PEPIMS_CONNECTOR | typeof D2C_TRANSFERS_CONNECTOR; runId: string | null; status: string; files: string[]; error: string | null };

/**
 * Step 0 of a build for today when INTRANSIT_PO_SOURCE=pepims (user, 2026-10-23): Shipment_Status / PO_Format read
 * from PEPIMS (last PEPIMS_TRACKER_DAYS days, sources/pepims.ts), checked like an upload, and saved as the day's files.
 * A past day keeps its own (or the latest earlier) copy: PEPIMS only holds today's statuses. On failure the build goes
 * on with the latest earlier copies (logged; none at all -> the snapshot step stops the build with the reason).
 */
const readPepims = async (run: IntransitRun, log: (line: string) => void, setStep: (step: string) => Promise<void>, signal: AbortSignal): Promise<Fetched | null> => {
  const asOf = run.asOf as string;
  if (env.intransit.poSource !== 'pepims' || asOf !== istToday()) return null;
  await setStep(`fetching ${PEPIMS_CONNECTOR}`);
  const tmp = storageOn() ? path.join(jobDir(run.id), 'pepims') : exportDir(PEPIMS_CONNECTOR, run.id);
  const files: string[] = [];
  try {
    // read in this process: a stop ends the wait, and nothing read is saved after it
    const r = await raceStop(fetchPepimsTracker(env.db, tmp, asOf, log), signal);
    const byName = ((run.options ?? {}) as { byName?: string | null }).byName ?? null;
    for (const name of r.files) {
      const raw = new Uint8Array(await fsp.readFile(path.join(tmp, name)));
      const problems = validateInput(name, raw);
      if (problems.length) throw new Error(`${name} from PEPIMS failed the column check: ${problems.join('; ')}`);
      if (!storageOn()) await writeWithMeta(path.join(dailyDir(asOf), name), raw, { by: run.createdBy, byName, source: PEPIMS_CONNECTOR });
      files.push(name);
    }
    // S3: PEPIMS' files become the day's inputs
    signal.throwIfAborted();
    if (storageOn()) await storePepimsFiles(run, tmp, files, asOf);
    log(`pepims: ${r.pos} POs, ${r.lines} lines (Entry Date ${r.from} .. ${r.to}) are the day's ${r.files.join(' / ')}`);
    return { source: PEPIMS_CONNECTOR, runId: null, status: INTRANSIT_RUN_STATUS.SUCCEEDED, files, error: null };
  } catch (err) {
    if (err instanceof StoppedError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log(`pepims: NOT read - ${msg} - the latest earlier copies are used`);
    return { source: PEPIMS_CONNECTOR, runId: null, status: INTRANSIT_RUN_STATUS.FAILED, files, error: msg.slice(0, ERROR_MAX) };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Step 0b of a build for today, whatever INTRANSIT_PO_SOURCE is (phase 8, plan d2c-internal-transfers 7.2): our own D2C
 * transfers written as D2C_Transfers.csv (modules/d2c-transfers/intransit-feed.ts) and saved as the day's file, so a
 * past build replays the stored copy (a past day never re-reads our tables; no copy = no transfer rows). On failure the
 * build goes on with the latest earlier copy, if any (logged).
 */
const readTransfers = async (run: IntransitRun, log: (line: string) => void, setStep: (step: string) => Promise<void>, signal: AbortSignal): Promise<Fetched | null> => {
  const asOf = run.asOf as string;
  if (asOf !== istToday() || !AppDataSource.isInitialized) return null;
  await setStep(`fetching ${D2C_TRANSFERS_CONNECTOR}`);
  const tmp = storageOn() ? path.join(jobDir(run.id), D2C_TRANSFERS_CONNECTOR) : exportDir(D2C_TRANSFERS_CONNECTOR, run.id);
  const files: string[] = [];
  try {
    const r = await raceStop(writeTransferFeed(tmp, asOf), signal);
    const raw = new Uint8Array(await fsp.readFile(r.file));
    const problems = validateInput(D2C_TRANSFERS_FILE, raw);
    if (problems.length) throw new Error(`${D2C_TRANSFERS_FILE} failed the column check: ${problems.join('; ')}`);
    signal.throwIfAborted();
    const byName = ((run.options ?? {}) as { byName?: string | null }).byName ?? null;
    if (storageOn()) await storeTransferFeed(run, tmp, D2C_TRANSFERS_FILE, asOf);
    else await writeWithMeta(path.join(dailyDir(asOf), D2C_TRANSFERS_FILE), raw, { by: run.createdBy, byName, source: D2C_TRANSFERS_CONNECTOR });
    files.push(D2C_TRANSFERS_FILE);
    log(`d2c transfers: ${r.transfers} transfer(s), ${r.rows} in-transit row(s), ${r.units} unit(s) are the day's ${D2C_TRANSFERS_FILE}`);
    return { source: D2C_TRANSFERS_CONNECTOR, runId: null, status: INTRANSIT_RUN_STATUS.SUCCEEDED, files, error: null };
  } catch (err) {
    if (err instanceof StoppedError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log(`d2c transfers: NOT written - ${msg} - the latest earlier copy (if any) is used`);
    return { source: D2C_TRANSFERS_CONNECTOR, runId: null, status: INTRANSIT_RUN_STATUS.FAILED, files, error: msg.slice(0, ERROR_MAX) };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** A paused build waits for this (see execute): files uploaded by hand / answers given (done), or Continue (resumed). */
type PauseFor = (pause: Record<string, unknown>, step: string, done?: () => Promise<boolean>) => Promise<'done' | 'resumed'>;

/**
 * Step 1 of a fetch-first build: each source still not of the day is fetched for it (a fetch of that source already
 * queued or running is waited for first, and counts if it brought the files). When a fetch fails or leaves files out,
 * the build waits for them uploaded by hand, or Continue (then it goes on with the earlier copies; user, 2026-11-02).
 */
const fetchFirst = async (
  run: IntransitRun, steps: FetchStep[], log: (line: string) => void, setStep: (step: string) => Promise<void>, control: Control, pauseFor: PauseFor,
): Promise<Fetched[]> => {
  const signal = control.ac.signal;
  const asOf = run.asOf as string;
  const out: Fetched[] = [];
  const byName = ((run.options ?? {}) as { byName?: string | null }).byName ?? null;
  for (const planned of steps) {
    const src = planned.source;
    await setStep(`fetching ${src}`);
    // a fetch of this source started by hand: wait for it (stopping it stops this build too)
    control.waitingFor = src;
    if (chains.has(src)) await raceStop(chains.get(src) as Promise<void>, signal);
    control.waitingFor = null;
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
    control.waitingFor = src;
    try {
      await raceStop(chains.get(src) as Promise<void>, signal);
    } catch (err) {
      // the build was stopped: the fetch it started stops with it
      if (err instanceof StoppedError) await stopRun(crun.id, { id: null, name: null }, `${err.message} (with build ${run.id})`).catch(() => undefined);
      throw err;
    } finally {
      control.waitingFor = null;
      forwards.delete(crun.id);
    }
    const done = await repo().findOne({ where: { id: crun.id }, relations: RELATIONS });
    if (done?.status === INTRANSIT_RUN_STATUS.STOPPED) {
      throw new StoppedError(`${stoppedBy(done.stopper?.name ?? null)}: the ${src} fetch was stopped - upload its file by hand, then build again`);
    }
    let ok = done?.status === INTRANSIT_RUN_STATUS.SUCCEEDED;
    let error = ok ? null : (done?.error ?? null);
    // the files it did not bring (failed, not fetched, refused by the column check): upload them by hand, or go on
    const notOfDay = async (): Promise<string[]> => ((await dayPlan(asOf)).build.toFetch.find((s) => s.source === src)?.files ?? []).filter((f) => still.files.includes(f));
    const left = await notOfDay();
    if (left.length) {
      log(`${src}: ${ok ? 'fetched without' : `fetch failed (run ${crun.id}): ${done?.error ?? 'unknown'} - no`} ${left.join(', ')} for ${asOf}: waiting for them uploaded by hand, or Continue`);
      const how = await pauseFor({ kind: 'upload', source: src, files: left, error: done?.error ?? null, fetchRun: crun.id }, INTRANSIT_STEP.AWAITING_UPLOAD, async () => !(await notOfDay()).length);
      if (how === 'done') {
        log(`${src}: ${left.join(', ')} uploaded by hand`);
        ok = true;
        error = null;
      } else log(`${src}: continuing with the earlier copies of ${left.join(', ')}`);
      await setStep(`fetching ${src}`);
    } else log(ok ? `${src}: fetched (run ${crun.id})` : `${src}: fetch failed (run ${crun.id}) but the day's files are in`);
    out.push({ source: src, runId: crun.id, status: ok ? INTRANSIT_RUN_STATUS.SUCCEEDED : (done?.status ?? INTRANSIT_RUN_STATUS.FAILED), files: still.files, error });
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
  // a report's step and last line, saved with the log (options.step / options.progress). Only the keys this job
  // changed are written (JSON_SET), so it never overwrites what another request set meanwhile (review, 2026-11-02).
  const options = { ...(run.options ?? {}) } as Record<string, unknown>;
  const changed = new Set<string>();
  const setOption = (key: string, value: unknown): void => {
    options[key] = value;
    changed.add(key);
  };
  const flushAll = async (): Promise<void> => {
    if (changed.size) {
      const keys = [...changed];
      changed.clear();
      await repo().query(
        `UPDATE intransit_runs SET options = JSON_SET(COALESCE(options, JSON_OBJECT()), ${keys.map(() => '?, CAST(? AS JSON)').join(', ')}) WHERE id = ?`,
        [...keys.flatMap((k) => [`$.${k}`, JSON.stringify(options[k] ?? null)]), id],
      );
    }
    await flush();
  };
  // Stop (user, 2026-11-02): pressed here, the job is aborted at once; pressed on another machine, the request is
  // read here on the next tick
  const control: Control = { ac: new AbortController(), committed: false, waitingFor: null };
  const signal = control.ac.signal;
  let beat = 0;
  const timer = setInterval(() => {
    // the heartbeat: another machine fails this run only once it has gone quiet (see expireStaleRuns)
    if (Date.now() - beat > HEARTBEAT_MS) {
      beat = Date.now();
      setOption('heartbeatAt', new Date().toISOString());
    }
    void flushAll().catch(() => undefined);
    if (!signal.aborted && !control.committed) {
      void stopRequest(id).then((s) => {
        if (s && !signal.aborted && !control.committed) control.ac.abort(new StoppedError(stoppedBy(s.name)));
      }).catch(() => undefined);
    }
  }, LOG_FLUSH_MS);
  const onLog = (line: string): void => {
    lines.push(line);
    dirty = true;
    forwards.get(id)?.(line);
    if (run.kind === INTRANSIT_RUN_KIND.REPORT) setOption('progress', line.trim().slice(0, 300));
  };
  const setStep = async (step: string): Promise<void> => {
    setOption('step', step);
    const lc = logContext();
    if (lc) lc.step = step; // the log lines and "server blocked" lines name the run's step (2026-10-27)
    await flushAll();
  };
  /**
   * Pause a build (user, 2026-11-02): options.pause tells the page what it waits for; it goes on when `done` says so
   * (files uploaded / answered), or when someone presses Continue / sends the answers (options.resume, written by
   * resumeRun on any machine), and stops after INTRANSIT_SKU_WAIT_MS. No worker is held meanwhile.
   */
  const pauseFor: PauseFor = async (pause, step, done) => {
    const until = Date.now() + env.intransit.skuWaitMs;
    setOption('resume', null);
    setOption('pause', { ...pause, answerBy: new Date(until).toISOString() });
    await setStep(step);
    try {
      for (;;) {
        if (done && (await done())) return 'done';
        const [row] = (await repo().query(`SELECT JSON_EXTRACT(options, '$.resume') AS r FROM intransit_runs WHERE id = ?`, [id])) as { r: unknown }[];
        if (row?.r && row.r !== 'null') return 'resumed';
        if (Date.now() > until) throw new StoppedError(`Stopped: nobody answered within ${Math.round(env.intransit.skuWaitMs / 60000)} min - build again when ready`);
        await abortableSleep(PAUSE_POLL_MS, signal);
      }
    } finally {
      setOption('pause', null);
      setOption('resume', null);
      await flushAll().catch(() => undefined);
    }
  };
  /** Past this point a stop is ignored: the job's files are being saved (a built workbook is never half-saved). */
  const commit = (): void => {
    signal.throwIfAborted();
    control.committed = true;
  };
  const stored = storageOn();
  const startedAt = new Date();
  // S3: a build's folder is named by its start (user, 2026-10-26: every build of a day kept, timestamped)
  if (stored && run.kind === INTRANSIT_RUN_KIND.REPORT) options.folder = buildFolderName(startedAt, id);
  // only a run still queued starts (one stopped meanwhile stays stopped)
  const started = await repo().update({ id, status: INTRANSIT_RUN_STATUS.QUEUED }, { status: INTRANSIT_RUN_STATUS.RUNNING, startedAt, options: { ...options } as QueryDeepPartialEntity<IntransitRun>['options'] });
  if (!started.affected) {
    clearInterval(timer);
    return;
  }
  controls.set(id, control);
  run.options = { ...options };
  run.startedAt = startedAt;
  const who = { id: run.createdBy, name: ((run.options ?? {}) as { byName?: string | null }).byName ?? null };

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
  /** The final status, written only while the run is still running (review, 2026-11-02). */
  const finish = (set: QueryDeepPartialEntity<IntransitRun>) => repo().update({ id, status: INTRANSIT_RUN_STATUS.RUNNING }, set);
  try {
    if (run.kind === INTRANSIT_RUN_KIND.REPORT) {
      // S3: the build works in a temporary folder (emptied at the end), its files then kept in S3
      const dir = stored ? jobDir(id) : runDir(id);
      const steps = (options.toFetch ?? []) as FetchStep[];
      const pepims = await readPepims(run, onLog, setStep, signal);
      const transfers = await readTransfers(run, onLog, setStep, signal);
      const fetched = [...(pepims ? [pepims] : []), ...(transfers ? [transfers] : []), ...(options.fetchFirst && steps.length ? await fetchFirst(run, steps, onLog, setStep, control, pauseFor) : [])];
      await setStep(INTRANSIT_STEP.BUILDING);
      const snap = stored ? await snapshotFromStore(run.asOf as string, path.join(dir, 'input')) : null;
      const inputsUsed = snap ? snap.used : await snapshotInputs(dir, run.asOf as string);
      if (inputsUsed.earlier.length) onLog(`earlier copies used: ${inputsUsed.earlier.map((e) => `${e.name} (${e.date})`).join(', ')}`);
      const caches = stored ? path.join(dir, 'cache') : cacheDir();
      const loaded = stored ? await cachesIn(caches) : null;
      const uniware = missingConnectorKeys(INTRANSIT_SOURCE.UNIWARE).length ? null : env.intransit.uniware;
      const combo = { uniware, cacheDir: caches };
      const groups = await facilityGroups();
      const settings = reportSettings(dir, run.asOf as string, (run.options?.fromDate as string | null | undefined) ?? null, groups, await facilityStock(groups));
      // every sheet as its own gzipped CSV too (previews read one sheet; the Daily Snapshot takes three of them)
      // ask = stop after final_sku when there are issues (the first pass); the pass after the answers never asks
      const build = async (ask = true): Promise<PipelineResult & { comboCheck?: ComboCheckResult }> => {
        const review = await reviewSettings(uniware, caches);
        const r = (await runInWorker({ kind: 'report', settings: { ...settings, skuReview: { ...review, pause: review.pause && ask } }, combo, sheets: true }, env.intransit.runTimeoutMs, onLog, signal)) as PipelineResult & { comboCheck?: ComboCheckResult };
        // filled Sheet35 values go to the master (live server; never fails the build)
        const saved = await saveSkuFills(r.skuFills ?? [], who).catch((err: unknown) => {
          onLog(`fill: not saved to the master (${err instanceof Error ? err.message : String(err)})`);
          return 0;
        });
        if (saved) onLog(`fill: ${saved} SKU(s) of the master got their missing MRP / COGS / name (marked auto-filled)`);
        return r;
      };
      let result = await build();
      if (result.paused) {
        // new SKUs / mapping issues: ask (fix or ignore each), then build again with the answers - ignored ones are
        // counted as before and asked again at the next build
        const items = result.newSkus;
        const locations = ((await repo().query(`SELECT DISTINCT intransit_location AS l FROM details_channels WHERE intransit_location IS NOT NULL ORDER BY l`)) as { l: string }[]).map((r) => r.l);
        onLog(`waiting for the answers on ${items.length} SKU / mapping issue(s) (up to ${Math.round(env.intransit.skuWaitMs / 60000)} min)`);
        await pauseFor({ kind: 'issues', items, locations }, INTRANSIT_STEP.AWAITING_ANSWERS);
        onLog('answered: building with the answers');
        await setStep(INTRANSIT_STEP.BUILDING);
        await exportMastersFromDb(path.join(dir, 'input'));
        result = await build(false);
      }
      // every daily input in one workbook, a dated tab per file (the mail links to it); never fails the build
      await setStep(INTRANSIT_STEP.INPUTS_BOOK);
      const warnings = [...(result.warnings ?? [])];
      try {
        const book = (await runInWorker({ kind: 'inputs-book', inputDir: settings.inputDir, files: bookInputs(run.asOf as string, inputsUsed, snap?.inputsUsed), outFile: path.join(dir, INPUTS_BOOK_FILE) }, env.intransit.runTimeoutMs, onLog, signal)) as { tabs: unknown[]; bytes: number };
        onLog(`inputs workbook: ${book.tabs.length} tab(s), ${Math.round(book.bytes / 1048576)} MB`);
      } catch (err) {
        if (err instanceof StoppedError) throw err;
        warnings.push(`The input files workbook was not made: ${err instanceof Error ? err.message : String(err)}`);
        onLog(`inputs workbook: NOT made - ${err instanceof Error ? err.message : String(err)}`);
      }
      let reportPath = relReportPath(result.reportPath);
      let files: Record<string, string> | null = null;
      commit();
      if (stored) {
        await setStep(INTRANSIT_STEP.SAVING);
        const published = await storeOrKeep('the build', async () => {
          if (loaded) await cachesOut(caches, loaded);
          return publishBuild(run, dir);
        });
        reportPath = published.report ? `s3:${published.report}` : null;
        files = published.files;
        onLog(`saved to S3${published.queued ? ` (${published.queued} file(s) queued: S3 unreachable, sent when it is back)` : ''}${published.final ? '; the final build of the day' : ''}`);
        forgetSnapshotDays();
      }
      setOption('step', INTRANSIT_STEP.DONE);
      await flushAll();
      await finish({
        status: INTRANSIT_RUN_STATUS.SUCCEEDED,
        finishedAt: new Date(),
        timings: result.timings,
        summary: result.summary as QueryDeepPartialEntity<IntransitRun>['summary'],
        sheetRows: result.sheetRows,
        reportPath,
        result: {
          comboCheck: result.comboCheck ?? null, inputsUsed, fetched, warnings, whSummary: result.whSummary ?? [], skuFills: result.skuFills?.length ?? 0,
          ...(snap ? { inputs: snap.inputsUsed, template: snap.template, files } : {}),
        } as unknown as QueryDeepPartialEntity<IntransitRun>['result'],
      });
      // the week's and month's copies follow the newest build (live server)
      if (stored) void touchPeriods(run.asOf as string).catch((err) => logError(LOG_SOURCE.APP, `[intransit] run ${id}: weekly/monthly copies not made`, err));
    } else {
      const opts = (run.options ?? {}) as ConnectorOptions;
      const day = checkDate(opts.date ?? run.asOf ?? undefined);
      // the day's Shipment_Status.csv (Amazon GRN reads it) in the job's own folder: from S3, or from the disk copy
      const inputDir = stored ? await prepareConnector(run, day) : await diskShipmentStatus(run.id, day);
      await raceStop(shipmentStatusForAmazon(run, opts, inputDir, day, onLog), signal);
      const exportTo = stored ? path.join(jobDir(id), 'export') : exportDir(run.kind, id);
      const caches = stored ? path.join(jobDir(id), 'cache') : cacheDir();
      const loaded = stored ? await cachesIn(caches) : null;
      const job: WorkerJob = {
        kind: run.kind,
        config: await connectorConfig(),
        dirs: { targetDir: stored ? null : dailyDir(day), mastersDir: inputDir, exportDir: exportTo, cacheDir: caches, startedAt: startedAt.toISOString() },
        options: opts,
      };
      const pause = (fetchEnded.get(run.kind) ?? 0) + SOURCE_COOLDOWN_MS - Date.now();
      if (pause > 0) {
        onLog(`waiting ${Math.ceil(pause / 1000)} s: the last ${run.kind} fetch ended just now, and asked again at once it fails`);
        await abortableSleep(pause, signal);
      }
      const t0 = Date.now();
      const result = (await runInWorker(job, env.intransit.connectorTimeoutMs, onLog, signal).finally(() => fetchEnded.set(run.kind, Date.now()))) as ConnectorResult;
      commit();
      if (stored) {
        const keys = await storeOrKeep('the fetch', async () => {
          if (loaded) await cachesOut(caches, loaded);
          return storeConnectorFiles(run, exportTo, result, day);
        });
        (result as ConnectorResult & { files?: Record<string, string> }).files = keys;
      }
      if (result.keptUploads?.length) onLog(`kept the file(s) uploaded by hand while this fetch ran: ${result.keptUploads.join(', ')}`);
      await flushAll();
      const rejected = Object.keys(result.rejected);
      const missing = result.missing ?? [];
      // a file that failed the check or did not come is named in error, so the page can say so (not only the log)
      const problems = [
        ...(missing.length ? [`not fetched: ${missing.join(', ')}`] : []),
        ...(rejected.length ? [`not used (failed the column check): ${rejected.join(', ')}`] : []),
      ];
      await finish({
        status: problems.length && !result.saved.length && !result.keptUploads?.length ? INTRANSIT_RUN_STATUS.FAILED : INTRANSIT_RUN_STATUS.SUCCEEDED,
        error: problems.length ? problems.join('; ').slice(0, ERROR_MAX) : null,
        finishedAt: new Date(),
        timings: { total: Math.round((Date.now() - t0) / 10) / 100 },
        result: result as unknown as QueryDeepPartialEntity<IntransitRun>['result'],
      });
    }
  } catch (err) {
    const stopped = err instanceof StoppedError || (signal.aborted && !control.committed);
    const message = stopped && signal.reason instanceof Error ? signal.reason.message : err instanceof Error ? err.message : String(err);
    lines.push(stopped ? `STOPPED ${message}` : `ERROR ${message}`);
    dirty = true;
    await flushAll().catch(() => undefined);
    await finish({ status: stopped ? INTRANSIT_RUN_STATUS.STOPPED : INTRANSIT_RUN_STATUS.FAILED, finishedAt: new Date(), error: message.slice(0, ERROR_MAX) });
  } finally {
    clearInterval(timer);
    controls.delete(id);
    if (run.kind === INTRANSIT_RUN_KIND.REPORT) await fsp.rm(path.join(runDir(id), 'input'), { recursive: true, force: true }).catch(() => undefined);
    await closeRun(id).catch((err) => logError(LOG_SOURCE.APP, `[intransit] run ${id}: run.json not written`, err));
    // nothing of a job stays on the server (S3 store), unless its files could not be saved (nor queued)
    if (!keepJob) await fsp.rm(jobDir(id), { recursive: true, force: true }).catch(() => undefined);
  }
};

/** How often a paused build looks for its files / answers / Continue. */
const PAUSE_POLL_MS = 5000;

/** The daily inputs of a build with the day of each copy used: the inputs workbook's tabs. */
const bookInputs = (asOf: string, used: { ofDate: string[]; earlier: { name: string; date: string }[] }, stored?: { name: string; day: string | null }[]): BookInput[] => {
  const dayOf = new Map<string, string>([...used.ofDate.map((n) => [n, asOf] as [string, string]), ...used.earlier.map((e) => [e.name, e.date] as [string, string])]);
  for (const s of stored ?? []) if (s.day) dayOf.set(s.name, s.day);
  return INPUT_CATALOG.filter((f) => f.group === 'daily-fetch' || f.group === 'daily-upload').filter((f) => dayOf.has(f.name)).map((f) => ({ name: f.name, day: dayOf.get(f.name) as string }));
};

/** The run, when it is paused at `step`, with what it waits for (409 otherwise). */
const pausedRun = async (id: string, step: string, what: string): Promise<{ run: IntransitRun; pause: Record<string, unknown> }> => {
  const run = await findRun(id);
  const o = (run.options ?? {}) as { step?: string; pause?: Record<string, unknown> | null };
  if (run.status !== INTRANSIT_RUN_STATUS.RUNNING || o.step !== step || !o.pause) throw appError(ERROR_CODES.INTRANSIT_NOT_PAUSED, id, what);
  return { run, pause: o.pause };
};

/** Tell a paused build to go on (options.resume; the machine running it reads it within seconds). */
const resumeRun = async (id: string, who: Requester): Promise<void> => {
  await repo().query(
    `UPDATE intransit_runs SET options = JSON_SET(COALESCE(options, JSON_OBJECT()), '$.resume', CAST(? AS JSON)) WHERE id = ? AND status = ?`,
    [JSON.stringify({ at: new Date().toISOString(), by: who.name }), id, INTRANSIT_RUN_STATUS.RUNNING],
  );
};

/**
 * The answers for the SKU / mapping issues a build waits on (POST /runs/:id/issues): fixes saved to the masters,
 * ignored ones left for the next build; then the build carries on (any machine may take the answers).
 */
export const answerRunIssues = async (id: string, answers: IssueAnswer[], who: Requester): Promise<{ fixed: number; ignored: number }> => {
  const { pause } = await pausedRun(id, INTRANSIT_STEP.AWAITING_ANSWERS, 'answers');
  if (!Array.isArray(answers)) throw appError(ERROR_CODES.INTRANSIT_SKU_ANSWERS_INVALID, 'answers must be a list');
  const r = await applyIssueAnswers((pause.items ?? []) as NewSku[], answers, who);
  await resumeRun(id, who);
  return r;
};

/** A build waiting for files uploaded by hand goes on with the earlier copies (POST /runs/:id/continue). */
export const continueRun = async (id: string, who: Requester): Promise<RunView> => {
  await pausedRun(id, INTRANSIT_STEP.AWAITING_UPLOAD, 'files uploaded by hand');
  await resumeRun(id, who);
  return getRun(id);
};

/** Disk store: the day's Shipment_Status.csv copied into the job's folder (it is a daily file, not a master). */
const diskShipmentStatus = async (id: string, day: string): Promise<string> => {
  const dir = path.join(jobDir(id), 'input');
  await fsp.mkdir(dir, { recursive: true });
  const ss = (await resolveInputs(day)).files.find((f) => f.name === 'Shipment_Status.csv');
  if (ss) await fsp.copyFile(ss.path, path.join(dir, ss.name));
  return dir;
};

/**
 * Amazon_GRN needs the day's Shipment_Status.csv (its Amazon shipment ids). It is read from PEPIMS only by a build, so
 * a fetch of Amazon on its own failed with "upload it first" until a build had run that day (user, 2026-10-29). When
 * the day has none, read it from PEPIMS here, for this fetch only (the build still saves the day's copy); on failure
 * the fetch stops with its usual message.
 */
const shipmentStatusForAmazon = async (run: IntransitRun, opts: ConnectorOptions, inputDir: string, day: string, log: (line: string) => void): Promise<void> => {
  const only = onlyList(opts.only);
  if (run.kind !== INTRANSIT_SOURCE.AMAZON || (only.length && !only.includes('grn')) || env.intransit.poSource !== 'pepims') return;
  const target = path.join(inputDir, PEPIMS_FILES.SHIPMENT_STATUS);
  if (fs.existsSync(target)) return;
  const tmp = path.join(inputDir, '_pepims');
  try {
    const r = await fetchPepimsTracker(env.db, tmp, day, log);
    await fsp.copyFile(path.join(tmp, PEPIMS_FILES.SHIPMENT_STATUS), target);
    log(`pepims: the day has no Shipment_Status.csv yet, so it was read from PEPIMS for Amazon_GRN (${r.pos} POs, Entry Date ${r.from} .. ${r.to})`);
  } catch (err) {
    log(`pepims: Shipment_Status.csv could not be read from PEPIMS - ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** A run has ended: its run.json, beside its files (disk) or in its Full Report folder (S3; builds only). */
const closeRun = async (id: string): Promise<void> => {
  const run = await repo().findOne({ where: { id }, relations: RELATIONS });
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
 * share the database), so they are failed here. A run with no heartbeat yet counts from its start (or creation): queued
 * runs beat too since 2026-10-27, so one quiet that long has no machine left to run it.
 */
export const expireStaleRuns = async (): Promise<number> => {
  const now = Date.now();
  const stale = (await repo().find({ where: { status: In([INTRANSIT_RUN_STATUS.QUEUED, INTRANSIT_RUN_STATUS.RUNNING]) } })).filter((r) => {
    if (ownRun(r)) return false;
    const beatAt = ((r.options ?? {}) as { heartbeatAt?: string }).heartbeatAt;
    const lastSign = beatAt ? Date.parse(beatAt) : (r.startedAt ?? r.createdAt).getTime();
    return now - lastSign > STALE_RUN_MS;
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
