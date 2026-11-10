import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { CACHE, CACHE_NS } from '../../src/constants/cache';
import { MemoryStore } from '../../src/modules/cache/cache.store';
import { cached, cacheMode, forgetCache, resetCacheForTests, useRemoteStore, type RemoteStore } from '../../src/modules/cache/cache.service';
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
  private check() { if (this.failing) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), { code: 'ECONNREFUSED' }); }
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
    const load = loader([1, 2]);
    await cached(CACHE_NS.APPROVALS, 'list', load);
    expect(redis.keys[0]).toMatch(new RegExp(`^${env.cache.keyPrefix}approvals:\\d+:list$`));

    resetCacheForTests(); // "another server": its own memory is empty, Redis is shared
    expect(await cached(CACHE_NS.APPROVALS, 'list', load)).toEqual([1, 2]);
    expect(load).toHaveBeenCalledTimes(1);

    await forgetCache(CACHE_NS.APPROVALS);
    resetCacheForTests();
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
