import { isIP } from 'net';
import { Cluster, Redis, type RedisOptions } from 'ioredis';
import { CACHE } from '../../constants/cache';

/*
 * Where cached answers live (2026-11-10; used only by cache.service.ts). Both stores keep JSON text with a life in
 * seconds, and counters (the version of each kind of answer) without one.
 *   - MemoryStore: this server's memory (laptop, tests, scripts, and the fallback while Redis does not answer).
 *   - RedisStore: AWS ElastiCache (Redis OSS / Valkey) or any Redis, through ioredis. Every command fails fast (no
 *     waiting queue while disconnected, COMMAND_TIMEOUT_MS), so a Redis problem never holds a request.
 */

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Sets only when the key does not exist (no life): the first version of a kind. */
  setIfMissing(key: string, value: string): Promise<void>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<void>;
}

export class MemoryStore implements KvStore {
  private readonly data = new Map<string, { value: string; until: number }>();

  constructor(private readonly maxKeys: number = CACHE.MEMORY_MAX_KEYS) {}

  get size(): number {
    return this.data.size;
  }

  async get(key: string): Promise<string | null> {
    const hit = this.data.get(key);
    if (!hit) return null;
    if (hit.until <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.put(key, value, Date.now() + ttlSeconds * 1000);
  }

  async setIfMissing(key: string, value: string): Promise<void> {
    if (!(await this.get(key))) this.put(key, value, Infinity);
  }

  async incr(key: string): Promise<number> {
    const next = (Number(await this.get(key)) || 0) + 1;
    this.put(key, String(next), Infinity);
    return next;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  private put(key: string, value: string, until: number): void {
    this.data.delete(key); // re-inserted last: the Map's order is then oldest first
    if (this.data.size >= this.maxKeys) {
      const now = Date.now();
      for (const [k, v] of this.data) if (v.until <= now) this.data.delete(k);
      // still full: drop the oldest tenth
      if (this.data.size >= this.maxKeys) [...this.data.keys()].slice(0, Math.ceil(this.maxKeys / 10)).forEach((k) => this.data.delete(k));
    }
    this.data.set(key, { value, until });
  }
}

export interface RedisSettings {
  url: string;
  username?: string;
  password?: string;
  tls: boolean;
  cluster: boolean;
}

/** host:port of the URL, for log lines (never the user / password). */
export const redisHost = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '6379'}`;
  } catch {
    return '(not a URL)';
  }
};

export class RedisStore implements KvStore {
  readonly client: Redis | Cluster;

  constructor(s: RedisSettings) {
    const u = new URL(s.url);
    if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error(`REDIS_URL must start with redis:// or rediss:// (got ${u.protocol})`);
    const common: RedisOptions = {
      username: s.username ?? (u.username ? decodeURIComponent(u.username) : undefined),
      password: s.password ?? (u.password ? decodeURIComponent(u.password) : undefined),
      // ElastiCache in-transit encryption: TLS with the server name of the endpoint
      // (no server name for an IP address: TLS does not allow it)
      tls: s.tls ? (isIP(u.hostname) ? {} : { servername: u.hostname }) : undefined,
      connectTimeout: CACHE.CONNECT_TIMEOUT_MS,
      commandTimeout: CACHE.COMMAND_TIMEOUT_MS,
      // no queue while disconnected: a command fails at once and the caller uses memory / the DB
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, CACHE.RETRY_MAX_MS),
    };
    const port = Number(u.port || 6379);
    this.client = s.cluster
      ? new Cluster([{ host: u.hostname, port }], {
        // ElastiCache Serverless / cluster mode: keep the endpoint names (TLS checks them), no offline queue
        dnsLookup: (address, done) => done(null, address),
        enableOfflineQueue: false,
        clusterRetryStrategy: (times) => Math.min(times * 500, CACHE.RETRY_MAX_MS),
        redisOptions: common,
      })
      : new Redis({ ...common, host: u.hostname, port, db: Number(u.pathname.slice(1)) || 0 });
  }

  get ready(): boolean {
    return this.client.status === 'ready';
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async setIfMissing(key: string, value: string): Promise<void> {
    await this.client.set(key, value, 'NX');
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
