import type { AddressInfo } from 'net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../../src/app';
import { refDateToken, todayIst } from '../../src/modules/d2c-transfers/reference';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { clearS3, s3Objects } from '../helpers/fake-s3';
import { seedMasters, seedTransferChannel, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * D2C internal transfers, phase 3 (2026-11-03; no Uniware calls): upload (template / preview / import), the form,
 * the reads (list per tab, counts, detail, timeline, export, options, SKU picker, next reference), draft edit with the
 * edit token, cancel, expiry change and the live feed (transfer changes only). Transfers are master_purchase_orders
 * rows with transferCode set; they must never show on PO Overview.
 */
covers([
  'GET /d2c-transfers', 'GET /d2c-transfers/counts', 'GET /d2c-transfers/export', 'GET /d2c-transfers/options', 'GET /d2c-transfers/skus',
  'GET /d2c-transfers/next-reference', 'GET /d2c-transfers/template', 'GET /d2c-transfers/events', 'GET /d2c-transfers/changes',
  'POST /d2c-transfers/uploads/preview', 'POST /d2c-transfers/uploads/import', 'POST /d2c-transfers', 'GET /d2c-transfers/:id',
  'GET /d2c-transfers/:id/events', 'PATCH /d2c-transfers/:id', 'POST /d2c-transfers/:id/cancel', 'POST /d2c-transfers/:id/expiry',
]);

const V = '/api/v1';
const P = `${V}/d2c-transfers`;
const HEAD = 'Channel,Location,PO Date,PO Number,Sr No,SKU Name,SKU Code,Channel SKU Code,Qty,GMV,PO Value,Dispatch Location,Priority,Group,Type,PO Expiry Date';
let m: Masters;
let admin: TestLogin;
let senderId: number;
let receivingId: number;
let locationId: number;
let today: string;

const csv = (...lines: string[]) => Buffer.from(`${HEAD}\r\n${lines.join('\r\n')}\r\n`);
const line = (o: { sku?: string; qty?: number; group?: string; type?: string; priority?: string; sender?: string; location?: string } = {}) =>
  `McaffeineB2C,${o.location ?? 'TestLoc'},${today},,,,${o.sku ?? 'MCAFF_TEST_001'},,${o.qty ?? 10},,,${o.sender ?? 'TEST_SEND'},${o.priority ?? 'P1'},${o.group ?? ''},${o.type ?? ''},`;
const upload = (path: string, body: Buffer, who = admin, name = 'transfers.csv') => api().post(`${P}${path}`).set('Cookie', who.cookie).attach('file', body, name);

beforeEach(async () => {
  await resetDb();
  clearS3();
  m = await seedMasters();
  admin = await loginAs('admin');
  today = todayIst();
  senderId = await insert('master_facilities', { code: 'TEST_SEND', name: 'Sender', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  receivingId = await insert('master_facilities', { code: 'TEST_RECV', name: 'Receiver', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 1 });
  const ch = { id: await seedTransferChannel() };
  locationId = await insert('details_channels', {
    channel_id: ch.id, channel_name: 'McaffeineB2C', channel_location_code: 'TestLoc', transfer_facility_id: receivingId, transfer_po_prefix: 'TEST_PFX',
    channel_category: 'D2C', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  await insert('d2c_transfer_routes', {
    dispatch_facility_id: senderId, location_id: locationId, uniware_channel_code: 'D2C_TRANSFER_TEST', customer_code: 'CUST_T', customer_name: 'Test', vendor_code: 'VEND_T', is_active: 1,
  });
  await insert('master_skus', { pep_code: 'MCAFF_TEST_002', product_name: 'Test Face Wash', brand_name: 'HYPHEN', product_type: 'Main Unit', mrp: 200, is_active: 1, created_at: new Date(), updated_at: new Date() });
  await insert('master_skus', { pep_code: 'COMBO_TEST', product_name: 'Test Kit', brand_name: 'mCaffeine', product_type: 'Combo', mrp: 999, is_active: 1, created_at: new Date(), updated_at: new Date() });
});
afterAll(closeDb);

const ref = (serial: number, tag = '') => `TEST_PFX|${refDateToken(today)}|${tag}${serial}`;

const newDraft = async (body: Record<string, unknown> = {}) =>
  (await api().post(P).set('Cookie', admin.cookie).send({
    senderId, channel: 'McaffeineB2C', locationId: String(locationId), priority: 'P2', lines: [{ skuCode: m.pepCode, qty: 10 }], ...body,
  }).expect(201)).body.data;

describe('upload', () => {
  it('template: the PEPIMS columns + ours, as CSV', async () => {
    const res = await api().get(`${P}/template`).set('Cookie', admin.cookie).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\r\n')[0]).toBe(`${HEAD},Uniware Channel`);
  });

  it('preview: checks every row, groups, shows the reference it would take; writes nothing', async () => {
    const res = await upload('/uploads/preview', csv(line(), line({ sku: 'MCAFF_TEST_002', qty: 4 }), line({ group: 'G', type: 'Internal' }))).expect(200);
    const d = res.body.data;
    expect(d).toMatchObject({ rowCount: 3, canImport: true, errorCount: 0 });
    expect(d.transfers.map((t: { rows: number[]; referencePreview: string }) => [t.rows, t.referencePreview])).toEqual([[[2, 3], ref(1)], [[4], ref(2, 'Int')]]);
    expect(d.transfers[0].lines[0]).toMatchObject({ skuCode: m.pepCode, qty: 10, gmv: 4990, poValue: 748.5 });
    expect(await count('master_purchase_orders', 'transferCode IS NOT NULL')).toBe(0);
  });

  it('preview: per-row errors and warnings, canImport false', async () => {
    const res = await upload('/uploads/preview', csv(line({ sku: 'COMBO_TEST' }), line({ sender: 'TEST_RECV' }), line({ priority: 'P9' }), line({ qty: 0 }))).expect(200);
    const d = res.body.data;
    expect(d.canImport).toBe(false);
    expect(d.rows.map((r: { errors: { message: string }[] }) => r.errors.map((e) => e.message).join(' | '))).toEqual([
      'SKU COMBO_TEST is a combo: transfer its components',
      expect.stringContaining('Dispatch and receiving facility are the same'),
      'Priority P9 must be P1, P2 or P3',
      'Qty 0 must be a whole number above 0',
    ]);
  });

  it('refuses a non-CSV, missing columns; editor only', async () => {
    expect((await upload('/uploads/preview', csv(line()), admin, 'x.xlsx')).body.error.code).toBe('D2C_UPLOAD_FILE');
    expect((await upload('/uploads/preview', Buffer.from('Channel,Qty\nA,1\n'))).body.error.message).toContain('missing column(s)');
    const viewer = await loginAs('viewer');
    expect((await upload('/uploads/preview', csv(line()), viewer)).status).toBe(403);
  });

  it('import: all or nothing; drafts with codes, lines, a created log (bulk_csv), the file on S3', async () => {
    const res = await upload('/uploads/import', csv(line(), line({ sku: 'MCAFF_TEST_002', qty: 4 }), line({ group: 'G', type: 'Internal' }))).expect(201);
    const d = res.body.data;
    expect(d.transfers.map((t: { reference: string }) => t.reference)).toEqual([ref(1), ref(2, 'Int')]);
    expect(d.transfers[0].transferCode).toMatch(/^IT-\d{4}-\d{2}-001$/);
    expect(d.fileUrl).toMatch(/^s3:\/\/.+\/d2c-transfers\/uploads\/\d{4}\/\d{2}\/.+-transfers\.csv$/);
    expect(s3Objects('d2c-transfers/uploads/').size).toBe(1);

    const [h] = await rows<Record<string, unknown>>('SELECT * FROM master_purchase_orders WHERE uid = ?', [d.transfers[0].uid]);
    expect(h).toMatchObject({
      poNumber: ref(1), channel: 'McaffeineB2C', facility: 'TEST_SEND', facilityId: senderId, location: 'TestLoc', locationId: String(locationId),
      customerCode: 'CUST_T', channelType: 'D2C', labelsLink: expect.any(String), totalUnits: 14, brandName: 'MCaffeine', statusActive: 'Active',
      statusPlanning: 'Confirmed', statusWarehouse: null, transferType: 'Regular', transferPriority: 'P1', transferStage: 'draft', transferFileUrl: d.fileUrl,
      transferBatchId: d.batchId, orderNo1: null, soState: null,
    });
    const lines = await rows<Record<string, unknown>>('SELECT srNo, skuCode, channelSkuCode, qty, updatedQty, gmv, poValue, brandName, poNumber FROM details_purchase_orders WHERE shipmentOrderId = ? ORDER BY id', [d.transfers[0].uid]);
    expect(lines).toEqual([
      { srNo: '1', skuCode: m.pepCode, channelSkuCode: m.pepCode, qty: 10, updatedQty: 10, gmv: '4990.00', poValue: '748.50', brandName: 'MCaffeine', poNumber: ref(1) },
      { srNo: '2', skuCode: 'MCAFF_TEST_002', channelSkuCode: 'MCAFF_TEST_002', qty: 4, updatedQty: 4, gmv: '800.00', poValue: '120.00', brandName: 'Hyphen', poNumber: ref(1) },
    ]);
    const logs = await rows<{ action: string; source: string; batch_id: string; remark: string }>("SELECT action, source, batch_id, remark FROM shipment_logs WHERE action = 'created' ORDER BY id");
    expect(logs.map((l) => [l.source, l.batch_id, l.remark])).toEqual([['bulk_csv', d.batchId, d.transfers[0].transferCode], ['bulk_csv', d.batchId, `${d.transfers[1].transferCode} | group G`]]);
    const [state] = await rows<{ value: unknown }>("SELECT value FROM app_state WHERE state_key = 'd2c:ref-serial'");
    expect(JSON.stringify(state.value)).toContain(`"${today}":2`);

    // PO Overview never shows transfers
    const po = await api().get(`${V}/po-overview/shipments`).set('Cookie', admin.cookie).expect(200);
    expect(po.body.meta.total).toBe(0);
  });

  it('import with one bad row: 422, nothing written, no file kept', async () => {
    const res = await upload('/uploads/import', csv(line(), line({ sku: 'NOPE' })));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('D2C_INVALID');
    expect(res.body.error.details).toEqual([{ row: 3, field: 'skuCode', message: 'SKU NOPE is not in the SKU master' }]);
    expect(await count('master_purchase_orders', 'transferCode IS NOT NULL')).toBe(0);
    expect(s3Objects('d2c-transfers/').size).toBe(0);
  });
});

describe('form + reads', () => {
  it('options, SKU picker and the next reference', async () => {
    const o = (await api().get(`${P}/options`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(o.senders.map((s: { code: string }) => s.code)).toEqual(['TEST_RECV', 'TEST_SEND']);
    const mc = o.locations.find((l: { channel: string }) => l.channel === 'McaffeineB2C');
    expect(mc.locations[0]).toMatchObject({ id: String(locationId), location: 'TestLoc', poPrefix: 'TEST_PFX', receivingCode: 'TEST_RECV', routes: [{ senderId, missingVendor: false }] });
    expect(o.defaults).toMatchObject({ priority: 'P2', type: 'Regular', expiryDays: 15 });
    const skus = (await api().get(`${P}/skus?q=MCAFF_TEST`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(skus.map((s: { code: string }) => s.code)).toEqual(['MCAFF_TEST_001', 'MCAFF_TEST_002']);
    expect(skus[0]).toMatchObject({ mrp: 499, soUnitPrice: 74.85 });
    const next = (await api().get(`${P}/next-reference?locationId=${locationId}&type=Freebee`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(next.reference).toBe(ref(1, 'Freebee'));
    expect((await api().get(`${P}/next-reference`).set('Cookie', admin.cookie)).status).toBe(400);
  });

  it('form: a draft (source screen) with defaults; errors as 422 with details', async () => {
    const d = await newDraft({ remarks: 'BOGO' });
    expect(d).toMatchObject({ reference: ref(1), priority: 'P2', type: 'Regular', stage: 'draft', source: 'screen', remarks: 'BOGO', poDate: today });
    expect(d.expiryDate > today).toBe(true);
    expect(d.lines).toHaveLength(1);
    expect(d.can).toEqual({ edit: true, cancel: true, changeExpiry: true });
    expect(d.route).toMatchObject({ customerCode: 'CUST_T', vendorCode: 'VEND_T' });
    expect(d.timeline.map((t: { action: string; tag: string }) => [t.action, t.tag])).toEqual([['created', 'TOOL']]);
    const bad = await api().post(P).set('Cookie', admin.cookie).send({ senderId, channel: 'McaffeineB2C', locationId: String(locationId), lines: [{ skuCode: 'COMBO_TEST', qty: 1 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].message).toContain('combo');
    expect((await api().post(P).set('Cookie', admin.cookie).send({ senderId, lines: [] })).status).toBe(400);
  });

  it('list per tab, filters, search, counts, detail, timeline; viewer may read', async () => {
    const a = await newDraft();
    const b = await newDraft({ priority: 'P1', lines: [{ skuCode: 'MCAFF_TEST_002', qty: 3 }] });
    const viewer = await loginAs('viewer');
    const list = async (q: string) => (await api().get(`${P}?${q}`).set('Cookie', viewer.cookie).expect(200)).body;
    const all = await list('tab=draft');
    expect(all.meta.total).toBe(2);
    expect(all.data.map((t: { uid: string }) => t.uid)).toEqual([b.uid, a.uid]); // P1 first
    expect(all.data[0].totals).toMatchObject({ skus: 1, qty: 3, openBalance: 3, dispatched: 0 });
    expect((await list('tab=sale_orders')).meta.total).toBe(0);
    expect((await list('q=MCAFF_TEST_002')).data.map((t: { uid: string }) => t.uid)).toEqual([b.uid]);
    expect((await list(`q=${encodeURIComponent(a.transferCode)}`)).meta.total).toBe(1);
    expect((await list('priority=P2&sender=TEST_SEND&receiving=TEST_RECV&source=screen&channel=McaffeineB2C&type=Regular')).meta.total).toBe(1);
    expect((await list(`dateFrom=${today}&dateTo=${today}&stage=draft&expired=false`)).meta.total).toBe(2);
    expect((await list('expired=true')).meta.total).toBe(0);
    expect((await api().get(`${P}?tab=nope`).set('Cookie', viewer.cookie)).status).toBe(400);
    const counts = (await api().get(`${P}/counts`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(counts).toEqual({ draft: 2, sale_orders: 0, create_inward_po: 0, inward_pos: 0, overview: 2 });
    const one = (await api().get(`${P}/${a.uid}`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(one.editToken).toMatch(/^[0-9a-f]{64}$/);
    const ev = (await api().get(`${P}/${a.uid}/events`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(ev).toHaveLength(1);
    expect((await api().get(`${P}/999999`).set('Cookie', viewer.cookie)).status).toBe(404);
    expect((await api().post(P).set('Cookie', viewer.cookie).send({})).status).toBe(403);
    expect((await api().get(P)).status).toBe(401);
  });

  it('export at PO and SKU level, formula cells escaped', async () => {
    await newDraft({ remarks: '=HYPERLINK("x")', lines: [{ skuCode: m.pepCode, qty: 10 }, { skuCode: 'MCAFF_TEST_002', qty: 2 }] });
    const po = await api().get(`${P}/export?level=po`).set('Cookie', admin.cookie).expect(200);
    expect(po.headers['content-type']).toContain('text/csv');
    const poLines = po.text.replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '').trim().split('\r\n');
    expect(poLines).toHaveLength(2);
    expect(poLines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    const sku = await api().get(`${P}/export?level=sku`).set('Cookie', admin.cookie).expect(200);
    expect(sku.text.trim().split('\r\n')).toHaveLength(3);
    expect((await api().get(`${P}/export?level=line`).set('Cookie', admin.cookie)).status).toBe(400);
  });
});

describe('edit, cancel, expiry', () => {
  it('edit a draft: qty change, new line, type change re-takes the reference; every change logged', async () => {
    const d = await newDraft();
    const res = await api().patch(`${P}/${d.uid}`).set('Cookie', admin.cookie).send({
      token: d.editToken, header: { type: 'Internal', priority: 'P1' }, lines: [{ skuCode: m.pepCode, qty: 12 }, { skuCode: 'MCAFF_TEST_002', qty: 1 }],
    }).expect(200);
    const e = res.body.data;
    expect(e.reference).toBe(ref(2, 'Int'));
    expect(e).toMatchObject({ type: 'Internal', priority: 'P1' });
    expect(e.lines.map((l: { skuCode: string; qty: number }) => [l.skuCode, l.qty])).toEqual([[m.pepCode, 12], ['MCAFF_TEST_002', 1]]);
    const logs = await rows<{ action: string; field_name: string; old_value: string; new_value: string }>(
      "SELECT action, field_name, old_value, new_value FROM shipment_logs WHERE shipment_uid = ? AND action <> 'created' ORDER BY id", [d.uid]);
    expect(logs.map((l) => [l.action, l.field_name])).toEqual([
      ['field_changed', 'transferPriority'], ['field_changed', 'transferType'], ['field_changed', 'poNumber'], ['field_changed', 'qty'], ['line_added', 'qty'],
    ]);
    expect(logs[2]).toMatchObject({ old_value: ref(1), new_value: ref(2, 'Int') });

    // the old token is stale now
    const stale = await api().patch(`${P}/${d.uid}`).set('Cookie', admin.cookie).send({ token: d.editToken, header: { priority: 'P3' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('D2C_STALE');

    // removing a line keeps it with updatedQty 0
    await api().patch(`${P}/${d.uid}`).set('Cookie', admin.cookie).send({ token: e.editToken, lines: [{ skuCode: m.pepCode, qty: 12 }] }).expect(200);
    const [removed] = await rows<{ qty: number; updatedQty: number }>("SELECT qty, updatedQty FROM details_purchase_orders WHERE shipmentOrderId = ? AND skuCode = 'MCAFF_TEST_002'", [d.uid]);
    expect(removed).toEqual({ qty: 1, updatedQty: 0 });
    expect(await count('shipment_logs', "action = 'line_removed' AND shipment_uid = ?", [d.uid])).toBe(1);
  });

  it('expiry change is logged; cancel makes the draft read-only', async () => {
    const d = await newDraft();
    const exp = await api().post(`${P}/${d.uid}/expiry`).set('Cookie', admin.cookie).send({ date: '2099-01-31', remark: 'extended' }).expect(200);
    expect(exp.body.data).toMatchObject({ expiryDate: '2099-01-31', changed: true });
    expect((await api().post(`${P}/${d.uid}/expiry`).set('Cookie', admin.cookie).send({ date: '2000-01-01' })).status).toBe(400);
    expect(await count('shipment_logs', "action = 'expiry_changed' AND field_name = 'labelsLink'")).toBe(1);

    expect((await api().post(`${P}/${d.uid}/cancel`).set('Cookie', admin.cookie).send({})).status).toBe(400);
    const c = (await api().post(`${P}/${d.uid}/cancel`).set('Cookie', admin.cookie).send({ reason: 'raised twice' }).expect(200)).body.data;
    expect(c).toMatchObject({ stage: 'cancelled', can: { edit: false, cancel: false, changeExpiry: false } });
    expect(c.totals).toMatchObject({ qty: 10, updatedQty: 0, cancelled: 10 });
    const [h] = await rows<{ statusPlanning: string }>('SELECT statusPlanning FROM master_purchase_orders WHERE uid = ?', [d.uid]);
    expect(h.statusPlanning).toBe('Cancelled');
    const again = await api().patch(`${P}/${d.uid}`).set('Cookie', admin.cookie).send({ token: c.editToken, header: { priority: 'P1' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('D2C_NOT_EDITABLE');
    expect((await api().post(`${P}/${d.uid}/expiry`).set('Cookie', admin.cookie).send({ date: '2099-02-01' })).status).toBe(409);
  });

  it('a channel PO is not a transfer (404)', async () => {
    const uid = await insert('master_purchase_orders', { poNumber: 'PO-1', channel: 'BigBasket', facility: m.facilityCode });
    expect((await api().get(`${P}/${uid}`).set('Cookie', admin.cookie)).status).toBe(404);
    expect((await api().post(`${P}/${uid}/cancel`).set('Cookie', admin.cookie).send({ reason: 'x' })).status).toBe(404);
  });
});

describe('live', () => {
  it('changes: only transfer changes, the cursor moves past channel-PO rows too', async () => {
    const uid = await insert('master_purchase_orders', { poNumber: 'PO-1', channel: 'BigBasket', facility: m.facilityCode });
    await insert('shipment_logs', { shipment_uid: uid, action: 'created', source: 'pipeline' });
    const d = await newDraft();
    const res = (await api().get(`${P}/changes?after=0`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(res.changes.map((c: { uid: string }) => c.uid)).toEqual([d.uid]);
    expect(res.changes[0].isTransfer).toBeUndefined();
    const po = (await api().get(`${V}/po-overview/changes?after=0`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(po.changes.map((c: { uid: string }) => c.uid)).toEqual([String(uid)]);
  });

  it('events: an SSE stream for page viewers', async () => {
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const ctl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}${P}/events`, { headers: { Cookie: admin.cookie }, signal: ctl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      ctl.abort();
      expect((await fetch(`http://127.0.0.1:${port}${P}/events`)).status).toBe(401);
    } finally {
      server.close();
    }
  });
});
