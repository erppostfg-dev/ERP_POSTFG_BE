import { env } from '../../config/env';
import { CACHE, CACHE_MODE, CACHE_NS, type CacheMode, type CacheNs } from '../../constants/cache';
import { LOG_SOURCE } from '../../constants/logging';
import { classifyError } from '../../utils/classify-error';
import { logContext } from '../../utils/log-context';
import { log, logFailure } from '../../utils/logger';
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
 * LOGS (source cache): CACHE_INFO at start (where, host only), when Redis connects / comes back, a summary every
 * STATS_EVERY_MINUTES (hits, misses, per kind); CACHE_<FAILURE> (UNREACHABLE, BAD_CREDENTIALS, TIMEOUT ...) with the fix,
 * at most once a minute; every API_REQUEST line carries cacheHits / cacheMisses when the request used the cache.
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

const stats = { hits: 0, misses: 0, errors: 0, byKind: new Map<string, { hits: number; misses: number }>() };
const errorLog = { last: 0, suppressed: 0 };

/** Where answers are kept right now. */
export const cacheMode = (): CacheMode =>
  !env.cache.enabled ? CACHE_MODE.OFF : !remote ? CACHE_MODE.MEMORY : remote.ready ? CACHE_MODE.REDIS : CACHE_MODE.REDIS_DOWN;

const verKey = (ns: string) => `${env.cache.keyPrefix}${ns}:ver`;
const fullKey = (ns: string, ver: string, key: string) => `${env.cache.keyPrefix}${ns}:${ver}:${key}`;

const redisError = (op: string, err: unknown): void => {
  stats.errors++;
  const now = Date.now();
  if (now - errorLog.last < CACHE.ERROR_LOG_EVERY_MS) return void errorLog.suppressed++;
  const f = classifyError(LOG_SOURCE.CACHE, err);
  logFailure(LOG_SOURCE.CACHE, f.kind, `[cache] Redis ${op} failed: answers come from server memory / the DB meanwhile`, {
    op, errorCode: f.errorCode, error: f.error, mode: cacheMode(),
    ...(errorLog.suppressed ? { similarErrorsSinceLastLine: errorLog.suppressed } : {}),
  });
  errorLog.last = now;
  errorLog.suppressed = 0;
};

/** Runs on Redis when it answers, else on memory; a Redis error falls back to memory for this call. */
const onStore = async <T>(op: string, fn: (s: KvStore) => Promise<T>): Promise<T> => {
  const r = remote;
  if (!r?.ready) return fn(memory);
  try {
    return await fn(r);
  } catch (err) {
    redisError(op, err);
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

const count = (ns: string, hit: boolean): void => {
  const k = stats.byKind.get(ns) ?? { hits: 0, misses: 0 };
  if (hit) { stats.hits++; k.hits++; } else { stats.misses++; k.misses++; }
  stats.byKind.set(ns, k);
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
    const text = JSON.stringify(value);
    if (text === undefined) return value;
    if (text.length > CACHE.VALUE_MAX_KB * 1024) {
      const last = tooBigLogged.get(id) ?? 0;
      if (Date.now() - last > 600_000) {
        tooBigLogged.set(id, Date.now());
        log.warn(LOG_SOURCE.CACHE, `[cache] ${id} not cached: ${Math.round(text.length / 1024)} KB is over ${CACHE.VALUE_MAX_KB} KB (served from the DB every time)`, { ns, kb: Math.round(text.length / 1024) });
      }
      return value;
    }
    await onStore('write', (s) => s.set(fullKey(ns, ver, key), text, ttlSeconds));
    log.debug(LOG_SOURCE.CACHE, `[cache] ${id} loaded in ${Date.now() - started} ms, kept ${ttlSeconds} s`, { ns, ms: Date.now() - started, kb: Math.round(text.length / 1024) });
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
    redisError('clear', err);
  }
};

/** Every kind dropped (Redis came back; tests between cases). */
const forgetAllCaches = async (): Promise<void> => {
  for (const ns of Object.values(CACHE_NS)) await forgetCache(ns);
};

const logStats = (): void => {
  const total = stats.hits + stats.misses;
  if (total) {
    log.info(LOG_SOURCE.CACHE, `[cache] ${stats.hits} of ${total} answers from the cache (${Math.round((stats.hits / total) * 100)}%)`, {
      mode: cacheMode(), hits: stats.hits, misses: stats.misses, errors: stats.errors, memoryKeys: memory.size,
      byKind: Object.fromEntries(stats.byKind),
    });
  }
  Object.assign(stats, { hits: 0, misses: 0, errors: 0 });
  stats.byKind.clear();
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
  if (!c.enabled) return void log.info(LOG_SOURCE.CACHE, '[cache] OFF (CACHE_ENABLED=false): every answer comes from the DB');
  statsTimer ??= setInterval(logStats, CACHE.STATS_EVERY_MINUTES * 60_000);
  statsTimer.unref();
  if (!c.redisUrl) {
    return void log.info(LOG_SOURCE.CACHE, `[cache] server memory (REDIS_URL not set), answers kept ${c.ttlSeconds} s`, { mode: CACHE_MODE.MEMORY, ttlSeconds: c.ttlSeconds });
  }
  const host = redisHost(c.redisUrl);
  let store: RedisStore;
  try {
    store = new RedisStore({ url: c.redisUrl, username: c.redisUsername, password: c.redisPassword, tls: c.redisTls, cluster: c.redisCluster });
  } catch (err) {
    logFailure(LOG_SOURCE.CACHE, 'CONFIG', '[cache] REDIS_URL not usable: server memory is used', { host, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let wasReady = false;
  store.client.on('error', (err: unknown) => redisError('connect', err));
  store.client.on('ready', () => {
    if (!wasReady) {
      wasReady = true;
      log.info(LOG_SOURCE.CACHE, `[cache] Redis connected: ${host}`, { mode: CACHE_MODE.REDIS, host, tls: c.redisTls, cluster: c.redisCluster, keyPrefix: c.keyPrefix, ttlSeconds: c.ttlSeconds });
      return;
    }
    // back after an outage: writes made meanwhile could not drop their answers in Redis, so drop every kind once
    void forgetAllCaches().then(() => log.info(LOG_SOURCE.CACHE, `[cache] Redis back: ${host}; every cached answer dropped once (writes during the outage)`, { host }));
  });
  store.client.on('end', () => log.warn(LOG_SOURCE.CACHE, `[cache] Redis connection closed: ${host}; server memory until it is back`, { host }));
  useRemoteStore(store);
  log.info(LOG_SOURCE.CACHE, `[cache] connecting to Redis ${host} (server memory until connected)`, { host, tls: c.redisTls, cluster: c.redisCluster });
};

/** Shutdown: closes the Redis connection. */
export const stopCache = async (): Promise<void> => {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = undefined;
  const r = remote;
  remote = null;
  if (r) await r.close();
};

/** Tests: empty memory and counters. */
export const resetCacheForTests = (): void => {
  memory.clear();
  inflight.clear();
  Object.assign(stats, { hits: 0, misses: 0, errors: 0 });
  stats.byKind.clear();
  errorLog.last = 0;
};
