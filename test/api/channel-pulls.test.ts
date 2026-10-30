import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env';
import { amazonConnector } from '../../src/modules/channel-api/amazon/amazon.connector';
import { pollMinutesOf } from '../../src/modules/channel-api/poll-schedule';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { clearS3 } from '../helpers/fake-s3';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { fkBulk, fkCsv, fkRobot, fkSwitchOn, seedFlipkart, WAREHOUSE } from '../helpers/flipkart';
import { covers } from '../helpers/routes';

/*
 * Channel Pulls page (2026-10-30): every channel pulled by API or robot, Run robot now, Process now, the robot's schedule.
 * The robot's browser part is replaced by a recorder (runSellerHubJob returns what Seller Hub would have shown); the
 * rest is real: the run is stored, the consignments listed, Process now takes them through the same PO chain.
 */
covers([
  'GET /channel-pulls', 'GET /channel-pulls/:key/items', 'GET /channel-pulls/:key/robot', 'POST /channel-pulls/:key/robot',
  'POST /channel-pulls/:key/process', 'PATCH /channel-pulls/:key/schedule',
]);

const robotJob = vi.hoisted(() => {
  const state: { result: unknown; error: Error | null; calls: number } = { result: null, error: null, calls: 0 };
  return state;
});
vi.mock('../../src/modules/intransit/runs.service', async (orig) => ({
  ...(await orig<object>()),
  runSellerHubJob: vi.fn(async () => {
    robotJob.calls++;
    if (robotJob.error) throw robotJob.error;
    return robotJob.result;
  }),
}));

type PullRow = Record<string, unknown> & { key: string; robot: Record<string, unknown>; counts: Record<string, number>; poll: unknown };
const V = '/api/v1/channel-pulls';
const FK_KEY = 'flipkart_seller_hub';
let m: Masters;
let admin: TestLogin;
let reviewer: TestLogin;
const seller = env.intransit.flipkart.sellerHub;
const saved = { user: seller.user, password: seller.password };

beforeEach(async () => {
  await resetDb();
  clearS3();
  m = await seedMasters();
  await seedFlipkart(m);
  admin = await loginAs('admin');
  reviewer = await loginAs('operations-executive');
  robotJob.calls = 0;
  robotJob.error = null;
  robotJob.result = fkRobot([{ id: '205149516', row: 'ID: 205149516', csv: fkCsv([{ qty: 10, cost: 74.85 }]) }], fkBulk([{ id: '205149516', qty: 10 }]));
  // the robot's Seller Hub login is "set" (a test value; the browser never runs here)
  Object.assign(seller, { user: 'test-seller', password: 'test-password' });
});
afterEach(() => Object.assign(seller, saved));
afterAll(closeDb);

const pull = async (who: TestLogin, key = FK_KEY) =>
  ((await api().get(V).set('Cookie', who.cookie).expect(200)).body.data as PullRow[]).find((p) => p.key === key)!;
const robotDone = async () => vi.waitFor(async () => {
  const r = (await api().get(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(200)).body.data;
  expect(r?.finishedAt).toBeTruthy();
  return r;
});

describe('who may use it (the Amazon Inbound page key)', () => {
  it('signed in with the page to read; editor to run, process and schedule', async () => {
    expect((await api().get(V)).status).toBe(401);
    const nobody = await loginAs(null);
    expect((await api().get(V).set('Cookie', nobody.cookie)).status).toBe(403);
    await api().get(V).set('Cookie', reviewer.cookie).expect(200);
    expect((await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', reviewer.cookie)).status).toBe(403);
    expect((await api().post(`${V}/${FK_KEY}/process`).set('Cookie', reviewer.cookie)).status).toBe(403);
    expect((await api().patch(`${V}/${FK_KEY}/schedule`).set('Cookie', reviewer.cookie).send({ robotEveryHours: 4 })).status).toBe(403);
  });
});

describe('the list', () => {
  it('every channel: Amazon by API, Flipkart by robot; set up, PO intake switch, counts', async () => {
    const all = (await api().get(V).set('Cookie', admin.cookie).expect(200)).body.data as { key: string; kind: string }[];
    expect(all.map((p) => [p.key, p.kind])).toEqual([['amazon_spapi', 'api'], [FK_KEY, 'robot']]);
    expect(await pull(admin)).toMatchObject({
      channel: 'flipkart', configured: true, intake: { enabled: false }, processing: false,
      robot: { running: false, lastRun: null, schedule: { everyHours: null }, nextRunAt: null }, counts: { fetched: 0, notTaken: 0, waiting: 0, taken: 0 },
    });
    expect((await api().get(`${V}/nope/items`).set('Cookie', admin.cookie)).status).toBe(404);
    expect((await api().get(`${V}/amazon_spapi/items`).set('Cookie', admin.cookie).expect(200)).body.data).toEqual([]);
  });
});

describe('Run robot now -> Process now', () => {
  it('the run is stored with its counts and log; Process now makes the PO; the list shows what each became', async () => {
    const started = await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(202);
    expect(started.body.data.key).toBe(FK_KEY);
    const run = await robotDone();
    expect(run).toMatchObject({ ok: true, listed: 1, stored: 1, failed: [], error: null });
    expect(run.trigger).toContain('run now');
    expect(robotJob.calls).toBe(1);
    expect((await pull(admin)).counts).toEqual({ fetched: 1, notTaken: 1, waiting: 0, taken: 0 });

    // OFF in PO intake: Process now takes nothing
    await api().post(`${V}/${FK_KEY}/process`).set('Cookie', admin.cookie).expect(202);
    await vi.waitFor(async () => expect((await pull(admin)).processing).toBe(false));
    expect(await count('po_uploads')).toBe(0);

    // ON: Process now -> the PO (same chain as every channel)
    await fkSwitchOn(admin.userId);
    const proc = await api().post(`${V}/${FK_KEY}/process`).set('Cookie', admin.cookie).expect(202);
    expect(proc.body.data.started).toBe('started');
    await vi.waitFor(async () => expect(await count('po_uploads', "external_id = '205149516' AND status = 'completed'")).toBe(1));
    const items = (await api().get(`${V}/${FK_KEY}/items`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(items).toEqual([expect.objectContaining({ externalId: '205149516', warehouse: WAREHOUSE, createdOn: '2026-10-24', upload: expect.objectContaining({ status: 'completed', poNumber: '205149516' }) })]);
    await vi.waitFor(async () => expect((await pull(admin)).counts).toMatchObject({ taken: 1, notTaken: 0 }));
  });

  it('refused: a channel without a robot, the login missing, a run already going', async () => {
    expect((await api().post(`${V}/amazon_spapi/robot`).set('Cookie', admin.cookie).expect(400)).body.error.code).toBe('CHANNEL_PULL_NO_ROBOT');
    expect((await api().get(`${V}/amazon_spapi/robot`).set('Cookie', admin.cookie).expect(400)).body.error.code).toBe('CHANNEL_PULL_NO_ROBOT');
    Object.assign(seller, { user: '', password: '' });
    expect((await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(409)).body.error.code).toBe('CHANNEL_PULL_NOT_CONFIGURED');
    expect((await pull(admin)).configured).toBe(false);
    Object.assign(seller, { user: 'test-seller', password: 'test-password' });
    // a slow robot: the second click while it runs is refused
    let release!: () => void;
    robotJob.result = new Promise((resolve) => { release = () => resolve(fkRobot([], fkBulk([]))); });
    await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(202);
    expect((await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(409)).body.error.code).toBe('CHANNEL_PULL_RUNNING');
    expect((await pull(admin)).robot.running).toBe(true);
    release();
    await robotDone();
  });

  it('a failed robot run is stored with its reason (the next run tries again)', async () => {
    robotJob.error = new Error('Seller Hub did not open the dashboard after the OTP');
    await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(202);
    const run = await robotDone();
    expect(run).toMatchObject({ ok: false, stored: 0, error: 'Seller Hub did not open the dashboard after the OTP' });
    expect(await count('channel_pull_items')).toBe(0);
  });
});

describe('the API schedule (Amazon: how often the server pulls)', () => {
  it('every 1-24 hours or its default; the server uses it for the next wait', async () => {
    const amazon = async () => (await pull(admin, 'amazon_spapi')).poll as Record<string, unknown>;
    expect(await amazon()).toMatchObject({ everyHours: null, defaultHours: 2 });
    expect(await pollMinutesOf(amazonConnector)).toBe(120);
    const set = await api().patch(`${V}/amazon_spapi/schedule`).set('Cookie', admin.cookie).send({ robotEveryHours: 1 }).expect(200);
    expect(set.body.data.poll).toMatchObject({ everyHours: 1, defaultHours: 2 });
    expect(set.body.data.robot).toBeNull();
    expect(await pollMinutesOf(amazonConnector)).toBe(60);
    await api().patch(`${V}/amazon_spapi/schedule`).set('Cookie', admin.cookie).send({ robotEveryHours: 25 }).expect(400);
    expect((await api().patch(`${V}/amazon_spapi/schedule`).set('Cookie', reviewer.cookie).send({ robotEveryHours: 4 })).status).toBe(403);
    await api().patch(`${V}/amazon_spapi/schedule`).set('Cookie', admin.cookie).send({ robotEveryHours: null }).expect(200);
    expect(await pollMinutesOf(amazonConnector)).toBe(120);
    expect(await rows("SELECT state_key FROM app_state WHERE state_key = 'channel-pull:amazon_spapi:poll'")).toHaveLength(1);
  });
});

describe('the robot schedule', () => {
  it('every 1-24 hours or off; the next run time follows the last run; bad values refused', async () => {
    const set = await api().patch(`${V}/${FK_KEY}/schedule`).set('Cookie', admin.cookie).send({ robotEveryHours: 4 }).expect(200);
    expect(set.body.data.robot.schedule).toMatchObject({ everyHours: 4 });
    expect(set.body.data.robot.nextRunAt).toBeTruthy(); // never ran: due now
    await api().post(`${V}/${FK_KEY}/robot`).set('Cookie', admin.cookie).expect(202);
    const run = await robotDone();
    const next = Date.parse((await pull(admin)).robot.nextRunAt as string);
    expect(next - Date.parse(run.startedAt)).toBe(4 * 3_600_000);
    for (const bad of [0, 25, 2.5, '4']) {
      const r = await api().patch(`${V}/${FK_KEY}/schedule`).set('Cookie', admin.cookie).send({ robotEveryHours: bad }).expect(400);
      expect(r.body.error.details[0].field).toBe('robotEveryHours');
    }
    const off = await api().patch(`${V}/${FK_KEY}/schedule`).set('Cookie', admin.cookie).send({ robotEveryHours: null }).expect(200);
    expect(off.body.data.robot).toMatchObject({ schedule: { everyHours: null }, nextRunAt: null });

    expect(await rows("SELECT state_key FROM app_state WHERE state_key = 'channel-pull:flipkart:schedule'")).toHaveLength(1);
  });
});
