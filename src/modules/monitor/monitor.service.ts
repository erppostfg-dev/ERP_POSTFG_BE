import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { MONITOR, MONITOR_ERRORS } from '../../constants';
import { User } from '../../entities';
import { checkAccess, insights, onServer, type AccessCheck } from './aws';

/*
 * Admin > Monitor (2026-11-05, developers only): POST_FG's own health over time (from the PROCESS_HEARTBEAT line every
 * 5 minutes), alerts (every warn / error line), errors (2026-11-26) and "what was running" at one moment (a peak).
 * Only THIS app (user 2026-11-26: "only post_fg dev / prod; why do I need other dbs and cpus"): the shared database
 * server's and the machine's CloudWatch metrics are no longer read. Each part is read on its own: one that fails (e.g. a permission not given yet)
 * comes back as { ok: false, error } and the rest still shows. Answers are kept CACHE_SECONDS (each scan is metered).
 */

export interface Part<T> { ok: boolean; error: string | null; data: T | null }
const part = async <T>(fn: () => Promise<T>): Promise<Part<T>> => {
  try {
    return { ok: true, error: null, data: await fn() };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { ok: false, error: `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${(e.message ?? '').slice(0, 300)}`, data: null };
  }
};

const cache = new Map<string, { at: number; value: unknown }>();
const cached = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < MONITOR.CACHE_SECONDS * 1000) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
};
/** Tests only. */
export const clearMonitorCache = () => cache.clear();

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const json = (message: string): Record<string, unknown> | null => {
  try {
    const s = message.indexOf('{');
    return s >= 0 ? (JSON.parse(message.slice(s)) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export interface HealthPoint {
  t: string; rssMb: number | null; heapUsedMb: number | null; cpuPct: number | null; loopP99Ms: number | null; loopMaxMs: number | null;
  requests: number | null; errors5xx: number | null; errors4xx: number | null; slow: number | null; avgMs: number | null; maxMs: number | null;
  activeRequests: number | null; dbPoolSize: number | null; dbPoolFree: number | null; dbPoolWaiting: number | null; dbPoolMaxWaiting: number | null;
  running: string[];
}

/** What a log line's "running" says: jobs / requests as short labels. */
const runningOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).slice(0, 20) : []);

const toPoint = (t: string, line: Record<string, unknown>): HealthPoint => {
  const pool = (line.dbPool ?? {}) as Record<string, unknown>;
  return {
    t, rssMb: num(line.rssMb), heapUsedMb: num(line.heapUsedMb), cpuPct: num(line.cpuPct), loopP99Ms: num(line.loopP99Ms), loopMaxMs: num(line.loopMaxMs),
    requests: num(line.requests), errors5xx: num(line.errors5xx), errors4xx: num(line.errors4xx), slow: num(line.slow), avgMs: num(line.avgMs), maxMs: num(line.maxMs),
    activeRequests: num(line.activeRequests), dbPoolSize: num(pool.size), dbPoolFree: num(pool.free), dbPoolWaiting: num(pool.waiting),
    dbPoolMaxWaiting: num(pool.maxWaiting), running: runningOf(line.running),
  };
};

const at = (ts: string | undefined) => (ts ? new Date(`${ts.replace(' ', 'T')}Z`).toISOString() : '');

const heartbeats = async (from: Date, to: Date, limit = 10_000): Promise<HealthPoint[]> => {
  const rows = await insights('filter code = "PROCESS_HEARTBEAT" | fields @timestamp, @message | sort @timestamp asc', from, to, limit);
  return rows.flatMap((r) => {
    const line = json(r['@message'] ?? '');
    return line ? [toPoint(at(r['@timestamp']), line)] : [];
  });
};

export interface AlertRow {
  t: string; level: string; code: string; source: string; msg: string; reason: string; fix: string;
  requestId: string; jobId: string; path: string; errorCode: string;
}
const ALERT_FIELDS = ['level', 'code', 'source', 'msg', 'reason', 'fix', 'requestId', 'jobId', 'path', 'errorCode'] as const;

const alertList = async (from: Date, to: Date): Promise<AlertRow[]> => {
  const rows = await insights(
    `filter level in ["warn", "error"] | fields @timestamp, ${ALERT_FIELDS.join(', ')} | sort @timestamp desc`, from, to, MONITOR.ALERT_LIMIT,
  );
  return rows.map((r) => ({ t: at(r['@timestamp']), ...Object.fromEntries(ALERT_FIELDS.map((f) => [f, r[f] ?? ''])) }) as AlertRow);
};

export interface AlertCount { code: string; level: string; count: number; last: string }
const alertCounts = async (from: Date, to: Date): Promise<AlertCount[]> => {
  const rows = await insights('filter level in ["warn", "error"] | stats count() as n, max(@timestamp) as last by code, level | sort n desc', from, to, 50);
  return rows.map((r) => ({ code: r.code ?? '', level: r.level ?? '', count: Number(r.n ?? 0), last: r.last ? at(r.last) : '' }));
};

const windowOf = (w: string | undefined) => {
  const key = w && MONITOR.WINDOWS[w] ? w : MONITOR.DEFAULT_WINDOW;
  const to = new Date();
  return { key, from: new Date(to.getTime() - MONITOR.WINDOWS[key] * 1000), to };
};

/** Which POST_FG this server is (its database and log group): the page's header. */
export interface MonitorEnv { database: string; logGroup: string }
const envInfo = (): MonitorEnv => ({ database: env.db.name, logGroup: env.monitor.logGroup });

export interface MonitorAccess { onServer: boolean; instanceId: string | null; logGroup: string; region: string; env: MonitorEnv; checks: AccessCheck[] }

/** GET /admin/monitor/access: where it runs, and which CloudWatch reads this server's role may do. */
export const monitorAccess = async (): Promise<MonitorAccess> => {
  const instanceId = await onServer();
  const base = { onServer: !!instanceId, instanceId, logGroup: env.monitor.logGroup, region: env.monitor.region, env: envInfo() };
  return { ...base, checks: instanceId ? await cached('access', checkAccess) : [] };
};

export interface MonitorOverview {
  onServer: boolean; window: string; from: string; to: string; env: MonitorEnv;
  health: Part<HealthPoint[]>; alerts: Part<AlertRow[]>; alertCounts: Part<AlertCount[]>;
}

/** GET /admin/monitor/overview?window=1h|24h|7d. Off the server (a laptop): onServer false, nothing read. */
export const monitorOverview = async (window?: string): Promise<MonitorOverview> => {
  const w = windowOf(window);
  const instanceId = await onServer();
  const none = <T>(): Part<T> => ({ ok: false, error: 'Not on the server: the Monitor reads CloudWatch only with the EC2 role.', data: null });
  if (!instanceId) {
    return { onServer: false, window: w.key, from: w.from.toISOString(), to: w.to.toISOString(), env: envInfo(), health: none(), alerts: none(), alertCounts: none() };
  }
  return cached(`overview:${w.key}`, async () => {
    const [health, alertsPart, counts] = await Promise.all([
      part(() => heartbeats(w.from, w.to)), part(() => alertList(w.from, w.to)), part(() => alertCounts(w.from, w.to)),
    ]);
    return { onServer: true, window: w.key, from: w.from.toISOString(), to: w.to.toISOString(), env: envInfo(), health, alerts: alertsPart, alertCounts: counts };
  });
};

export interface PeakApi { method: string; path: string; calls: number; avgMs: number; maxMs: number; dbQueries: number; kb: number }
export interface PeakJob { jobId: string; source: string; lines: number; from: string; to: string; firstMsg: string }
export interface MonitorPeak {
  at: string; from: string; to: string;
  health: Part<HealthPoint | null>; apis: Part<PeakApi[]>; jobs: Part<PeakJob[]>; alerts: Part<AlertRow[]>;
}

/** GET /admin/monitor/peak?at=ISO: what ran in the 5 minutes before a health point (APIs by load, jobs, alerts). */
export const monitorPeak = async (atIso: Date): Promise<MonitorPeak> => {
  const from = new Date(atIso.getTime() - MONITOR.PEAK_BEFORE_MS);
  const to = new Date(atIso.getTime() + MONITOR.PEAK_AFTER_MS);
  const instanceId = await onServer();
  const none = <T>(): Part<T> => ({ ok: false, error: 'Not on the server.', data: null });
  const base = { at: atIso.toISOString(), from: from.toISOString(), to: to.toISOString() };
  if (!instanceId) return { ...base, health: none(), apis: none(), jobs: none(), alerts: none() };
  return cached(`peak:${atIso.getTime()}`, async () => {
    const [health, apis, jobs, alertsPart] = await Promise.all([
      part(async () => {
        const points = await heartbeats(atIso, to, 1);
        return points[0] ?? null;
      }),
      part(async () => (await insights(
        'filter code like /^API_/ and ispresent(ms) | stats count() as calls, avg(ms) as avgMs, max(ms) as maxMs, sum(dbQueries) as dbq, sum(kb) as kbs, '
        + 'by method, path | sort maxMs desc',
        from, to, MONITOR.PEAK_LIMIT,
      )).map((r) => ({
        method: r.method ?? '', path: r.path ?? '', calls: Number(r.calls ?? 0), avgMs: Math.round(Number(r.avgMs ?? 0)), maxMs: Number(r.maxMs ?? 0),
        dbQueries: Number(r.dbq ?? 0), kb: Number(r.kbs ?? 0),
      }))),
      part(async () => (await insights(
        'filter ispresent(jobId) | stats count() as lines, min(@timestamp) as first, max(@timestamp) as last, earliest(msg) as firstMsg by jobId, source | sort lines desc',
        from, to, MONITOR.PEAK_LIMIT,
      )).map((r) => ({ jobId: r.jobId ?? '', source: r.source ?? '', lines: Number(r.lines ?? 0), from: at(r.first), to: at(r.last), firstMsg: r.firstMsg ?? '' }))),
      part(() => alertList(from, to)),
    ]);
    return { ...base, health, apis, jobs, alerts: alertsPart };
  });
};

// ---- Errors (2026-11-26): what people saw, what failed in the background, what failed in a browser ----

const quote = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
const list = (vals: readonly string[]) => `[${vals.map(quote).join(', ')}]`;
const notCodes = (field: string, vals: readonly string[]) => vals.map((v) => `${field} != ${quote(v)}`).join(' and ');

export interface ErrorGroup {
  /** server: what (errorCode), where (METHOD path); background: what (code), where (source); browser: what (kind / code), where (page). */
  what: string; where: string; count: number; first: string; last: string; people: number;
  level: string; status: number | null; error: string; reason: string; fix: string; requestId: string; jobId: string;
  lastUser: { id: number; name: string; email: string } | null;
}
type RawGroup = Omit<ErrorGroup, 'lastUser'> & { userId: number | null };
const n = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
const group = (r: Record<string, string>, what: string, where: string): RawGroup => ({
  what, where, count: Number(r.n ?? 0), first: at(r.first), last: at(r.last), people: Number(r.people ?? 0),
  level: r.level ?? '', status: n(r.status), error: r.error ?? '', reason: r.reason ?? '', fix: r.fix ?? '',
  requestId: r.requestId ?? '', jobId: r.jobId ?? '', userId: n(r.lastUser),
});

const serverErrors = async (from: Date, to: Date) => (await insights(
  `filter code in ${list(MONITOR_ERRORS.API_CODES)} and ${notCodes('errorCode', MONITOR_ERRORS.SKIP_ERROR_CODES)}`
  + ' | stats count() as n, min(@timestamp) as first, max(@timestamp) as last, count_distinct(userId) as people, latest(error) as error,'
  + ' latest(requestId) as requestId, latest(status) as status, latest(userId) as lastUser, latest(level) as level by errorCode, method, path'
  + ' | sort last desc',
  from, to, MONITOR_ERRORS.LIMIT,
)).map((r) => group(r, r.errorCode ?? '', `${r.method ?? ''} ${r.path ?? ''}`.trim()));

const backgroundErrors = async (from: Date, to: Date) => (await insights(
  `filter level in ["warn", "error"] and ${notCodes('code', MONITOR_ERRORS.NOT_FAILURES)}`
  + ' | stats count() as n, min(@timestamp) as first, max(@timestamp) as last, latest(msg) as msg, latest(reason) as reason, latest(fix) as fix,'
  + ' latest(error) as error, latest(jobId) as jobId, latest(requestId) as requestId, latest(level) as level by code, source'
  + ' | sort last desc',
  from, to, MONITOR_ERRORS.LIMIT,
)).map((r) => ({ ...group(r, r.code ?? '', r.source ?? ''), error: r.error || r.msg || '' }));

const browserErrors = async (from: Date, to: Date) => (await insights(
  'filter code = "CLIENT_ERROR"'
  + ' | stats count() as n, min(@timestamp) as first, max(@timestamp) as last, count_distinct(userId) as people, latest(error) as error,'
  + ' latest(status) as status, latest(userId) as lastUser, latest(level) as level by kind, errorCode, page'
  + ' | sort last desc',
  from, to, MONITOR_ERRORS.LIMIT,
)).map((r) => group(r, [r.kind, r.errorCode].filter(Boolean).join(' · '), r.page ?? ''));

/** The person of each group's last line (one query for all groups). */
const withUsers = async (groups: RawGroup[]): Promise<ErrorGroup[]> => {
  const ids = [...new Set(groups.map((g) => g.userId).filter((v): v is number => v !== null && Number.isInteger(v)))];
  const users = ids.length && AppDataSource.isInitialized
    ? await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { id: In(ids) } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return groups.map(({ userId, ...g }) => {
    const u = userId !== null ? byId.get(userId) : undefined;
    return { ...g, lastUser: u ? { id: u.id, name: u.name, email: u.email } : null };
  });
};

export interface MonitorErrors {
  onServer: boolean; window: string; from: string; to: string; env: MonitorEnv;
  totals: { server: number; background: number; browser: number };
  server: Part<ErrorGroup[]>; background: Part<ErrorGroup[]>; browser: Part<ErrorGroup[]>;
}

/** GET /admin/monitor/errors?window=1h|24h|7d: the three lists, grouped (same problem = one row with its count). */
export const monitorErrors = async (window?: string): Promise<MonitorErrors> => {
  const w = windowOf(window);
  const base = { window: w.key, from: w.from.toISOString(), to: w.to.toISOString(), env: envInfo() };
  const instanceId = await onServer();
  if (!instanceId) {
    const none = (): Part<ErrorGroup[]> => ({ ok: false, error: 'Not on the server: the Monitor reads CloudWatch only with the EC2 role.', data: null });
    return { onServer: false, ...base, totals: { server: 0, background: 0, browser: 0 }, server: none(), background: none(), browser: none() };
  }
  return cached(`errors:${w.key}`, async () => {
    const [server, background, browser] = await Promise.all([
      part(async () => withUsers(await serverErrors(w.from, w.to))),
      part(async () => withUsers(await backgroundErrors(w.from, w.to))),
      part(async () => withUsers(await browserErrors(w.from, w.to))),
    ]);
    const sum = (p: Part<ErrorGroup[]>) => (p.data ?? []).reduce((t, g) => t + g.count, 0);
    return { onServer: true, ...base, totals: { server: sum(server), background: sum(background), browser: sum(browser) }, server, background, browser };
  });
};

let countCache: { at: number; value: number | null } | null = null;
/** Tests only. */
export const clearErrorCountCache = () => { countCache = null; };

/**
 * GET /admin/monitor/errors/count: serious errors of the last hour (server errors, failed jobs, browser errors) for the
 * tab's red count. Asked of CloudWatch at most every COUNT_CACHE_SECONDS; null = cannot tell (laptop / no access).
 */
export const monitorErrorCount = async (): Promise<{ onServer: boolean; lastHour: number | null }> => {
  const instanceId = await onServer();
  if (!instanceId) return { onServer: false, lastHour: null };
  if (countCache && Date.now() - countCache.at < MONITOR_ERRORS.COUNT_CACHE_SECONDS * 1000) return { onServer: true, lastHour: countCache.value };
  const to = new Date();
  const from = new Date(to.getTime() - MONITOR_ERRORS.COUNT_WINDOW_SECONDS * 1000);
  let value: number | null;
  try {
    const rows = await insights('filter level = "error" or code = "CLIENT_ERROR" | stats count() as n', from, to, 1);
    value = Number(rows[0]?.n ?? 0);
  } catch {
    value = null;
  }
  countCache = { at: Date.now(), value };
  return { onServer: true, lastHour: value };
};

export interface RequestLine { t: string; level: string; code: string; source: string; msg: string; reason: string; fix: string; fields: Record<string, unknown> }
const LINE_KEYS = new Set(['time', 'level', 'code', 'source', 'msg', 'reason', 'fix']);

/** GET /admin/monitor/errors/request/:requestId: every log line of one request (or job), oldest first. */
export const monitorRequestLines = async (requestId: string): Promise<{ onServer: boolean; requestId: string; lines: RequestLine[] }> => {
  const instanceId = await onServer();
  if (!instanceId) return { onServer: false, requestId, lines: [] };
  const to = new Date();
  const from = new Date(to.getTime() - MONITOR_ERRORS.REQUEST_LOOKBACK_DAYS * 86_400_000);
  const rows = await cached(`request:${requestId}`, () => insights(
    `filter requestId = ${quote(requestId)} or jobId = ${quote(requestId)} | fields @timestamp, @message | sort @timestamp asc`,
    from, to, MONITOR_ERRORS.REQUEST_LINES,
  ));
  const lines = rows.map((r) => {
    const line = json(r['@message'] ?? '') ?? { msg: r['@message'] ?? '' };
    const str = (k: string) => (typeof line[k] === 'string' ? line[k] : '');
    return {
      t: at(r['@timestamp']), level: str('level'), code: str('code'), source: str('source'), msg: str('msg'), reason: str('reason'), fix: str('fix'),
      fields: Object.fromEntries(Object.entries(line).filter(([k]) => !LINE_KEYS.has(k))),
    };
  });
  return { onServer: true, requestId, lines };
};
