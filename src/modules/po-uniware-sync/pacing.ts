import { createHash } from 'crypto';
import { AppDataSource } from '../../config/data-source';
import { PO_UNIWARE_SYNC } from '../../constants';
import { isThrottled } from './uniware-client';

/* Run pacing and the run lock of the channel PO sync (our own copy, 2026-11-06). */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Minutes until the next run: the interval after a good run; after a failed one twice the last wait, at most MAX_DELAY_MIN. */
export const nextDelayOf = (interval: number, failed: boolean, previous: number | null | undefined): number => {
  const base = Math.max(1, interval);
  if (!failed) return base;
  return Math.min(PO_UNIWARE_SYNC.MAX_DELAY_MIN, Math.max(base, previous ?? base) * 2);
};

/**
 * Runs `work` over items, `concurrency` at a time, each lane pausing `gapMs` after every item. A work that throws a
 * 429 (isThrottled) stops the run: no new item starts; the rest is `notStarted`.
 */
export const runGentle = async <T>(items: T[], o: { concurrency: number; gapMs: number }, work: (t: T) => Promise<void>) => {
  let next = 0;
  let throttled = false;
  const lane = async () => {
    while (!throttled && next < items.length) {
      const t = items[next++];
      try {
        await work(t);
      } catch (err) {
        if (isThrottled(err)) throttled = true;
      }
      if (!throttled && next < items.length && o.gapMs > 0) await sleep(o.gapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, o.concurrency), items.length) }, lane));
  return { throttled, notStarted: items.length - next };
};

/**
 * `job` under the MySQL lock `name` (servers share the database), waiting up to `waitS` seconds; null = another
 * server holds it (the job did not run).
 */
export const withRunLock = async <T>(name: string, job: () => Promise<T>, waitS = 0): Promise<T | null> => {
  const lock = name.length <= 64 ? name : `po:${createHash('sha1').update(name).digest('hex')}`;
  const qr = AppDataSource.createQueryRunner();
  await qr.connect();
  try {
    const [got] = (await qr.query('SELECT GET_LOCK(?, ?) AS got', [lock, waitS])) as { got: number | string | null }[];
    if (Number(got?.got) !== 1) return null;
    try {
      return await job();
    } finally {
      await qr.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => undefined);
    }
  } finally {
    await qr.release();
  }
};
