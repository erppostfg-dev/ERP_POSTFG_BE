import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AppDataSource } from '../../src/config/data-source';
import { env } from '../../src/config/env';
import { s3Client } from '../../src/config/s3';
import { CHANNELS } from '../../src/constants';
import { readS3JsonCached, writeS3Text } from '../../src/modules/email-intake/s3-mirror.service';
import { forgetMasters } from '../../src/modules/masters/masters.cache';
import { MasterDataReader, panelMasterFor } from '../../src/modules/po-validation/master-data';
import { CACHE, CACHE_NS } from '../../src/constants/cache';
import { MemoryStore } from '../../src/modules/cache/cache.store';
import { cached, cacheMode, forgetCache, logCacheStatsForTests, resetCacheForTests, useRemoteStore, type RemoteStore } from '../../src/modules/cache/cache.service';
import { logContext, newContext, runInContext } from '../../src/utils/log-context';
import { bumpReview } from '../../src/modules/po-review/po-review.live';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, insert, resetDb } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';

/*
 * The shared cache (2026-11-10, modules/cache): AWS ElastiCache (Redis) when REDIS_URL is set, server memory otherwise.
 * An answer is loaded once and shared; a write drops it at once (forgetCache); CACHE_TTL_SECONDS (60) is the safety net;
 * Redis down / failing never fails a request. Then the APIs that use it: a direct DB change is NOT seen (cached), the
 * API write that changes the data IS seen at once.
 */

/** A Redis stand-in: a memory store that can be "down" or fail every command. */
class FakeRedis extends MemoryStore implements RemoteStore {
  ready = true;
  failing = false;
  keys: string[] = [];
  /** What the next command throws (null = it works). */
  error: Error | null = null;
  private check() {
    if (this.failing) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), { code: 'ECONNREFUSED' });
    if (this.error) throw this.error;
  }
  async get(k: string) { this.check(); return super.get(k); }
  async set(k: string, v: string, ttl: number) { this.check(); this.keys.push(k); return super.set(k, v, ttl); }
  async incr(k: string) { this.check(); return super.incr(k); }
  async del(k: string) { this.check(); return super.del(k); }
  async close() { this.ready = false; }
}

const loader = <T>(value: T) => {
  const fn = vi.fn(async () => value);
  return fn;
};

afterEach(() => {
  useRemoteStore(null);
  vi.useRealTimers();
});

describe('cache layer', () => {
  beforeEach(() => resetCacheForTests());

  it('loads once, then answers from the cache; callers at the same moment share one load', async () => {
    const load = loader({ n: 1 });
    expect(await cached(CACHE_NS.MASTERS, 'a', load)).toEqual({ n: 1 });
    expect(await cached(CACHE_NS.MASTERS, 'a', load)).toEqual({ n: 1 });
    expect(load).toHaveBeenCalledTimes(1);

    const slow = vi.fn(() => new Promise<number>((r) => setTimeout(() => r(7), 20)));
    expect(await Promise.all([1, 2, 3].map(() => cached(CACHE_NS.MASTERS, 'b', slow)))).toEqual([7, 7, 7]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('forgetCache drops one kind (or one key) at once, not the others', async () => {
    const a = loader('a');
    const b = loader('b');
    const c = loader('c');
    await cached(CACHE_NS.MASTERS, 'x', a);
    await cached(CACHE_NS.MASTERS, 'y', b);
    await cached(CACHE_NS.APPROVALS, 'x', c);
    await forgetCache(CACHE_NS.MASTERS);
    await cached(CACHE_NS.MASTERS, 'x', a);
    await cached(CACHE_NS.MASTERS, 'y', b);
    await cached(CACHE_NS.APPROVALS, 'x', c);
    expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([2, 2, 1]);

    await forgetCache(CACHE_NS.MASTERS, 'x');
    await cached(CACHE_NS.MASTERS, 'x', a);
    await cached(CACHE_NS.MASTERS, 'y', b);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([3, 2]);
  });

  it('an answer is kept CACHE_TTL_SECONDS (60), then loaded again', async () => {
    expect(env.cache.ttlSeconds).toBe(CACHE.TTL_SECONDS);
    vi.useFakeTimers({ toFake: ['Date'] });
    const load = loader(1);
    await cached(CACHE_NS.MASTERS, 't', load);
    vi.setSystemTime(Date.now() + 59_000);
    await cached(CACHE_NS.MASTERS, 't', load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await cached(CACHE_NS.MASTERS, 't', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failed load is not kept; the answer is JSON (dates as text) for the first caller too', async () => {
    const bad = vi.fn(async () => { throw new Error('db down'); });
    await expect(cached(CACHE_NS.MASTERS, 'f', bad)).rejects.toThrow('db down');
    expect(await cached(CACHE_NS.MASTERS, 'f', loader('ok'))).toBe('ok');

    const at = new Date('2026-11-10T10:00:00Z');
    expect(await cached(CACHE_NS.MASTERS, 'd', loader({ at }))).toEqual({ at: at.toISOString() });
    expect(await cached(CACHE_NS.MASTERS, 'd', loader({ at }))).toEqual({ at: at.toISOString() });
  });

  it('an answer loaded while a write happened is not served afterwards', async () => {
    let release!: (v: string) => void;
    const old = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const pending = cached(CACHE_NS.MASTERS, 'race', old);
    await new Promise((r) => setTimeout(r, 5));
    await forgetCache(CACHE_NS.MASTERS); // the write commits while the old answer is still loading
    release('old');
    expect(await pending).toBe('old');
    expect(await cached(CACHE_NS.MASTERS, 'race', loader('new'))).toBe('new');
  });

  it('too big answers are not cached', async () => {
    const big = loader('x'.repeat(CACHE.VALUE_MAX_KB * 1024 + 10));
    await cached(CACHE_NS.MASTERS, 'big', big);
    await cached(CACHE_NS.MASTERS, 'big', big);
    expect(big).toHaveBeenCalledTimes(2);
  });

  it('CACHE_ENABLED=false: every call loads', async () => {
    env.cache.enabled = false;
    try {
      const load = loader(1);
      await cached(CACHE_NS.MASTERS, 'off', load);
      await cached(CACHE_NS.MASTERS, 'off', load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(cacheMode()).toBe('off');
    } finally {
      env.cache.enabled = true;
    }
  });

  it('Redis: answers are shared between servers (another server finds them) and a write on one drops them for all', async () => {
    const redis = new FakeRedis();
    useRemoteStore(redis);
    expect(cacheMode()).toBe('redis');
    await cached(CACHE_NS.FEEDBACK_BELL, 'connect', loader(0)); // connected (drops what Redis kept from before)
    await new Promise((r) => setTimeout(r, 10));
    const load = loader([1, 2]);
    await cached(CACHE_NS.APPROVALS, 'list', load);
    expect(redis.keys.at(-1)).toMatch(new RegExp(`^${env.cache.keyPrefix}approvals:\\d+:list$`));

    resetCacheForTests(true); // "another server" (already running): its own memory is empty, Redis is shared
    expect(await cached(CACHE_NS.APPROVALS, 'list', load)).toEqual([1, 2]);
    expect(load).toHaveBeenCalledTimes(1);

    await forgetCache(CACHE_NS.APPROVALS);
    resetCacheForTests(true);
    await cached(CACHE_NS.APPROVALS, 'list', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('Redis failing or down: requests still answer (server memory), nothing throws', async () => {
    const redis = new FakeRedis();
    useRemoteStore(redis);
    redis.failing = true;
    const load = loader('fine');
    expect(await cached(CACHE_NS.MASTERS, 'r', load)).toBe('fine');
    expect(await cached(CACHE_NS.MASTERS, 'r', load)).toBe('fine');
    expect(load).toHaveBeenCalledTimes(1); // the memory fallback kept it
    await expect(forgetCache(CACHE_NS.MASTERS)).resolves.toBeUndefined();
    expect(await cached(CACHE_NS.MASTERS, 'r', load)).toBe('fine');
    expect(load).toHaveBeenCalledTimes(2); // the write still dropped the memory copy

    redis.failing = false;
    redis.ready = false;
    expect(cacheMode()).toBe('redis_down');
    expect(await cached(CACHE_NS.MASTERS, 'r', load)).toBe('fine');
    expect(redis.keys).toHaveLength(0); // never written while down
  });
});

/** Log lines written while `fn` runs (LOG_LEVEL info for the test), as text. */
const linesOf = async (fn: () => Promise<void>): Promise<string[]> => {
  const out: string[] = [];
  const level = env.log.level;
  env.log.level = 'info';
  const grab = (chunk: unknown) => { out.push(String(chunk)); return true; };
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(grab);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(grab);
  try { await fn(); } finally { o.mockRestore(); e.mockRestore(); env.log.level = level; }
  return out.filter((l) => / cache /.test(l) || /CACHE_/.test(l));
};
const codes = (lines: string[]) => lines.map((l) => / (CACHE_[A-Z_]+) /.exec(l)?.[1]).filter(Boolean);

describe('memory store: RAM only, bounded (never grows without limit)', () => {
  it('a write frees the old answers of that kind at once (not only when they expire)', async () => {
    const m = new MemoryStore();
    await m.set('postfg:masters:1:pep-skus', 'x'.repeat(100_000), 60);
    await m.set('postfg:masters:1:channel-skus', 'x'.repeat(100_000), 60);
    await m.set('postfg:approvals:1:list', 'y', 60);
    await m.incr('postfg:masters:ver');
    expect(m.bytes).toBeGreaterThan(400_000);
    m.dropPrefix('postfg:masters:', 'postfg:masters:ver');
    expect(m.size).toBe(2); // the approvals answer + the masters version
    expect(m.bytes).toBeLessThan(1_000);
  });

  it('never holds more than its limit: the oldest answers go first; one too big is not kept', async () => {
    const m = new MemoryStore(1_000_000); // 1 MB
    for (let i = 0; i < 10; i++) await m.set(`k${i}`, 'x'.repeat(100_000), 60); // 200 KB each
    expect(m.bytes).toBeLessThanOrEqual(1_000_000);
    expect(await m.get('k0')).toBeNull();
    expect(await m.get('k9')).not.toBeNull();
    await m.set('huge', 'x'.repeat(600_000), 60); // 1.2 MB
    expect(await m.get('huge')).toBeNull();
  });

  it('expired answers are swept within a minute even if nobody reads them again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const m = new MemoryStore();
    await m.set('old', 'x'.repeat(10_000), 1);
    vi.setSystemTime(Date.now() + 61_000);
    await m.set('new', 'y', 60);
    expect(m.size).toBe(1);
    expect(m.bytes).toBeLessThan(100);
  });

  it('through the cache: forgetting a kind frees its RAM', async () => {
    resetCacheForTests();
    for (let i = 0; i < 5; i++) await cached(CACHE_NS.MASTERS, `list${i}`, loader('x'.repeat(50_000)));
    await cached(CACHE_NS.APPROVALS, 'badge', loader(1));
    await forgetCache(CACHE_NS.MASTERS);
    for (let i = 0; i < 5; i++) await cached(CACHE_NS.MASTERS, `list${i}`, loader('x'.repeat(50_000)));
    // 5 answers, not 10: the old ones were freed by the write
    const stats = await (async () => {
      const out: string[] = [];
      const level = env.log.level;
      env.log.level = 'info';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true; });
      try { logCacheStatsForTests(); } finally { spy.mockRestore(); env.log.level = level; }
      return out.join('');
    })();
    expect(stats).toMatch(/memoryKeys=(\d+)/);
    expect(Number(/memoryKeys=(\d+)/.exec(stats)![1])).toBeLessThanOrEqual(8); // 5 masters + 1 approvals + 2 versions
  });
});

describe('cache logs: few lines, each says what to fix', () => {
  beforeEach(() => resetCacheForTests());

  it('Redis down: ONE CACHE_DOWN with the fix, no line per request; back = ONE CACHE_UP', async () => {
    const redis = new FakeRedis();
    useRemoteStore(redis);
    const lines = await linesOf(async () => {
      await cached(CACHE_NS.MASTERS, 'a', loader(1)); // first command works: connected
      redis.failing = true;
      for (let i = 0; i < 20; i++) await cached(CACHE_NS.MASTERS, `k${i}`, loader(i));
      redis.failing = false;
      await cached(CACHE_NS.MASTERS, 'b', loader(2));
      await new Promise((r) => setTimeout(r, 10)); // CACHE_UP is written after every kind is dropped
    });
    expect(codes(lines)).toEqual(['CACHE_CONNECTED', 'CACHE_DOWN', 'CACHE_UP']);
    const down = lines.find((l) => l.includes('CACHE_DOWN'))!;
    expect(down).toContain('ECONNREFUSED');
    expect(down).toContain('security group');
  });

  it('a server start drops what Redis kept from before (a deploy / migration / script may have changed the DB)', async () => {
    const redis = new FakeRedis();
    useRemoteStore(redis);
    expect(await cached(CACHE_NS.MASTERS, 'list', loader('old'))).toBe('old');
    await new Promise((r) => setTimeout(r, 10));
    // restart: Redis still holds 'old'; the DB was changed directly meanwhile (migration / script)
    resetCacheForTests();
    useRemoteStore(redis);
    const lines = await linesOf(async () => {
      await cached(CACHE_NS.APPROVALS, 'x', loader(1)); // first command: connected
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(codes(lines)).toEqual(['CACHE_CONNECTED']);
    expect(lines[0]).toContain('dropped once');
    expect(await cached(CACHE_NS.MASTERS, 'list', loader('new'))).toBe('new');
  });

  it('still down: CACHE_STILL_DOWN at most every 5 minutes, with the count', async () => {
    const redis = new FakeRedis();
    useRemoteStore(redis);
    redis.failing = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    const lines = await linesOf(async () => {
      await cached(CACHE_NS.MASTERS, 'a', loader(1));
      await cached(CACHE_NS.MASTERS, 'b', loader(1));
      vi.setSystemTime(Date.now() + CACHE.REPEAT_LOG_EVERY_MS + 1);
      await cached(CACHE_NS.MASTERS, 'c', loader(1));
      await cached(CACHE_NS.MASTERS, 'd', loader(1));
    });
    expect(codes(lines)).toEqual(['CACHE_DOWN', 'CACHE_STILL_DOWN']);
    expect(lines[1]).toMatch(/errors=\d+/);
  });

  it('a command error while connected names the fix (memory full, wrong password, cluster), once per 5 min', async () => {
    const redis = new FakeRedis();
    useRemoteStore(redis);
    await cached(CACHE_NS.MASTERS, 'warm', loader(1));
    const lines = await linesOf(async () => {
      redis.error = new Error("OOM command not allowed when used memory > 'maxmemory'.");
      await cached(CACHE_NS.MASTERS, 'x', loader(1));
      await cached(CACHE_NS.MASTERS, 'y', loader(1));
      redis.error = new Error('WRONGPASS invalid username-password pair or user is disabled.');
      await cached(CACHE_NS.MASTERS, 'z', loader(1));
      redis.error = new Error('MOVED 3999 10.0.0.9:6379');
      await cached(CACHE_NS.MASTERS, 'w', loader(1));
    });
    expect(codes(lines)).toEqual(['CACHE_CONFIG', 'CACHE_BAD_CREDENTIALS', 'CACHE_CONFIG']);
    expect(lines[0]).toContain('allkeys-lru');
    expect(lines[1]).toContain('REDIS_PASSWORD');
    expect(lines[2]).toContain('REDIS_CLUSTER=true');
  });

  it('CACHE_STATS: one summary with hit % and per kind; nothing when unused', async () => {
    expect(codes(await linesOf(async () => logCacheStatsForTests()))).toEqual([]);
    const load = loader(1);
    await cached(CACHE_NS.APPROVALS, 'a', load);
    await cached(CACHE_NS.APPROVALS, 'a', load);
    await cached(CACHE_NS.APPROVALS, 'a', load);
    const lines = await linesOf(async () => logCacheStatsForTests());
    expect(codes(lines)).toEqual(['CACHE_STATS']);
    expect(lines[0]).toContain('2 of 3 answers from the cache (67%)');
    expect(lines[0]).toContain('approvals');
  });

  it('a request that waits for a load another request started is marked cacheShared (its dbQueries are on the other)', async () => {
    const slow = () => new Promise<number>((r) => setTimeout(() => r(1), 20));
    const call = () => runInContext(newContext({ requestId: 'r' }), async () => {
      await cached(CACHE_NS.MASTERS, 'shared', slow);
      return { ...logContext() };
    });
    const [first, second] = await Promise.all([call(), call()]);
    expect([first.cacheMisses, first.cacheShared]).toEqual([1, undefined]);
    expect([second.cacheMisses, second.cacheShared]).toEqual([1, 1]);
    const later = await call();
    expect([later.cacheHits, later.cacheShared]).toEqual([1, undefined]);
  });

  it('normal requests write no cache lines at all', async () => {
    const lines = await linesOf(async () => {
      for (let i = 0; i < 10; i++) await cached(CACHE_NS.MASTERS, 'same', loader(1));
      await forgetCache(CACHE_NS.MASTERS);
    });
    expect(lines).toEqual([]);
  });
});

describe('APIs on the cache', () => {
  let admin: TestLogin;
  beforeEach(async () => {
    await resetDb();
    admin = await loginAs('admin');
  });
  afterAll(closeDb);

  it('GET /health says where answers are kept (memory in tests)', async () => {
    expect((await api().get('/api/v1/health').expect(200)).body.data.cache).toBe('memory');
  });

  it('Masters lists: a direct DB change is not seen (cached); an add through the API is seen at once', async () => {
    const m = await seedMasters();
    const list = async () => (await api().get('/api/v1/masters/pep-skus').set('Cookie', admin.cookie).expect(200)).body.data as { pepCode: string }[];
    const before = (await list()).length;
    await insert('master_skus', { pep_code: 'DIRECT_SQL_1', product_name: 'direct', mrp: 10 });
    expect((await list()).length).toBe(before);
    await api().post('/api/v1/masters/pep-skus').set('Cookie', admin.cookie).send({
      pepCode: 'MCAFF_CACHE_NEW', productName: 'New test SKU', brand: 'mCaffeine', productType: 'SIMPLE', mrp: 299, gstTaxType: '18',
      eanCode: '8906000000031', hsnCode: '33049990', lengthMm: 10, widthMm: 10, heightMm: 10, weightG: 50, shelfLife: 365, isActive: true,
    }).expect(201);
    expect((await list()).map((s) => s.pepCode)).toEqual(expect.arrayContaining(['DIRECT_SQL_1', 'MCAFF_CACHE_NEW', m.pepCode]));
  });

  it('Approvals badge: cached for everyone; a review change (bumpReview) shows at once', async () => {
    await seedMasters();
    const pending = async () => (await api().get('/api/v1/approvals/po-reviews?status=pending&pageSize=1').set('Cookie', admin.cookie).expect(200)).body.meta.counts.pending ?? 0;
    expect(await pending()).toBe(0);
    const uploadId = await insert('po_uploads', { source: 'manual', channel: 'BigBasket', po_number: 'PO-CACHE-1', status: 'pending_approval', ocr_status: 'success' });
    await insert('po_review_submissions', { upload_id: uploadId, type: 'approval', status: 'pending', po_number: 'PO-CACHE-1', channel: 'BigBasket', submitted_at: new Date() });
    expect(await pending()).toBe(0);
    bumpReview();
    expect(await pending()).toBe(1);
  });

  it('Feedback bell: per person, a notification and "read" show at once', async () => {
    const dev = await loginAs('developer');
    const bell = async () => (await api().get('/api/v1/feedback/notifications').set('Cookie', dev.cookie).expect(200)).body.data as { unread: number };
    expect((await bell()).unread).toBe(0);
    await api().post('/api/v1/feedback').set('Cookie', admin.cookie)
      .send({ type: 'problem', title: 'Slow', description: 'x', severity: 'annoying', assignedToId: String(dev.userId) }).expect(201);
    expect((await bell()).unread).toBe(1);
    await api().post('/api/v1/feedback/notifications/read').set('Cookie', dev.cookie).send({}).expect(200);
    expect((await bell()).unread).toBe(0);
  });
});

describe('part 2: PO Review lists, PO panel master data, processed.json', () => {
  let admin: TestLogin;
  beforeEach(async () => {
    await resetDb();
    admin = await loginAs('admin');
  });

  it('PO Review lists: the same page is shared; a new PO (any process) shows at once; our actions drop them', async () => {
    await seedMasters();
    const list = async () => (await api().get('/api/v1/po-review?status=needs_review').set('Cookie', admin.cookie).expect(200)).body.data as { poNumber: string; openIssues: number }[];
    const first = await insert('po_uploads', { source: 'manual', channel: 'BigBasket', po_number: 'PO-L1', status: 'needs_review', ocr_status: 'success' });
    expect((await list()).map((i) => i.openIssues)).toEqual([0]);
    // a change the version does not see (issue rows): still the cached page...
    await insert('po_issues', { upload_id: first, issue_type: 'SKU_NOT_MAPPED', status: 'open' });
    expect((await list()).map((i) => i.openIssues)).toEqual([0]);
    // ...our own actions drop the lists at once
    bumpReview();
    expect((await list()).map((i) => i.openIssues)).toEqual([1]);
    // a new upload written by another process (no bumpReview): new version = new key, seen at once
    await insert('po_uploads', { source: 'manual', channel: 'BigBasket', po_number: 'PO-L2', status: 'needs_review', ocr_status: 'success' });
    expect((await list()).map((i) => i.poNumber)).toEqual(['PO-L1', 'PO-L2']);
  });

  it('panel master data: cached and dropped by a master change; decisions (MasterDataReader) always read fresh', async () => {
    const m = await seedMasters();
    const codes = async () => [...((await panelMasterFor(AppDataSource, CHANNELS.BIGBASKET))?.skusByCode.keys() ?? [])];
    expect(await codes()).toEqual([m.channelCode.toLowerCase()]);
    await insert('master_channel_skus', {
      pep_code: m.pepCode, pep_sku_id: m.pepSkuId, channel_id: m.channelId, channel_name: 'BigBasket', channel_code: 'BB-DIRECT-2', product_name: 'x',
      brand_name: 'mCaffeine', mrp: 499, margin: 0.3, rate_after_margin: 349.3, is_active: 1,
    });
    expect(await codes()).toHaveLength(1); // the panel: cached
    expect((await new MasterDataReader(AppDataSource).forChannel(CHANNELS.BIGBASKET))?.skusByCode.size).toBe(2); // a decision: fresh
    await forgetMasters();
    expect(await codes()).toHaveLength(2);
  });

  it('processed.json for the panels: cached; writing that file again drops it', async () => {
    const url = `s3://${env.s3.bucket}/test/cache/processed.json`;
    await writeS3Text(url, JSON.stringify({ v: 1 }));
    expect(await readS3JsonCached(url)).toEqual({ v: 1 });
    // changed behind our back (not through putBody): the panel keeps the cached copy for at most 60 s
    await s3Client().send(new PutObjectCommand({ Bucket: env.s3.bucket, Key: 'test/cache/processed.json', Body: JSON.stringify({ v: 2 }) }));
    expect(await readS3JsonCached(url)).toEqual({ v: 1 });
    // written by our code (re-read, corrected.json ...): dropped at once
    await writeS3Text(url, JSON.stringify({ v: 3 }));
    expect(await readS3JsonCached(url)).toEqual({ v: 3 });
  });
});
