import { EventEmitter } from 'events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { FLIPKART, MYNTRA_STR } from '../../src/constants';
import { setFlipkartAfterStored, startRobotRun } from '../../src/modules/channel-api/flipkart/consignments.service';
import { robotGapWaitMs, runSellerHubJob } from '../../src/modules/intransit/runs.service';
import { closeDb, resetDb } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';
import { fkBulk, fkCsv, fkRobot, seedFlipkart } from '../helpers/flipkart';

/*
 * Load (2026-11-04, user: "don't put too much load on the server"):
 *   1. browser robots are spaced out: a robot job waits ROBOT_GAP after the last worker job ended (the place is held
 *      meanwhile, so nothing slips in); the worker process itself is replaced here by a fake child.
 *   2. Flipkart is event-driven: a robot run that stored consignments starts the process run at once; one that stored
 *      nothing does not; the connector's timer is only a 6-hour safety net (Myntra too).
 */

const child = vi.hoisted((): { forks: number[]; answer: unknown } => ({ forks: [], answer: 'ok' }));
vi.mock('child_process', async (orig) => ({
  ...(await orig<object>()),
  fork: vi.fn(() => {
    child.forks.push(Date.now());
    const c = new EventEmitter() as EventEmitter & { pid?: number; send: (m: unknown) => boolean; kill: () => boolean };
    c.send = () => { setTimeout(() => c.emit('message', { type: 'done', result: child.answer }), 20); return true; };
    c.kill = () => true;
    return c;
  }),
}));

const seller = env.intransit.flipkart.sellerHub;
const saved = { user: seller.user, password: seller.password };

beforeEach(async () => {
  await resetDb();
  child.forks = [];
  process.env.ROBOT_GAP_SECONDS = '1';
});
afterEach(() => {
  delete process.env.ROBOT_GAP_SECONDS;
  Object.assign(seller, saved);
});
afterAll(closeDb);

describe('1. robots spaced out', () => {
  it('a robot job right after another one waits the gap first, and says so', async () => {
    const lines: string[] = [];
    const job = (n: string) => runSellerHubJob<unknown>(n, (dir) => ({ kind: MYNTRA_STR.ROBOT_JOB, myntra: {}, cacheDir: dir, strs: [] }), 5_000, (l) => lines.push(l));
    await job('first');
    const ended = Date.now();
    expect(robotGapWaitMs(1_000)).toBeGreaterThan(0);
    await job('second');
    expect(child.forks).toHaveLength(2);
    expect(child.forks[1] - ended).toBeGreaterThanOrEqual(900);
    expect(lines.some((l) => l.startsWith('spacing robots: starting in'))).toBe(true);
    // a job long after the last one does not wait
    expect(robotGapWaitMs(1_000, Date.now() + 5_000)).toBe(0);
  });
});

describe('2. Flipkart processes right after its robot', () => {
  it('stored consignments -> the process run starts at once; nothing new -> it does not; the timer is a safety net', async () => {
    const m = await seedMasters();
    await seedFlipkart(m);
    Object.assign(seller, { user: 'test-seller', password: 'test-password' });
    process.env.ROBOT_GAP_SECONDS = '0';
    let processed = 0;
    setFlipkartAfterStored(() => { processed++; });
    child.answer = fkRobot([{ id: '205180001', row: 'ID: 205180001', csv: fkCsv([{ qty: 10, cost: 74.85 }]) }], fkBulk([{ id: '205180001', qty: 10 }]));
    expect((await startRobotRun('test')).stored).toBe(1);
    expect(processed).toBe(1);
    // the same consignment again: nothing new stored, no process run
    expect((await startRobotRun('test')).stored).toBe(0);
    expect(processed).toBe(1);
    expect(FLIPKART.POLL_MINUTES).toBe(360);
    expect(MYNTRA_STR.POLL_MINUTES).toBe(360);
  });
});
