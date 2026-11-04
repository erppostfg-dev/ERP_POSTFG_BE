import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSyncPass } from '../../src/modules/d2c-transfers/sync.service';
import { setUniwareClient } from '../../src/modules/d2c-transfers/uniware-transfers';
import { HttpError } from '../../src/modules/intransit/sources/http';
import type { UniwareApi } from '../../src/modules/intransit/sources/uniware';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * D2C internal transfers, phase 6 (2026-11-03): the Uniware SO status sync. Uniware is a fake (setUniwareClient); the
 * sender is TEST_FACILITY so the create-SO gate lets the test make an SO first. runSyncPass is called directly for the
 * data checks (the routes start it in the background).
 */
covers(['GET /d2c-transfers/sync-status', 'POST /d2c-transfers/sync']);

const P = '/api/v1/d2c-transfers';
let m: Masters;
let admin: TestLogin;
let senderId: number;
let locationId: number;

type Call = { path: string; body: Record<string, unknown>; facility?: string };
let calls: Call[] = [];
let answer: (c: Call) => unknown;
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
  const receivingId = await insert('master_facilities', { code: 'TEST_RECV', name: 'Receiver', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  // gate closed: sender AND receiving facility must both be test facilities
  await rows("UPDATE app_state SET value = JSON_SET(value, '$.testFacilities', JSON_ARRAY('TEST_FACILITY', 'TEST_RECV')) WHERE state_key = 'd2c:settings'");
  const [ch] = await rows<{ id: number }>("SELECT id FROM master_channels WHERE display_name = 'McaffeineB2C'");
  locationId = await insert('details_channels', {
    channel_id: ch.id, channel_name: 'McaffeineB2C', channel_location_code: 'TestLoc', transfer_facility_id: receivingId, transfer_po_prefix: 'TEST_PFX',
    channel_category: 'D2C', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  await insert('d2c_transfer_routes', {
    dispatch_facility_id: senderId, location_id: locationId, uniware_channel_code: 'mCaff_Test', customer_code: 'Test_Channel', customer_name: 'Test', vendor_code: 'Test_Vendor', is_active: 1,
  });
});
afterEach(() => setUniwareClient(null));
afterAll(closeDb);

const waitJob = async (jobId: string) => {
  for (let i = 0; i < 100; i++) {
    const j = (await api().get(`${P}/jobs/${jobId}`).set('Cookie', admin.cookie).expect(200)).body.data;
    if (j.status === 'done') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
};
/** A transfer with its SO created in (fake) Uniware: stage sale_order. */
const withSo = async (qty = 10) => {
  const t = (await api().post(P).set('Cookie', admin.cookie).send({ senderId, channel: 'McaffeineB2C', locationId: String(locationId), priority: 'P2', lines: [{ skuCode: m.pepCode, qty }] }).expect(201)).body.data;
  await waitJob((await api().post(`${P}/create-so`).set('Cookie', admin.cookie).send({ ids: [t.uid] }).expect(202)).body.data.id);
  const [line] = await rows<{ id: number }>('SELECT id FROM details_purchase_orders WHERE shipmentOrderId = ?', [t.uid]);
  return { uid: String(t.uid), item: `L${line.id}` };
};
const head = async (uid: string) => (await rows<Record<string, unknown>>('SELECT * FROM master_purchase_orders WHERE uid = ?', [uid]))[0];
const logCount = async (uid: string) => (await rows<{ n: number }>('SELECT COUNT(*) n FROM shipment_logs WHERE shipment_uid = ?', [uid]))[0].n;

describe('GET /sync-status', () => {
  it('viewer: the header data (never synced yet)', async () => {
    const viewer = await loginAs('viewer');
    const s = (await api().get(`${P}/sync-status`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(s).toMatchObject({ lastOkAt: null, lastError: null, running: false, syncMinutes: 30, minutesAgo: null });
  });
});

describe('POST /sync', () => {
  it('viewer 403; bad body 400; full without the resync permission 403', async () => {
    const viewer = await loginAs('viewer');
    await api().post(`${P}/sync`).set('Cookie', viewer.cookie).send({}).expect(403);
    await api().post(`${P}/sync`).set('Cookie', admin.cookie).send({ ids: 'x' }).expect(400);
    await api().post(`${P}/sync`).set('Cookie', admin.cookie).send({ full: 'yes' }).expect(400);
    const exec = await loginAs('operations-executive');
    const res = await api().post(`${P}/sync`).set('Cookie', exec.cookie).send({ full: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('D2C_RESYNC_FORBIDDEN');
  });

  it('editor: 202 started (runs in the background)', async () => {
    const res = await api().post(`${P}/sync`).set('Cookie', admin.cookie).send({}).expect(202);
    expect(['started', 'queued']).toContain(res.body.data.state);
  });
});

describe('runSyncPass', () => {
  const dispatchedSo = (item: string, sku: string) => () => ({
    successful: true,
    saleOrderDTO: {
      code: 'erp_it_x', displayOrderCode: 'ref', status: 'COMPLETE',
      saleOrderItems: [{ code: item, itemSku: sku, statusCode: 'DISPATCHED', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: 10, allocatedQuantity: 0, inProcessQuantity: 0, sellingPrice: 5 }],
      shippingPackages: [{ code: 'SP1', status: 'DISPATCHED', dispatched: Date.parse('2026-11-03T06:00:00Z'), invoiceCode: 'INV1', invoiceDisplayCode: 'INV1', invoiceDate: Date.parse('2026-11-03T05:00:00Z'), collectableAmount: 50, items: { [sku]: { itemSku: sku, quantity: 10 } } }],
    },
  });

  it('reads the SO, writes the invoice, lines, header and logs once; a second run writes no log', async () => {
    const { uid, item } = await withSo();
    answer = dispatchedSo(item, m.pepCode);
    const r1 = await runSyncPass({ ids: [uid], manual: true });
    expect(r1.counts).toMatchObject({ read: 1, changed: 1, errors: 0 });
    expect(await head(uid)).toMatchObject({ transferStage: 'dispatched', invoiceChallanNumber: 'INV1', statusWarehouse: 'Dispatched' });
    const [inv] = await rows<Record<string, unknown>>('SELECT * FROM po_invoices WHERE po_uid = ?', [uid]);
    expect(inv).toMatchObject({ shipping_package_code: 'SP1', invoice_code: 'INV1', package_status: 'DISPATCHED', units: 10 });
    const [l] = await rows<{ dispatchedQty: number }>('SELECT dispatchedQty FROM details_purchase_orders WHERE shipmentOrderId = ?', [uid]);
    expect(l.dispatchedQty).toBe(10);
    const logs = await logCount(uid);
    // the transfer is dispatched now: only a full resync reads it again
    const r2 = await runSyncPass({ ids: [uid], manual: true, full: true });
    expect(r2.counts).toMatchObject({ read: 1, changed: 0, unchanged: 1 });
    expect(await logCount(uid)).toBe(logs);
    const [state] = await rows<{ value: unknown }>("SELECT value FROM app_state WHERE state_key = 'd2c:sync'");
    expect(state.value).toMatchObject({ lastError: null, nextDelayMin: 30 });
  });

  it('a final 429 stops the run, keeps progress and doubles the wait', async () => {
    const { uid } = await withSo();
    answer = (c) => {
      if (c.path.includes('saleorder/get')) throw new HttpError(429, '429 from saleorder/get: too many requests');
      return { successful: true };
    };
    const r = await runSyncPass({ ids: [uid], manual: true });
    expect(r.failed).toBe(true);
    expect(r.nextDelayMin).toBe(60);
    expect(r.error).toContain('429');
    expect((await head(uid)).syncError).toBeNull();
    const again = await runSyncPass({ ids: [uid], manual: true });
    expect(again.nextDelayMin).toBe(120);
  });

  it('closed / cancelled / draft transfers are not read without full', async () => {
    const { uid } = await withSo();
    await rows("UPDATE master_purchase_orders SET transferStage = 'cancelled' WHERE uid = ?", [uid]);
    calls = [];
    const r = await runSyncPass({ ids: [uid], manual: true });
    expect(r.counts.read).toBe(0);
    expect(calls.filter((c) => c.path.includes('saleorder/get'))).toHaveLength(0);
  });
});
