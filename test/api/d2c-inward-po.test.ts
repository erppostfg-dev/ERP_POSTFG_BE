import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setUniwareClient } from '../../src/modules/d2c-transfers/uniware-transfers';
import type { UniwareApi } from '../../src/modules/intransit/sources/uniware';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * D2C internal transfers, phase 7 (2026-11-03): inward PO per dispatched invoice (202 job), the invoice list of the
 * Create inward PO / Inward POs tabs, the GRN read of the sync and the variance reason. Uniware is a fake
 * (setUniwareClient). Sender TEST_FACILITY (the gate lets only the test facilities write), receiver TEST_RECV.
 * The transfer is put straight into "dispatched" with SQL (the SO / package part is phase 5 / 6's tests).
 */
covers(['GET /d2c-transfers/invoices', 'POST /d2c-transfers/create-inward-po', 'POST /d2c-transfers/invoices/:invoiceId/variance-reason']);

const P = '/api/v1/d2c-transfers';
let m: Masters;
let admin: TestLogin;
let senderId: number;
let routeId: number;
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
  const receivingId = await insert('master_facilities', { code: 'TEST_RECV', name: 'Receiver', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  // gate closed: sender AND receiving facility must both be test facilities
  await rows("UPDATE app_state SET value = JSON_SET(value, '$.testFacilities', JSON_ARRAY('TEST_FACILITY', 'TEST_RECV')) WHERE state_key = 'd2c:settings'");
  const [ch] = await rows<{ id: number }>("SELECT id FROM master_channels WHERE display_name = 'McaffeineB2C'");
  locationId = await insert('details_channels', {
    channel_id: ch.id, channel_name: 'McaffeineB2C', channel_location_code: 'TestLoc', transfer_facility_id: receivingId, transfer_po_prefix: 'TEST_PFX',
    channel_category: 'D2C', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  routeId = await insert('d2c_transfer_routes', {
    dispatch_facility_id: senderId, location_id: locationId, uniware_channel_code: 'mCaff_Test', customer_code: 'Test_Channel', customer_name: 'Test', vendor_code: 'Test_Vendor', is_active: 1,
  });
});
afterEach(() => setUniwareClient(null));
afterAll(closeDb);

/** A transfer of 10 units, SO created, one invoice of 10 dispatched (balance 0, stage dispatched). */
const dispatched = async () => {
  const t = (await api().post(P).set('Cookie', admin.cookie).send({ senderId, channel: 'McaffeineB2C', locationId: String(locationId), priority: 'P2', lines: [{ skuCode: m.pepCode, qty: 10 }] }).expect(201)).body.data;
  await rows("UPDATE master_purchase_orders SET soState = 'created', orderNo1 = 'erp_it_20261103001', transferStage = 'dispatched' WHERE uid = ?", [t.uid]);
  await rows('UPDATE details_purchase_orders SET dispatchedQty = 10 WHERE shipmentOrderId = ?', [t.uid]);
  const invoiceId = await insert('po_invoices', {
    po_uid: t.uid, sale_order_code: 'erp_it_20261103001', shipping_package_code: 'SP/1', invoice_code: 'SI/1', invoice_display_code: 'SI/1', package_status: 'DISPATCHED',
    dispatched_at: new Date(), units: 10, sku_qty: JSON.stringify({ [m.pepCode]: { dispatched: 10, inward: 0, received: 0 } }),
  });
  return { uid: String(t.uid), invoiceId: String(invoiceId) };
};

const waitJob = async (jobId: string) => {
  for (let i = 0; i < 100; i++) {
    const j = (await api().get(`${P}/jobs/${jobId}`).set('Cookie', admin.cookie).expect(200)).body.data;
    if (j.status === 'done') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
};
const invoice = async (id: string) => (await rows<Record<string, unknown>>('SELECT * FROM po_invoices WHERE id = ?', [id]))[0];
const head = async (uid: string) => (await rows<Record<string, unknown>>('SELECT * FROM master_purchase_orders WHERE uid = ?', [uid]))[0];

describe('invoice list', () => {
  it('create_inward_po lists the dispatched invoice with its vendor; tab is required', async () => {
    const { invoiceId } = await dispatched();
    const res = await api().get(`${P}/invoices?tab=create_inward_po`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: invoiceId, invoiceNo: 'SI/1', units: 10, receiving: 'TEST_RECV', vendorCode: 'Test_Vendor', vendorMissing: false, canCreate: true });
    await api().get(`${P}/invoices?tab=overview`).set('Cookie', admin.cookie).expect(400);
  });
  it('vendor missing on the route blocks the row', async () => {
    await dispatched();
    await rows('UPDATE d2c_transfer_routes SET vendor_code = NULL WHERE id = ?', [routeId]);
    const row = (await api().get(`${P}/invoices?tab=create_inward_po`).set('Cookie', admin.cookie).expect(200)).body.data[0];
    expect(row).toMatchObject({ vendorMissing: true, canCreate: false });
    expect(row.createBlockedBecause).toContain('vendor code missing on route');
  });
});

describe('create inward PO', () => {
  it('created: code <SO>-1 at the receiving facility, unit price 1, header + stage inward_po_created', async () => {
    const { uid, invoiceId } = await dispatched();
    const res = await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202);
    const job = await waitJob(res.body.data.id);
    expect(job.results[0]).toMatchObject({ invoiceId, outcome: 'created', inwardPoCode: 'erp_it_20261103001-1' });
    const sent = calls.find((c) => c.path.endsWith('/purchaseOrder/create'))!;
    expect(sent.facility).toBe('TEST_RECV');
    expect(sent.body).toMatchObject({
      purchaseOrderCode: 'erp_it_20261103001-1', vendorCode: 'Test_Vendor', purchaseOrderItems: [{ itemSKU: m.pepCode, quantity: 10, unitPrice: 1 }],
      customFieldValues: [{ name: 'ReferenceNo', value: 'erp_it_20261103001' }, { name: 'ReferenceOrder', value: expect.any(String) }],
    });
    expect(await invoice(invoiceId)).toMatchObject({ inward_po_state: 'created', inward_po_code: 'erp_it_20261103001-1' });
    expect(await head(uid)).toMatchObject({ poNumberInwardCWH: 'erp_it_20261103001-1', transferStage: 'inward_po_created' });
    const logs = await rows<{ action: string }>('SELECT action FROM shipment_logs WHERE shipment_uid = ? ORDER BY id', [uid]);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['inward_po_requested', 'inward_po_created', 'stage_changed']));
  });

  it('refused: failed + reason; a retry keeps the same code', async () => {
    const { invoiceId } = await dispatched();
    answer = () => refuse('INVALID_VENDOR');
    await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    expect(await invoice(invoiceId)).toMatchObject({ inward_po_state: 'failed', inward_po_code: 'erp_it_20261103001-1' });
    answer = () => ({ successful: true });
    await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    expect(await invoice(invoiceId)).toMatchObject({ inward_po_state: 'created', inward_po_code: 'erp_it_20261103001-1' });
  });

  it('duplicate code -> details get with our SO code = created', async () => {
    const { invoiceId } = await dispatched();
    answer = (c) => (c.path.endsWith('/create')
      ? refuse('DUPLICATE_CODE', 30002)
      : { successful: true, code: 'erp_it_20261103001-1', statusCode: 'CREATED', customFieldValues: [{ fieldName: 'ReferenceNo', fieldValue: 'erp_it_20261103001' }], purchaseOrderItems: [] });
    const job = await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    expect(job.results[0].outcome).toBe('created');
    expect(await invoice(invoiceId)).toMatchObject({ inward_po_state: 'created', inward_po_status: 'CREATED' });
  });

  it('already created: skipped with the reason; no second call', async () => {
    const { invoiceId } = await dispatched();
    await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    calls = [];
    const job = await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    expect(job.results[0]).toMatchObject({ outcome: 'skipped', error: expect.stringContaining('already has inward PO') });
    expect(calls).toHaveLength(0);
  });

  it('validation: invoiceIds required', async () => {
    await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({}).expect(400);
  });
});

describe('variance reason', () => {
  it('only after GRN complete with a variance; closes the transfer', async () => {
    const { uid, invoiceId } = await dispatched();
    await rows("UPDATE po_invoices SET inward_po_state = 'created', inward_po_code = 'erp_it_20261103001-1' WHERE id = ?", [invoiceId]);
    await api().post(`${P}/invoices/${invoiceId}/variance-reason`).set('Cookie', admin.cookie).send({ reason: 'damaged' }).expect(409);
    await rows("UPDATE po_invoices SET received_units = 8, grn_completed_at = NOW() WHERE id = ?", [invoiceId]);
    await rows("UPDATE master_purchase_orders SET transferStage = 'grn' WHERE uid = ?", [uid]);
    await api().post(`${P}/invoices/${invoiceId}/variance-reason`).set('Cookie', admin.cookie).send({ reason: 'lost' }).expect(400);
    await api().post(`${P}/invoices/${invoiceId}/variance-reason`).set('Cookie', admin.cookie).send({ reason: 'other' }).expect(400);
    const res = await api().post(`${P}/invoices/${invoiceId}/variance-reason`).set('Cookie', admin.cookie).send({ reason: 'short_received', note: '2 missing' }).expect(200);
    expect(res.body.data.stage).toBe('closed');
    expect(await invoice(invoiceId)).toMatchObject({ variance_reason: 'short_received', variance_note: '2 missing' });
    // editable after saving (user, 2026-11-03): old -> new logged
    await api().post(`${P}/invoices/${invoiceId}/variance-reason`).set('Cookie', admin.cookie).send({ reason: 'damaged', note: '2 torn' }).expect(200);
    const logs = await rows<{ old_value: string | null; new_value: string; remark: string }>("SELECT old_value, new_value, remark FROM shipment_logs WHERE shipment_uid = ? AND action = 'variance_reason' ORDER BY id", [uid]);
    expect(logs.map((l) => [l.old_value, l.new_value])).toEqual([[null, 'short_received'], ['short_received', 'damaged']]);
    expect(logs[1].remark).toContain('note: 2 missing -> 2 torn');
    await api().post(`${P}/invoices/999999/variance-reason`).set('Cookie', admin.cookie).send({ reason: 'damaged' }).expect(404);
  });
});

describe('GRN sync', () => {
  it('PO complete + one GRN at the STORED receiving facility: received, grn_completed_at, line received, stage closed', async () => {
    const { uid, invoiceId } = await dispatched();
    await rows("UPDATE po_invoices SET inward_po_state = 'created', inward_po_code = 'erp_it_20261103001-1' WHERE id = ?", [invoiceId]);
    // the facility recorded at request time wins over today's Masters value
    await insert('shipment_logs', { shipment_uid: uid, action: 'inward_po_requested', source: 'tool_api', field_name: 'inwardPoCode', new_value: 'erp_it_20261103001-1', remark: 'receiving=TEST_RECV | SI/1 | {}' });
    await rows("UPDATE master_facilities SET code = 'MOVED_RECV' WHERE code = 'TEST_RECV'");
    await rows("UPDATE master_purchase_orders SET transferStage = 'inward_po_created' WHERE uid = ?", [uid]);
    answer = (c) => {
      if (c.path.endsWith('/getPurchaseOrderDetails')) return { successful: true, code: 'erp_it_20261103001-1', statusCode: 'COMPLETE', customFieldValues: [], purchaseOrderItems: [] };
      if (c.path.endsWith('/getInflowReceipts')) return { successful: true, inflowReceiptCodes: ['G1'] };
      if (c.path.endsWith('/getInflowReceipt')) return { successful: true, inflowReceipt: { code: 'G1', statusCode: 'COMPLETE', qcCompletedOn: Date.now(), inflowReceiptItems: [{ itemSKU: m.pepCode, quantity: 10, rejectedQuantity: 0 }] } };
      return { successful: true };
    };
    await api().post(`${P}/sync`).set('Cookie', admin.cookie).send({ ids: [uid] }).expect(202);
    for (let i = 0; i < 100 && !(await invoice(invoiceId)).grn_completed_at; i++) await new Promise((r) => setTimeout(r, 30));
    expect(await invoice(invoiceId)).toMatchObject({ received_units: 10, inward_po_status: 'COMPLETE' });
    expect(calls.filter((c) => c.path.endsWith('/getInflowReceipt'))[0].facility).toBe('TEST_RECV');
    expect(await head(uid)).toMatchObject({ transferStage: 'closed' });
    const [line] = await rows<{ channelInwardingQuantity: number }>('SELECT channelInwardingQuantity FROM details_purchase_orders WHERE shipmentOrderId = ?', [uid]);
    expect(line.channelInwardingQuantity).toBe(10);
  });

  it('PO cancelled in Uniware: back in Create inward PO, next create takes <SO>-2', async () => {
    const { uid, invoiceId } = await dispatched();
    await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    answer = (c) => {
      if (c.path.endsWith('/getPurchaseOrderDetails')) return { successful: true, code: 'erp_it_20261103001-1', statusCode: 'CANCELLED', customFieldValues: [], purchaseOrderItems: [] };
      if (c.path.endsWith('/getInflowReceipts')) return { successful: true, inflowReceiptCodes: [] };
      return { successful: true };
    };
    await api().post(`${P}/sync`).set('Cookie', admin.cookie).send({ ids: [uid] }).expect(202);
    for (let i = 0; i < 100 && (await invoice(invoiceId)).inward_po_state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 30));
    expect(await invoice(invoiceId)).toMatchObject({ inward_po_state: 'failed', inward_po_code: null, inward_po_status: 'CANCELLED' });
    expect((await api().get(`${P}/invoices?tab=create_inward_po`).set('Cookie', admin.cookie).expect(200)).body.data[0]).toMatchObject({ id: invoiceId, canCreate: true });
    answer = () => ({ successful: true });
    await waitJob((await api().post(`${P}/create-inward-po`).set('Cookie', admin.cookie).send({ invoiceIds: [invoiceId] }).expect(202)).body.data.id);
    expect(await invoice(invoiceId)).toMatchObject({ inward_po_state: 'created', inward_po_code: 'erp_it_20261103001-2' });
  });
});
