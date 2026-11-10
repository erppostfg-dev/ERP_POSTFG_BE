import { env } from '../../config/env';
import { CACHE, CACHE_HINTS, CACHE_MODE, CACHE_NS, type CacheMode, type CacheNs } from '../../constants/cache';
import { LOG_SOURCE } from '../../constants/logging';
import { classifyError } from '../../utils/classify-error';
import { logContext } from '../../utils/log-context';
import { log, logEvent, logFailure } from '../../utils/logger';
import { MemoryStore, RedisStore, redisHost, type KvStore } from './cache.store';

/*
 * The shared cache (2026-11-10, user: "use the AWS service; on any add / update remove the cache; keep 60 s").
 *
 *   cached(ns, key, load)  the answer from the cache, else load() once (callers asking at the same moment on this server
 *                          wait for that one load), kept CACHE_TTL_SECONDS (default 60).
 *   forgetCache(ns, key?)  a write changed the data: every answer of that kind (or one key) is dropped at once, on
 *                          every server (Redis), before the next read. Writes call it right after their commit.
 *
 * WHERE: AWS ElastiCache (Redis OSS / Valkey) when REDIS_URL is set and startCache() ran (the server / worker), else this
 * server's memory (laptop, tests, scripts). Redis down or slow (500 ms): the same calls use memory, the request never
 * fails because of the cache; when Redis is back every kind is dropped once there (a write made meanwhile could not
 * reach it), so nothing older than the write is served.
 *
 * HOW A KIND IS DROPPED: each kind has a version (key <prefix><ns>:ver); answers are stored under <prefix><ns>:<ver>:<key>.
 * forgetCache(ns) increments the version, so every older answer is never read again and expires by itself. An answer
 * loaded while a write happened is stored under the OLD version (read before loading), so it is never served.
 *
 * ONLY JSON: cached answers come back as parsed JSON (dates as ISO text). Cache what a route sends as JSON.
 *
 * LOGS (user 2026-11-10: "few lines, but enough to fix any issue from them"; source cache, codes in constants/logging):
 * one line per CHANGE of state, never one per request:
 *   CACHE_START       once: where answers are kept (redis / memory / off), host (never the token), TLS, prefix, life
 *   CACHE_CONNECTED   first connection to Redis (connectMs)
 *   CACHE_DOWN        Redis stopped answering / could not connect: kind, error, and `fix` = what to change (CACHE_HINTS)
 *   CACHE_STILL_DOWN  every 5 min while down (minutes, errors, last error)
 *   CACHE_UP          back (down for n s, errors meanwhile; every cached answer dropped once)
 *   CACHE_<FAILURE>   a single Redis command failed while connected (timeout, memory full ...): first one at once, the
 *                     same kind again at most every 5 min with the count
 *   CACHE_TOO_BIG     an answer too big to cache (once an hour per key)
 *   CACHE_STATS       every CACHE_STATS_MINUTES (60) when used: hit %, per kind (hits, misses, load ms), Redis speed /
 *                     errors, calls served from memory while Redis was down
 *   CACHE_INFO debug  every load (only with LOG_LEVEL=debug)
 * Every API_REQUEST line carries cacheHits / cacheMisses when the request used the cache.
 */

/** A store that may be unavailable (Redis). */
export interface RemoteStore extends KvStore {
  readonly ready: boolean;
  close(): Promise<void>;
}

const memory = new MemoryStore();
let remote: RemoteStore | null = null;
let statsTimer: NodeJS.Timeout | undefined;
const inflight = new Map<string, Promise<unknown>>();
const tooBigLogged = new Map<string, number>();

/** Where Redis is (log lines only; never the token). */
let where: { host: string; tls: boolean; cluster: boolean } | null = null;

interface KindStats { hits: number; misses: number; loads: number; loadMs: number; loadMaxMs: number }
const newStats = () => ({
  since: Date.now(), hits: 0, misses: 0, byKind: new Map<string, KindStats>(),
  redisOps: 0, redisMs: 0, redisMaxMs: 0, redisErrors: 0, memoryWhileDown: 0, tooBig: 0,
});
let stats = newStats();

/** Redis state: down since (0 = answering / not known yet), errors while down, when we last said so. */
const health = { everReady: false, startedAt: 0, downSince: 0, downErrors: 0, lastDownLine: 0, lastError: '', stopping: false };
/** Repeated command errors (same kind + code): when last logged, how many since. */
const repeats = new Map<string, { last: number; count: number }>();

/** Where answers are kept right now. */
export const cacheMode = (): CacheMode =>
  !env.cache.enabled ? CACHE_MODE.OFF : !remote ? CACHE_MODE.MEMORY : remote.ready ? CACHE_MODE.REDIS : CACHE_MODE.REDIS_DOWN;

const verKey = (ns: string) => `${env.cache.keyPrefix}${ns}:ver`;
const fullKey = (ns: string, ver: string, key: string) => `${env.cache.keyPrefix}${ns}:${ver}:${key}`;

/** The plain facts of a Redis error + what to fix (CACHE_HINTS on its words, else the source's fix). */
const factsOf = (err: unknown) => {
  const f = classifyError(LOG_SOURCE.CACHE, err);
  const words = `${f.errorCode ?? ''} ${f.error}`;
  const hint = CACHE_HINTS.find((h) => h.test.test(words));
  return { kind: hint?.kind ?? f.kind, errorCode: f.errorCode, error: f.error, ...(hint ? { fix: hint.fix } : {}) };
};

const minutes = (ms: number) => Math.round(ms / 60_000);

/** Redis is not answering: one CACHE_DOWN, then CACHE_STILL_DOWN at most every 5 min. */
const markDown = (op: string, err: unknown): void => {
  const now = Date.now();
  const f = factsOf(err);
  stats.redisErrors++;
  health.lastError = f.error;
  if (health.downSince) {
    health.downErrors++;
    if (now - health.lastDownLine < CACHE.REPEAT_LOG_EVERY_MS) return;
    health.lastDownLine = now;
    logEvent('CACHE_STILL_DOWN', `[cache] Redis ${where?.host ?? ''} still not answering after ${minutes(now - health.downSince)} min: server memory meanwhile`, {
      ...where, downForMin: minutes(now - health.downSince), errors: health.downErrors, kind: f.kind, errorCode: f.errorCode, error: f.error, ...(f.fix ? { fix: f.fix } : {}),
    });
    return;
  }
  Object.assign(health, { downSince: now, downErrors: 1, lastDownLine: now });
  const what = health.everReady ? 'stopped answering' : 'could not connect';
  logEvent('CACHE_DOWN', `[cache] Redis ${where?.host ?? ''} ${what} (${f.kind}): answers come from server memory / the DB until it is back`, {
    ...where, op, kind: f.kind, errorCode: f.errorCode, error: f.error, ...(f.fix ? { fix: f.fix } : {}),
  });
};

/** Redis answers (first time, or again after CACHE_DOWN). */
const markUp = (): void => {
  const now = Date.now();
  if (!health.everReady) {
    health.everReady = true;
    const failedFirst = health.downSince ? { failedForSec: Math.round((now - health.downSince) / 1000), errors: health.downErrors } : {};
    health.downSince = 0;
    logEvent('CACHE_CONNECTED', `[cache] Redis connected: ${where?.host ?? ''}`, { ...where, connectMs: now - health.startedAt, ...failedFirst });
    return;
  }
  if (!health.downSince) return;
  const downFor = now - health.downSince;
  const errors = health.downErrors;
  health.downSince = 0;
  // writes made during the outage could not drop their answers in Redis: drop every kind once
  void forgetAllCaches().then(() => logEvent('CACHE_UP', `[cache] Redis ${where?.host ?? ''} answers again after ${Math.round(downFor / 1000)} s; every cached answer dropped once`, {
    ...where, downForSec: Math.round(downFor / 1000), errors, lastError: health.lastError,
  }));
};

/** One Redis command failed: connection problems mark Redis down, others are logged once per kind every 5 min. */
const commandError = (op: string, err: unknown): void => {
  const f = factsOf(err);
  if (f.kind === 'UNREACHABLE' || !remote?.ready) return markDown(op, err);
  stats.redisErrors++;
  // one line per CAUSE: two different problems (memory full, cluster mode) are both logged even with the same kind
  const id = `${f.kind}:${f.fix ?? f.errorCode ?? ''}`;
  const now = Date.now();
  const r = repeats.get(id);
  if (r && now - r.last < CACHE.REPEAT_LOG_EVERY_MS) return void r.count++;
  repeats.set(id, { last: now, count: 0 });
  logFailure(LOG_SOURCE.CACHE, f.kind, `[cache] Redis ${op} failed: this call used server memory`, {
    ...where, op, errorCode: f.errorCode, error: f.error, ...(f.fix ? { fix: f.fix } : {}), ...(r?.count ? { sameErrorSinceLastLine: r.count } : {}),
  });
};

/** Runs on Redis when it answers, else on memory; a Redis error falls back to memory for this call. */
const onStore = async <T>(op: string, fn: (s: KvStore) => Promise<T>): Promise<T> => {
  const r = remote;
  if (!r?.ready) {
    if (r) stats.memoryWhileDown++;
    return fn(memory);
  }
  const started = Date.now();
  try {
    const out = await fn(r);
    const ms = Date.now() - started;
    stats.redisOps++;
    stats.redisMs += ms;
    stats.redisMaxMs = Math.max(stats.redisMaxMs, ms);
    // a command worked while we thought it was down (no "ready" event, e.g. a fake in tests): it is back
    if (health.downSince || !health.everReady) markUp();
    return out;
  } catch (err) {
    commandError(op, err);
    stats.memoryWhileDown++;
    return fn(memory);
  }
};

/** The kind's current version (created on first use; a time stamp, so a lost counter never brings old answers back). */
const versionIn = async (s: KvStore, ns: string): Promise<string> => {
  const v = await s.get(verKey(ns));
  if (v) return v;
  const first = String(Date.now());
  await s.setIfMissing(verKey(ns), first);
  return (await s.get(verKey(ns))) ?? first;
};

const kindStats = (ns: string): KindStats => {
  let k = stats.byKind.get(ns);
  if (!k) stats.byKind.set(ns, (k = { hits: 0, misses: 0, loads: 0, loadMs: 0, loadMaxMs: 0 }));
  return k;
};

const count = (ns: string, hit: boolean): void => {
  const k = kindStats(ns);
  if (hit) { stats.hits++; k.hits++; } else { stats.misses++; k.misses++; }
  const ctx = logContext();
  if (ctx) {
    if (hit) ctx.cacheHits = (ctx.cacheHits ?? 0) + 1;
    else ctx.cacheMisses = (ctx.cacheMisses ?? 0) + 1;
  }
};

/**
 * The answer of `ns` / `key` from the cache, else `load()` (kept `ttlSeconds`, default CACHE_TTL_SECONDS). A failing
 * load is not kept (the next caller tries again) and its error goes to the caller.
 */
export const cached = async <T>(ns: CacheNs, key: string, load: () => Promise<T>, ttlSeconds = env.cache.ttlSeconds): Promise<T> => {
  if (!env.cache.enabled) return load();
  let ver = '0';
  const hit = await onStore('read', async (s) => {
    ver = await versionIn(s, ns);
    return s.get(fullKey(ns, ver, key));
  });
  if (hit !== null) {
    count(ns, true);
    return JSON.parse(hit) as T;
  }
  count(ns, false);

  const id = `${ns}:${key}`;
  const running = inflight.get(id);
  if (running) return running as Promise<T>;
  const job = (async () => {
    const started = Date.now();
    const value = await load();
    const ms = Date.now() - started;
    const k = kindStats(ns);
    k.loads++;
    k.loadMs += ms;
    k.loadMaxMs = Math.max(k.loadMaxMs, ms);
    const text = JSON.stringify(value);
    if (text === undefined) return value;
    const kb = Math.round(text.length / 1024);
    if (text.length > CACHE.VALUE_MAX_KB * 1024) {
      stats.tooBig++;
      if (Date.now() - (tooBigLogged.get(id) ?? 0) > CACHE.TOO_BIG_LOG_EVERY_MS) {
        tooBigLogged.set(id, Date.now());
        logEvent('CACHE_TOO_BIG', `[cache] ${id} not cached: ${kb} KB is over ${CACHE.VALUE_MAX_KB} KB (loaded from the DB every time)`, { ns, key, kb, loadMs: ms });
      }
      return value;
    }
    await onStore('write', (s) => s.set(fullKey(ns, ver, key), text, ttlSeconds));
    log.debug(LOG_SOURCE.CACHE, `[cache] ${id} loaded in ${ms} ms, kept ${ttlSeconds} s`, { ns, ms, kb });
    // parsed like a cache hit, so the first caller gets exactly what the next ones will (dates as text)
    return JSON.parse(text) as T;
  })().finally(() => { if (inflight.get(id) === job) inflight.delete(id); });
  inflight.set(id, job);
  return job;
};

const dropIn = async (s: KvStore, ns: string, key?: string): Promise<void> => {
  if (key === undefined) await s.incr(verKey(ns));
  else await s.del(fullKey(ns, await versionIn(s, ns), key));
};

/**
 * The data behind `ns` changed (or only `key` of it): those answers are dropped at once, here and in Redis. Call it after
 * the commit. Never throws (a Redis error is logged; every kind is dropped again when Redis is back).
 */
export const forgetCache = async (ns: CacheNs, key?: string): Promise<void> => {
  for (const id of [...inflight.keys()]) if (key === undefined ? id.startsWith(`${ns}:`) : id === `${ns}:${key}`) inflight.delete(id);
  await dropIn(memory, ns, key);
  const r = remote;
  if (!r?.ready) return;
  try {
    await dropIn(r, ns, key);
  } catch (err) {
    commandError('clear', err);
  }
};

/** Every kind dropped (Redis came back). */
const forgetAllCaches = async (): Promise<void> => {
  for (const ns of Object.values(CACHE_NS)) await forgetCache(ns);
};

/** The CACHE_STATS line (nothing when the cache was not used), then the counters start again. */
const logStats = (): void => {
  const s = stats;
  stats = newStats();
  const total = s.hits + s.misses;
  if (!total && !s.redisErrors) return;
  const pct = total ? Math.round((s.hits / total) * 100) : 0;
  const byKind = Object.fromEntries([...s.byKind].map(([ns, k]) => [ns, {
    hits: k.hits, misses: k.misses, ...(k.loads ? { loadAvgMs: Math.round(k.loadMs / k.loads), loadMaxMs: k.loadMaxMs } : {}),
  }]));
  const took = Date.now() - s.since;
  logEvent('CACHE_STATS', `[cache] last ${took < 60_000 ? `${Math.round(took / 1000)} s` : `${minutes(took)} min`}: ${s.hits} of ${total} answers from the cache (${pct}%), ${cacheMode()}`, {
    mode: cacheMode(), hits: s.hits, misses: s.misses, hitPct: pct, byKind, memoryKeys: memory.size,
    ...(remote ? { redis: { ops: s.redisOps, avgMs: s.redisOps ? Math.round(s.redisMs / s.redisOps) : 0, maxMs: s.redisMaxMs, errors: s.redisErrors } } : {}),
    ...(s.memoryWhileDown ? { servedFromMemoryWhileRedisDown: s.memoryWhileDown } : {}),
    ...(s.tooBig ? { notCachedTooBig: s.tooBig } : {}),
  });
};

/** Uses `store` as the shared store (startCache with REDIS_URL; tests with a fake). null = memory only. */
export const useRemoteStore = (store: RemoteStore | null): void => {
  remote = store;
};

/**
 * Called once by the server / worker at start: connects to Redis when REDIS_URL is set (else memory) and starts the
 * summary line. Scripts and tests do not call it, so they never open a Redis connection.
 */
export const startCache = (): void => {
  const c = env.cache;
  if (!c.enabled) return void logEvent('CACHE_START', '[cache] OFF (CACHE_ENABLED=false): every answer comes from the DB', { mode: CACHE_MODE.OFF });
  if (c.statsMinutes > 0) {
    statsTimer ??= setInterval(logStats, c.statsMinutes * 60_000);
    statsTimer.unref();
  }
  const base = { ttlSeconds: c.ttlSeconds, statsMinutes: c.statsMinutes };
  if (!c.redisUrl) {
    return void logEvent('CACHE_START', `[cache] server memory (REDIS_URL not set), answers kept ${c.ttlSeconds} s`, { mode: CACHE_MODE.MEMORY, ...base });
  }
  where = { host: redisHost(c.redisUrl), tls: c.redisTls, cluster: c.redisCluster };
  let store: RedisStore;
  try {
    store = new RedisStore({ url: c.redisUrl, username: c.redisUsername, password: c.redisPassword, tls: c.redisTls, cluster: c.redisCluster });
  } catch (err) {
    logFailure(LOG_SOURCE.CACHE, 'CONFIG', '[cache] REDIS_URL not usable: server memory is used', {
      ...where, error: err instanceof Error ? err.message : String(err), fix: 'REDIS_URL must look like rediss://<ElastiCache endpoint>:6379 (the token goes in REDIS_PASSWORD).',
    });
    where = null;
    return;
  }
  Object.assign(health, { everReady: false, startedAt: Date.now(), downSince: 0, downErrors: 0, stopping: false });
  store.client.on('error', (err: unknown) => {
    if (!health.stopping) commandError('connect', err);
  });
  store.client.on('ready', markUp);
  store.client.on('close', () => {
    if (!health.stopping && health.everReady && !health.downSince) markDown('connection', new Error('Connection is closed'));
  });
  useRemoteStore(store);
  logEvent('CACHE_START', `[cache] Redis ${where.host} (server memory until connected), answers kept ${c.ttlSeconds} s`, {
    mode: CACHE_MODE.REDIS, ...where, keyPrefix: c.keyPrefix, ...base,
    ...(c.keyPrefix === CACHE.KEY_PREFIX ? { warning: 'CACHE_KEY_PREFIX not set: if dev and prod share this Redis their answers mix; set postfg:dev: / postfg:prod:' } : {}),
  });
};

/** Shutdown: closes the Redis connection (no "down" line for it). */
export const stopCache = async (): Promise<void> => {
  health.stopping = true;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = undefined;
  logStats();
  const r = remote;
  remote = null;
  if (r) await r.close();
};

/** Tests: empty memory, counters and Redis state. */
export const resetCacheForTests = (): void => {
  memory.clear();
  inflight.clear();
  stats = newStats();
  repeats.clear();
  tooBigLogged.clear();
  Object.assign(health, { everReady: false, startedAt: Date.now(), downSince: 0, downErrors: 0, lastDownLine: 0, lastError: '', stopping: false });
};

/** Tests: the summary line now. */
export const logCacheStatsForTests = logStats;
