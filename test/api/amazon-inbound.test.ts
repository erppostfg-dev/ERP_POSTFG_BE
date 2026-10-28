import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Amazon Inbound page (2026-10-28): reads only our own tables (inbound_plans / shipments / lines / events, filled by
 * the tracking sync). "Refresh" asks Amazon for one shipment: replaced by a recorder (nothing calls Amazon).
 * Stuck limits come seeded by the migrations.
 */
covers([
  'GET /amazon/inbound/plans', 'GET /amazon/inbound/plans/:planId', 'GET /amazon/inbound/shipments', 'GET /amazon/inbound/shipments/:externalId',
  'POST /amazon/inbound/shipments/:externalId/refresh', 'GET /amazon/inbound/limits', 'PATCH /amazon/inbound/limits/:id', 'GET /amazon/inbound/sync',
]);

const refreshed = vi.hoisted(() => [] as string[]);
vi.mock('../../src/modules/channel-api/amazon/inbound-sync.service', async (orig) => ({
  ...(await orig<object>()),
  refreshShipment: vi.fn(async (id: string) => { refreshed.push(id); return { changes: ['status WORKING -> SHIPPED'], calls: 2 }; }),
}));

const V = '/api/v1/amazon/inbound';
const SRC = 'amazon_spapi';
let reviewer: TestLogin;
/** Operations Manager edits all of Operations (Amazon Inbound included); Operations Executive only views it. */
let manager: TestLogin;

const seedInbound = async () => {
  const now = new Date('2026-10-26T06:00:00Z');
  const plan = await insert('inbound_plans', {
    source_system: SRC, plan_id: 'wfTESTPLAN1', name: 'Test plan', status: 'ACTIVE', plan_sku_count: 1, plan_units: 48, shipment_count: 2, first_seen_at: now, last_checked_at: now,
  });
  const ship = (externalId: string, status: string, received: number) => insert('inbound_shipments', {
    source_system: SRC, external_id: externalId, plan_row_id: plan, name: `FBA STA (26/10/2026)-${externalId.slice(-4)}`, fc_code: 'IDX2', status,
    status_since: now, sku_count: 1, units_planned: 24, units_received: received, first_seen_at: now, last_seen_at: now,
  });
  const a = await ship('FBA15PLAN0001', 'WORKING', 0);
  const b = await ship('FBA15PLAN0002', 'RECEIVING', 10);
  await insert('inbound_shipment_lines', { shipment_id: b, seller_sku: 'MCAFF_TEST_001', fnsku: 'X00TEST001', qty_planned: 24, qty_received: 10, updated_at: now });
  await insert('inbound_shipment_events', { shipment_id: b, kind: 'status', old_value: 'SHIPPED', new_value: 'RECEIVING', source: 'sync', seen_at: now });
  return { plan, a, b };
};

beforeEach(async () => {
  await resetDb();
  reviewer = await loginAs('operations-executive');
  manager = await loginAs('operations-manager');
  refreshed.length = 0;
});
afterAll(closeDb);

describe('Amazon Inbound', () => {
  it('401 / 403; a page viewer reads but cannot refresh or change limits', async () => {
    expect((await api().get(`${V}/plans`)).status).toBe(401);
    const nobody = await loginAs(null);
    expect((await api().get(`${V}/plans`).set('Cookie', nobody.cookie)).status).toBe(403);
    await seedInbound();
    // Operations Executive: view only on Amazon Inbound
    expect((await api().get(`${V}/plans`).set('Cookie', reviewer.cookie)).status).toBe(200);
    expect((await api().post(`${V}/shipments/FBA15PLAN0001/refresh`).set('Cookie', reviewer.cookie)).status).toBe(403);
    expect((await api().patch(`${V}/limits/1`).set('Cookie', reviewer.cookie).send({ maxDays: 5 })).status).toBe(403);
    expect(refreshed).toEqual([]);
  });

  it('plans with their shipments; one plan; unknown plan -> 404', async () => {
    await seedInbound();
    const list = await api().get(`${V}/plans`).set('Cookie', reviewer.cookie).expect(200);
    expect(JSON.stringify(list.body.data)).toContain('wfTESTPLAN1');
    const one = await api().get(`${V}/plans/wfTESTPLAN1`).set('Cookie', reviewer.cookie).expect(200);
    expect(one.body.data.shipments.map((s: { externalId: string }) => s.externalId).sort()).toEqual(['FBA15PLAN0001', 'FBA15PLAN0002']);
    expect((await api().get(`${V}/plans/nope`).set('Cookie', reviewer.cookie)).status).toBe(404);
  });

  it('shipments; one shipment with its lines and events', async () => {
    await seedInbound();
    const list = await api().get(`${V}/shipments`).set('Cookie', reviewer.cookie).expect(200);
    expect(list.body.meta.total).toBe(2);
    const one = await api().get(`${V}/shipments/FBA15PLAN0002`).set('Cookie', reviewer.cookie).expect(200);
    expect(one.body.data.lines[0]).toMatchObject({ sellerSku: 'MCAFF_TEST_001', fnsku: 'X00TEST001', qtyPlanned: 24, qtyReceived: 10 });
    expect(JSON.stringify(one.body.data.events)).toContain('RECEIVING');
    expect((await api().get(`${V}/shipments/FBA15NOPE`).set('Cookie', reviewer.cookie)).status).toBe(404);
  });

  it('Refresh asks Amazon for that one shipment (recorder) and returns what changed', async () => {
    await seedInbound();
    const res = await api().post(`${V}/shipments/FBA15PLAN0001/refresh`).set('Cookie', manager.cookie).expect(200);
    expect(refreshed).toEqual(['FBA15PLAN0001']);
    expect(res.body.data).toMatchObject({ changes: ['status WORKING -> SHIPPED'], calls: 2 });
  });

  it('stuck limits: listed; editor changes maxDays (1-365)', async () => {
    const limits = await api().get(`${V}/limits`).set('Cookie', reviewer.cookie).expect(200);
    expect(limits.body.data.length).toBeGreaterThan(0);
    const id = limits.body.data[0].id;
    await api().patch(`${V}/limits/${id}`).set('Cookie', manager.cookie).send({ maxDays: 0 }).expect(400);
    await api().patch(`${V}/limits/${id}`).set('Cookie', manager.cookie).send({ maxDays: 9 }).expect(200);
    expect((await rows<{ max_days: number; updated_by: number }>('SELECT max_days, updated_by FROM inbound_status_limits WHERE id = ?', [id]))[0])
      .toEqual({ max_days: 9, updated_by: manager.userId });
  });

  it('sync health answers', async () => {
    const res = await api().get(`${V}/sync`).set('Cookie', reviewer.cookie).expect(200);
    expect(res.body).toHaveProperty('data');
  });
});
