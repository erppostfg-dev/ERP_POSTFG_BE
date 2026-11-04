import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setUniwareClient } from '../../src/modules/d2c-transfers/uniware-transfers';
import type { UniwareApi } from '../../src/modules/intransit/sources/uniware';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * D2C internal transfers, phase 5 (2026-11-03): stock check, create SO (202 job), cancel with an SO, close short. Uniware
 * is a fake (setUniwareClient); the network guard of test/setup/env.ts would stop a real call anyway. The sender is
 * TEST_FACILITY: the gate (d2c:settings.live false, D2C_UNIWARE_WRITES unset) lets only the test facilities write.
 */
covers(['POST /d2c-transfers/stock-check', 'POST /d2c-transfers/create-so', 'GET /d2c-transfers/jobs/:jobId', 'POST /d2c-transfers/:id/close-short']);

const P = '/api/v1/d2c-transfers';
let m: Masters;
let admin: TestLogin;
let senderId: number;
let otherSenderId: number;
let locationId: number;

type Call = { path: string; body: Record<string, unknown>; facility?: string };
let calls: Call[] = [];
let answer: (c: Call) => unknown;
const refuse = (message: string, code = 40001) => {
  throw new Error(`x refused: ${JSON.stringify([{ code, message, description: message }])}`);
};

const fake = {
  post: (path: string, body: Record<string, unknown>, facility?: string) => {
    const c = { path, body, facility };
    calls.push(c);
    try {
      return Promise.resolve(answer(c));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
} as unknown as UniwareApi;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  calls = [];
  answer = () => ({ successful: true });
  setUniwareClient(fake);
  senderId = await insert('master_facilities', { code: 'TEST_FACILITY', name: 'Test', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  otherSenderId = await insert('master_facilities', { code: 'REAL_SEND', name: 'Real', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  const receivingId = await insert('master_facilities', { code: 'TEST_RECV', name: 'Receiver', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  // gate closed: sender AND receiving facility must both be test facilities
  await rows("UPDATE app_state SET value = JSON_SET(value, '$.testFacilities', JSON_ARRAY('TEST_FACILITY', 'TEST_RECV')) WHERE state_key = 'd2c:settings'");
  const [ch] = await rows<{ id: number }>("SELECT id FROM master_channels WHERE display_name = 'McaffeineB2C'");
  locationId = await insert('details_channels', {
    channel_id: ch.id, channel_name: 'McaffeineB2C', channel_location_code: 'TestLoc', transfer_facility_id: receivingId, transfer_po_prefix: 'TEST_PFX',
    channel_category: 'D2C', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  for (const sender of [senderId, otherSenderId]) {
    await insert('d2c_transfer_routes', {
      dispatch_facility_id: sender, location_id: locationId, uniware_channel_code: 'mCaff_Test', customer_code: 'Test_Channel', customer_name: 'Test', vendor_code: 'Test_Vendor', is_active: 1,
    });
  }
});
afterEach(() => setUniwareClient(null));
afterAll(closeDb);

const newDraft = async (sender = senderId, qty = 10) =>
  (await api().post(P).set('Cookie', admin.cookie).send({ senderId: sender, channel: 'McaffeineB2C', locationId: String(locationId), priority: 'P2', lines: [{ skuCode: m.pepCode, qty }] }).expect(201)).body.data;

const waitJob = async (jobId: string) => {
  for (let i = 0; i < 100; i++) {
    const j = (await api().get(`${P}/jobs/${jobId}`).set('Cookie', admin.cookie).expect(200)).body.data;
    if (j.status === 'done') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
};
const head = async (uid: string) => (await rows<Record<string, unknown>>('SELECT * FROM master_purchase_orders WHERE uid = ?', [uid]))[0];

describe('stock check (read only)', () => {
  it('needed vs available = inventory - openSale - inventoryBlocked, short flag', async () => {
    const t = await newDraft(senderId, 30);
    answer = () => ({ successful: true, inventorySnapshots: [{ itemTypeSKU: m.pepCode, inventory: 50, openSale: 10, inventoryBlocked: 15 }] });
    const d = (await api().post(`${P}/stock-check`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(200)).body.data;
    expect(d.transfers[0].lines[0]).toMatchObject({ skuCode: m.pepCode, needed: 30, available: 25, short: true });
    expect(calls[0]).toMatchObject({ path: '/services/rest/v1/inventory/inventorySnapshot/get', facility: 'TEST_FACILITY' });
  });
});

describe('create SO', () => {
  it('created: payload, SO code erp_it_<date>001, stage sale_order, logs', async () => {
    const t = await newDraft();
    const res = await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202);
    const job = await waitJob(res.body.data.id);
    expect(job.results[0]).toMatchObject({ uid: t.uid, outcome: 'created' });
    const h = await head(t.uid);
    expect(h).toMatchObject({ soState: 'created', transferStage: 'sale_order', statusWarehouse: 'Confirmed', soError: null });
    expect(h.orderNo1).toMatch(/^erp_it_\d{8}001$/);
    const sent = calls.find((c) => c.path.endsWith('/saleOrder/create'))!;
    expect(sent.facility).toBe('TEST_FACILITY');
    expect(sent.body).toMatchObject({ saleOrder: { channel: 'mCaff_Test', customerCode: 'Test_Channel', displayOrderCode: t.reference, saleOrderItems: [{ itemSku: m.pepCode, quantity: 10, sellingPrice: 74.85, totalPrice: 748.5 }] } });
    const logs = await rows<{ action: string; source: string }>('SELECT action, source FROM shipment_logs WHERE shipment_uid = ? ORDER BY id', [t.uid]);
    expect(logs.map((l) => l.action)).toEqual(['created', 'so_requested', 'so_created', 'stage_changed']);
  });

  it('refused: failed + reason, still an editable draft; a retry keeps the SO code', async () => {
    const t = await newDraft();
    answer = () => refuse('INVALID_CUSTOMER');
    await waitJob((await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202)).body.data.id);
    const h = await head(t.uid);
    expect(h).toMatchObject({ soState: 'failed', transferStage: 'draft' });
    expect(String(h.soError)).toContain('INVALID_CUSTOMER');
    answer = () => ({ successful: true });
    await waitJob((await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202)).body.data.id);
    expect(await head(t.uid)).toMatchObject({ soState: 'created', orderNo1: h.orderNo1 });
  });

  it('duplicate code -> looked up: found with our reference = created', async () => {
    const t = await newDraft();
    answer = (c) => (c.path.endsWith('/create') ? refuse('DUPLICATE_SALE_ORDER') : { successful: true, saleOrderDTO: { code: 'x', displayOrderCode: t.reference, status: 'CREATED', saleOrderItems: [] } });
    await waitJob((await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202)).body.data.id);
    expect(await head(t.uid)).toMatchObject({ soState: 'created' });
  });

  it('no answer and the lookup fails too -> unknown (never failed); edit and cancel are blocked', async () => {
    const t = await newDraft();
    answer = () => { throw new Error('fetch failed'); };
    await waitJob((await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202)).body.data.id);
    expect(await head(t.uid)).toMatchObject({ soState: 'unknown', transferStage: 'draft' });
    expect((await api().post(`${P}/${t.uid}/cancel`).set('Cookie', admin.cookie).send({ reason: 'x' })).body.error.code).toBe('D2C_IN_FLIGHT');
  });

  it('gate: a sender that is not a test facility -> 409 D2C_NOT_LIVE, no call', async () => {
    const t = await newDraft(otherSenderId);
    const res = await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('D2C_NOT_LIVE');
    expect(calls).toHaveLength(0);
  });

  it('editor only', async () => {
    const viewer = await loginAs('viewer');
    expect((await api().post(`${P}/create-so`).set('Cookie', viewer.cookie).send({ ids: ['1'] })).status).toBe(403);
  });
});

describe('cancel and close short with an SO', () => {
  const created = async () => {
    const t = await newDraft();
    await waitJob((await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202)).body.data.id);
    const [line] = await rows<{ id: number }>('SELECT id FROM details_purchase_orders WHERE shipmentOrderId = ?', [t.uid]);
    return { t, item: `L${line.id}` };
  };

  it('cancel: open items cancelled in Uniware, then cancelled; a refusal changes nothing', async () => {
    const { t, item } = await created();
    answer = (c) => (c.path.endsWith('/cancel') ? refuse('CANNOT_CANCEL') : { successful: true, saleOrderDTO: { code: 'x', status: 'CREATED', saleOrderItems: [{ code: item, itemSku: m.pepCode, statusCode: 'CREATED' }] } });
    const no = await api().post(`${P}/${t.uid}/cancel`).set('Cookie', admin.cookie).send({ reason: 'not needed' });
    expect(no.status).toBe(422);
    expect(await head(t.uid)).toMatchObject({ transferStage: 'sale_order' });
    answer = (c) => (c.path.endsWith('/cancel') ? { successful: true } : { successful: true, saleOrderDTO: { code: 'x', status: 'CREATED', saleOrderItems: [{ code: item, itemSku: m.pepCode, statusCode: 'CREATED' }] } });
    await api().post(`${P}/${t.uid}/cancel`).set('Cookie', admin.cookie).send({ reason: 'not needed' }).expect(200);
    expect(await head(t.uid)).toMatchObject({ transferStage: 'cancelled', statusPlanning: 'Cancelled' });
    expect(calls.filter((c) => c.path.endsWith('/cancel')).at(-1)?.body).toEqual({ saleOrderCode: expect.stringMatching(/^erp_it_/), saleOrderItemCodes: [item], cancellationReason: 'not needed' });
  });

  it('close short: open item cancelled, lines cut to what Uniware did not cancel, close_short', async () => {
    const { t, item } = await created();
    await insert('po_invoices', { po_uid: t.uid, shipping_package_code: 'P1', dispatched_at: new Date(), units: 4, package_status: 'DISPATCHED' });
    await rows('UPDATE details_purchase_orders SET dispatchedQty = 4 WHERE shipmentOrderId = ?', [t.uid]);
    let cancelledYet = false;
    answer = (c) => {
      if (c.path.endsWith('/cancel')) {
        cancelledYet = true;
        return { successful: true };
      }
      return { successful: true, saleOrderDTO: { code: 'x', status: 'PROCESSING', saleOrderItems: [{ code: item, itemSku: m.pepCode, statusCode: cancelledYet ? 'CANCELLED' : 'FULFILLABLE', totalQuantity: 10, cancelledQuantity: cancelledYet ? 6 : 0 }] } };
    };
    const d = (await api().post(`${P}/${t.uid}/close-short`).set('Cookie', admin.cookie).send({ reason: 'short stock' }).expect(200)).body.data;
    expect(d.closeShort.cancelled).toEqual([{ itemCode: item, sku: m.pepCode }]);
    expect(await head(t.uid)).toMatchObject({ balanceClosedReason: 'close_short' });
    const [l] = await rows<{ updatedQty: number }>('SELECT updatedQty FROM details_purchase_orders WHERE shipmentOrderId = ?', [t.uid]);
    expect(l.updatedQty).toBe(4);
  });
});
