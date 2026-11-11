import type { MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { env } from '../../config/env';
import { MONITOR } from '../../constants';
import { alarms, checkAccess, insights, metricData, onServer, type AccessCheck, type Series } from './aws';

/*
 * Admin > Monitor (2026-11-05, developers only), step 1: health over time (from the PROCESS_HEARTBEAT line every
 * 5 minutes), alerts (every warn / error line), the server's and the database's CloudWatch metrics, and "what was
 * running" at one moment (a peak). Each part is read on its own: one that fails (e.g. a permission not given yet)
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

/** The server's metrics (EC2 CPU + the CloudWatch agent's memory / disk / swap) and the database's (RDS). */
const metricsFor = async (instanceId: string, from: Date, to: Date, period: number): Promise<{ server: Series[]; database: Series[] }> => {
  const agent = (id: string, metric: string): MetricDataQuery => ({
    Id: id, Expression: `SEARCH('Namespace="CWAgent" MetricName="${metric}" "${instanceId}"', 'Average', ${period})`, ReturnData: true,
  });
  const rds = (id: string, metric: string, stat = 'Average'): MetricDataQuery => ({
    Id: id, Label: metric, ReturnData: true,
    MetricStat: { Metric: { Namespace: 'AWS/RDS', MetricName: metric, Dimensions: [{ Name: 'DBInstanceIdentifier', Value: env.monitor.rdsInstance }] }, Period: period, Stat: stat },
  });
  const all = await metricData([
    { Id: 'cpu', Label: 'CPU %', ReturnData: true, MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: instanceId }] }, Period: period, Stat: 'Average' } },
    agent('mem', 'mem_used_percent'), agent('disk', 'disk_used_percent'), agent('swap', 'swap_used_percent'),
    rds('dbcpu', 'CPUUtilization'), rds('dbconn', 'DatabaseConnections', 'Maximum'), rds('dbmem', 'FreeableMemory', 'Minimum'), rds('dbdisk', 'FreeStorageSpace', 'Minimum'),
  ], from, to);
  const isDb = (s: Series) => s.id.startsWith('db');
  return { server: all.filter((s) => !isDb(s)), database: all.filter(isDb) };
};

const windowOf = (w: string | undefined) => {
  const key = w && MONITOR.WINDOWS[w] ? w : MONITOR.DEFAULT_WINDOW;
  const to = new Date();
  return { key, from: new Date(to.getTime() - MONITOR.WINDOWS[key] * 1000), to, period: MONITOR.PERIOD[key] };
};

export interface MonitorAccess { onServer: boolean; instanceId: string | null; logGroup: string; region: string; checks: AccessCheck[] }

/** GET /admin/monitor/access: where it runs, and which CloudWatch reads this server's role may do. */
export const monitorAccess = async (): Promise<MonitorAccess> => {
  const instanceId = await onServer();
  const base = { onServer: !!instanceId, instanceId, logGroup: env.monitor.logGroup, region: env.monitor.region };
  return { ...base, checks: instanceId ? await cached('access', checkAccess) : [] };
};

export interface MonitorOverview {
  onServer: boolean; window: string; from: string; to: string;
  health: Part<HealthPoint[]>; alerts: Part<AlertRow[]>; alertCounts: Part<AlertCount[]>;
  metrics: Part<{ server: Series[]; database: Series[] }>; alarms: Part<Awaited<ReturnType<typeof alarms>>>;
}

/** GET /admin/monitor/overview?window=1h|24h|7d. Off the server (a laptop): onServer false, nothing read. */
export const monitorOverview = async (window?: string): Promise<MonitorOverview> => {
  const w = windowOf(window);
  const instanceId = await onServer();
  const none = <T>(): Part<T> => ({ ok: false, error: 'Not on the server: the Monitor reads CloudWatch only with the EC2 role.', data: null });
  if (!instanceId) {
    return { onServer: false, window: w.key, from: w.from.toISOString(), to: w.to.toISOString(), health: none(), alerts: none(), alertCounts: none(), metrics: none(), alarms: none() };
  }
  return cached(`overview:${w.key}`, async () => {
    const [health, alertsPart, counts, metrics, alarmList] = await Promise.all([
      part(() => heartbeats(w.from, w.to)), part(() => alertList(w.from, w.to)), part(() => alertCounts(w.from, w.to)),
      part(() => metricsFor(instanceId, w.from, w.to, w.period)), part(() => alarms()),
    ]);
    return { onServer: true, window: w.key, from: w.from.toISOString(), to: w.to.toISOString(), health, alerts: alertsPart, alertCounts: counts, metrics, alarms: alarmList };
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
