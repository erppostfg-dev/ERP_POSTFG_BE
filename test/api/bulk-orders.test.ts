import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { covers } from '../helpers/routes';

/*
 * Bulk Orders portal step 1 (2026-11-11): access by the 3 bulk roles (each only its own type, nothing of POST_FG),
 * SKU search with MRP, price = MRP less discount % from OUR master (never the request's), unique PO numbers per type
 * and year (also under parallel creates), saved locations per type, validation, and nothing of the PO chain touched.
 */
covers(['GET /bulk-orders', 'POST /bulk-orders', 'GET /bulk-orders/skus', 'GET /bulk-orders/locations', 'POST /bulk-orders/locations', 'GET /bulk-orders/:id',
  'PUT /bulk-orders/:id', 'POST /bulk-orders/:id/cancel', 'POST /bulk-orders/:id/approve', 'POST /bulk-orders/:id/reject',
  'GET /po-review/bulk-orders', 'GET /po-review/bulk-orders/:id',
  'POST /bulk-orders/:id/documents', 'GET /bulk-orders/:id/documents/:docId', 'POST /bulk-orders/:id/payment', 'GET /bulk-orders/settings',
  'PUT /bulk-orders/settings/:type', 'POST /po-review/bulk-orders/:id/documents', 'GET /po-review/bulk-orders/:id/documents/:docId',
  'GET /po-review/bulk-orders/:id/process-options', 'POST /po-review/bulk-orders/:id/process', 'POST /po-review/bulk-orders/:id/payment']);

const V = '/api/v1/bulk-orders';
const YEAR = new Date(Date.now() + 5.5 * 3600_000).getUTCFullYear();
const TOMORROW = new Date(Date.now() + 5.5 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
const ADDRESS = { line: '12, MG Road, Andheri East', city: 'Mumbai', state: 'Maharashtra', pincode: '400069' };

let mkt: TestLogin;
let inst: TestLogin;
let approver: TestLogin;
let opsExec: TestLogin;
let skuA: number;

/** Institutional requester details (required since 2026-11-12); added to every Institutional order of the tests. */
const INSTITUTION = { institutionName: 'Sunrise Public School', gstin: '27AAACS1234A1Z5', contactEmail: 'office@sunrise.example', billingSameAsDelivery: true };
/** Default lines: Institutional with discounts (MRP less discount %); Marketing without (every unit ₹1, no discount, 2026-11-13). */
const order = (over: Record<string, unknown> = {}) => {
  const discounted = over.type === 'institutional';
  const o: Record<string, unknown> = {
    type: 'marketing', orderedBy: 'Brand team', receiverName: 'Ravi Kumar', receiverPhone: '+91 98765-43210',
    address: ADDRESS, neededBy: TOMORROW, mode: 'Courier', priority: 'Standard',
    lines: discounted ? [{ pepCode: 'SKU_A', qty: 10, discountPct: 30 }, { pepCode: 'SKU_B', qty: 3, discountPct: 12.5 }] : [{ pepCode: 'SKU_A', qty: 10 }, { pepCode: 'SKU_B', qty: 3 }],
    ...over,
  };
  return o.type === 'institutional' ? { ...INSTITUTION, ...o } : o;
};
const create = (who: TestLogin, body: Record<string, unknown>) => api().post(V).set('Cookie', who.cookie).send(body);
const fields = (res: { body: { error: { details: { field: string }[] } } }) => res.body.error.details.map((d) => d.field);

beforeEach(async () => {
  await resetDb();
  const now = new Date();
  skuA = await insert('master_skus', { pep_code: 'SKU_A', product_name: 'Coffee Body Scrub 100g', mrp: 100, ean_code: '8900000000011', is_active: 1, created_at: now, updated_at: now });
  await insert('master_skus', { pep_code: 'SKU_B', product_name: 'Coffee Face Wash 100ml', mrp: 349, ean_code: '8900000000028', is_active: 1, created_at: now, updated_at: now });
  await insert('master_skus', { pep_code: 'SKU_OFF', product_name: 'Coffee Old Pack', mrp: 199, is_active: 0, created_at: now, updated_at: now });
  await insert('master_skus', { pep_code: 'SKU_NOMRP', product_name: 'Coffee Tester', mrp: null, is_active: 1, created_at: now, updated_at: now });
  mkt = await loginAs('bulk-marketing');
  inst = await loginAs('bulk-institutional');
  approver = await loginAs('bulk-approver');
  opsExec = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('bulk orders: access', () => {
  it('needs a login', async () => {
    await api().get(V).expect(401);
    await api().post(V).send(order()).expect(401);
    await api().get(`${V}/skus?q=SKU`).expect(401);
  });

  it('POST_FG people without a bulk role are refused everywhere in the portal API', async () => {
    expect((await api().get(V).set('Cookie', opsExec.cookie).expect(403)).body.error.code).toBe('BULK_NO_ORDER_ACCESS');
    await api().get(`${V}/skus?q=SKU`).set('Cookie', opsExec.cookie).expect(403);
    expect((await create(opsExec, order()).expect(403)).body.error.code).toBe('BULK_TYPE_NOT_ALLOWED');
  });

  it('bulk roles open no POST_FG page or API, only their own Bulk Orders page', async () => {
    const me = (await api().get('/api/v1/auth/me').set('Cookie', mkt.cookie).expect(200)).body.data;
    expect(me.access['/bulk-orders/marketing']).toBe('editor');
    expect(me.access['/bulk-orders/institutional']).toBe('none');
    expect(me.access['/bulk-orders/approve']).toBe('none');
    for (const page of ['/masters', '/operations', '/operations/po-review', '/planning', '/approvals', '/admin']) expect(me.access[page]).toBe('none');
    await api().get('/api/v1/po-review').set('Cookie', mkt.cookie).expect(403);
    await api().get('/api/v1/masters/pep-skus').set('Cookie', approver.cookie).expect(403);
    const ap = (await api().get('/api/v1/auth/me').set('Cookie', approver.cookie).expect(200)).body.data.access;
    expect([ap['/bulk-orders/approve'], ap['/bulk-orders/marketing'], ap['/bulk-orders/institutional']]).toEqual(['editor', 'viewer', 'viewer']);
  });

  it('each type is independent: Marketing never sees or creates Institutional, the approver sees both and creates none', async () => {
    const m = (await create(mkt, order()).expect(201)).body.data;
    const i = (await create(inst, order({ type: 'institutional', mode: undefined })).expect(201)).body.data;
    expect((await create(mkt, order({ type: 'institutional' })).expect(403)).body.error.code).toBe('BULK_TYPE_NOT_ALLOWED');
    await create(approver, order()).expect(403);
    await api().get(`${V}/${i.id}`).set('Cookie', mkt.cookie).expect(404);
    await api().get(`${V}/${m.id}`).set('Cookie', inst.cookie).expect(404);
    expect((await api().get(V).set('Cookie', mkt.cookie).expect(200)).body.data.map((o: { poNumber: string }) => o.poNumber)).toEqual([m.poNumber]);
    await api().get(`${V}?type=institutional`).set('Cookie', mkt.cookie).expect(403);
    const all = (await api().get(V).set('Cookie', approver.cookie).expect(200)).body;
    expect(all.meta.total).toBe(2);
    await api().get(`${V}/${m.id}`).set('Cookie', approver.cookie).expect(200);
    await api().get(`${V}/locations?type=institutional`).set('Cookie', mkt.cookie).expect(403);
  });
});

describe('bulk orders: SKU search', () => {
  it('active SKUs with an MRP by code start / name / EAN; short text = nothing', async () => {
    const q = async (text: string) => (await api().get(`${V}/skus`).query({ q: text }).set('Cookie', mkt.cookie).expect(200)).body.data as { pepCode: string; mrp: number }[];
    expect((await q('SKU')).map((s) => s.pepCode)).toEqual(['SKU_A', 'SKU_B']);
    expect(await q('face wash')).toEqual([{ pepCode: 'SKU_B', name: 'Coffee Face Wash 100ml', mrp: 349, ean: '8900000000028' }]);
    expect((await q('8900000000011')).map((s) => s.pepCode)).toEqual(['SKU_A']);
    expect(await q('S')).toEqual([]);
    expect(await q('100%')).toEqual([]);
  });

  it('searches the shared cached SKU list: a Masters save shows at once; the order price is always read fresh', async () => {
    const mrpOf = async () => (await api().get(`${V}/skus?q=SKU_A`).set('Cookie', mkt.cookie).expect(200)).body.data[0].mrp as number;
    expect(await mrpOf()).toBe(100);
    // changed outside the Masters page (in-transit upload, script, SQL): the search may show the old MRP (cache, <= 60 s) ...
    await rows('UPDATE master_skus SET mrp = 120 WHERE id = ?', [skuA]);
    expect(await mrpOf()).toBe(100);
    // ... but an order always takes the MRP from the DB
    const o = (await create(inst, order({ type: 'institutional', lines: [{ pepCode: 'SKU_A', qty: 1, discountPct: 0 }] })).expect(201)).body.data;
    expect(o.lines[0]).toMatchObject({ mrp: 120, unitPrice: 120 });
    // a Masters page save drops the cached list at once
    const admin = await loginAs('admin');
    await api().patch(`/api/v1/masters/edit/pep_sku/${skuA}`).set('Cookie', admin.cookie).send({ changes: { mrp: 150 } }).expect(200);
    expect(await mrpOf()).toBe(150);
  });
});

describe('bulk orders: create', () => {
  it('Institutional price = MRP from our master less the discount; totals; requested values kept; pending approval; phone cleaned', async () => {
    const res = await create(inst, order({ type: 'institutional', lines: [{ pepCode: 'sku_a', qty: 10, discountPct: 30, mrp: 1, unitPrice: 1 }, { pepCode: 'SKU_B', qty: 3, discountPct: 12.5 }] })).expect(201);
    const o = res.body.data;
    expect(o).toMatchObject({
      poNumber: `INST-${YEAR}-0001`, type: 'institutional', status: 'pending_approval', receiverPhone: '9876543210', mode: null,
      lineCount: 2, totalUnits: 13, totalMrp: 2047, totalValue: 1616.14, neededBy: TOMORROW,
      location: { id: null, label: null, address: ADDRESS }, createdBy: { id: inst.userId },
    });
    expect(o.lines).toEqual([
      { lineNo: 1, pepCode: 'SKU_A', name: 'Coffee Body Scrub 100g', mrp: 100, qty: 10, discountPct: 30, unitPrice: 70, lineTotal: 700, requestedQty: 10, requestedDiscountPct: 30 },
      { lineNo: 2, pepCode: 'SKU_B', name: 'Coffee Face Wash 100ml', mrp: 349, qty: 3, discountPct: 12.5, unitPrice: 305.38, lineTotal: 916.14, requestedQty: 3, requestedDiscountPct: 12.5 },
    ]);
    expect((await api().get(`${V}/${o.id}`).set('Cookie', inst.cookie).expect(200)).body.data).toEqual(o);
  });

  it('Marketing (2026-11-13): every unit ₹1 whatever the MRP, no discount (a discount sent = 400), MRP still kept', async () => {
    const o = (await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 10 }, { pepCode: 'SKU_B', qty: 3, discountPct: 0 }] })).expect(201)).body.data;
    expect(o).toMatchObject({ poNumber: `MKT-${YEAR}-0001`, type: 'marketing', lineCount: 2, totalUnits: 13, totalMrp: 2047, totalValue: 13 });
    expect(o.lines.map((l: Record<string, unknown>) => [l.pepCode, l.mrp, l.discountPct, l.unitPrice, l.lineTotal])).toEqual([['SKU_A', 100, 0, 1, 10], ['SKU_B', 349, 0, 1, 3]]);
    const res = await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 1, discountPct: 30 }] })).expect(400);
    expect(fields(res)).toEqual(['lines[0].discountPct']);
    expect(res.body.error.details[0].message).toContain('no discount');
    const edited = (await api().put(`${V}/${o.id}`).set('Cookie', mkt.cookie).send(order({ lines: [{ pepCode: 'SKU_B', qty: 5 }] })).expect(200)).body.data;
    expect(edited).toMatchObject({ totalValue: 5, totalMrp: 1745 });
  });

  it('PO numbers: one series per type and year, never repeated (also when 8 are created at the same moment)', async () => {
    expect((await create(mkt, order()).expect(201)).body.data.poNumber).toBe(`MKT-${YEAR}-0001`);
    expect((await create(inst, order({ type: 'institutional' })).expect(201)).body.data.poNumber).toBe(`INST-${YEAR}-0001`);
    const many = await Promise.all(Array.from({ length: 8 }, () => create(mkt, order())));
    const numbers = many.map((r) => r.status === 201 && r.body.data.poNumber).sort();
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, k) => `MKT-${YEAR}-${String(k + 2).padStart(4, '0')}`));
    expect(await count('bulk_orders')).toBe(10);
  });

  it('a typed address can be saved by a name, listed for that type only, and picked by id next time', async () => {
    const first = (await create(mkt, order({ saveLocationAs: 'Andheri store' })).expect(201)).body.data;
    expect(first.location.label).toBe('Andheri store');
    const saved = (await api().get(`${V}/locations?type=marketing`).set('Cookie', mkt.cookie).expect(200)).body.data;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: first.location.id, label: 'Andheri store', address: ADDRESS });
    expect((await api().get(`${V}/locations?type=institutional`).set('Cookie', inst.cookie).expect(200)).body.data).toEqual([]);
    const second = (await create(mkt, order({ address: undefined, locationId: saved[0].id })).expect(201)).body.data;
    expect(second.location).toEqual({ id: saved[0].id, label: 'Andheri store', address: ADDRESS });
    // the same name again: refused, and that order is NOT created (one transaction)
    expect((await create(mkt, order({ saveLocationAs: 'Andheri store' })).expect(409)).body.error.code).toBe('BULK_LOCATION_LABEL_TAKEN');
    expect(await count('bulk_orders')).toBe(2);
    // an Institutional location id is not a Marketing one
    const instLoc = (await api().post(`${V}/locations`).set('Cookie', inst.cookie).send({ type: 'institutional', label: 'School', address: ADDRESS }).expect(201)).body.data;
    expect(fields(await create(mkt, order({ address: undefined, locationId: instLoc.id })).expect(400))).toEqual(['locationId']);
  });

  it('every wrong field is reported together; nothing is saved', async () => {
    const res = await create(mkt, {
      type: 'marketing', receiverPhone: '12345', address: { line: 'x', city: 'Mumbai', state: 'MH', pincode: '012345' },
      neededBy: '2020-01-01', mode: 'Plane', lines: [{ pepCode: 'SKU_A', qty: 0, discountPct: 101 }, { pepCode: 'SKU_A', qty: 1.5, discountPct: 10.555 }],
    }).expect(400);
    expect(fields(res).sort()).toEqual([
      'address.pincode', 'lines[0].discountPct', 'lines[0].qty', 'lines[1].discountPct', 'lines[1].pepCode', 'lines[1].qty',
      'mode', 'neededBy', 'orderedBy', 'receiverName', 'receiverPhone',
    ].sort());
    expect(fields(await create(mkt, order({ lines: [] })).expect(400))).toEqual(['lines']);
    expect(fields(await create(mkt, order({ type: 'shop' })).expect(400))).toContain('type');
    expect(await count('bulk_orders')).toBe(0);
    expect(await count('bulk_order_counters')).toBe(0);
  });

  it('a SKU not active or without an MRP in our master is refused with its line', async () => {
    const res = await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 1 }, { pepCode: 'SKU_OFF', qty: 1 }, { pepCode: 'SKU_NOMRP', qty: 1 }, { pepCode: 'NOPE', qty: 1 }] })).expect(400);
    expect(fields(res)).toEqual(['lines[1].pepCode', 'lines[2].pepCode', 'lines[3].pepCode']);
    expect(res.body.error.details[1].message).toContain('no MRP');
  });

  it('Institutional: no delivery mode (ignored); Standard priority by default', async () => {
    const o = (await create(inst, order({ type: 'institutional', mode: 'Porter', priority: undefined })).expect(201)).body.data;
    expect(o).toMatchObject({ mode: null, priority: 'Standard', poNumber: `INST-${YEAR}-0001` });
  });

  it('touches nothing of the PO chain (no upload, PO, sale order or channel row)', async () => {
    await create(mkt, order()).expect(201);
    for (const t of ['po_uploads', 'master_purchase_orders', 'details_purchase_orders', 'sale_order_code_counter', 'details_channels']) expect(await count(t)).toBe(0);
  });
});

describe('bulk orders: list, one order, locations', () => {
  it('list filters by status and search, pages with a total', async () => {
    await create(mkt, order({ orderedBy: 'Brand team' })).expect(201);
    await create(mkt, order({ orderedBy: 'Influencer desk', address: { ...ADDRESS, city: 'Pune' } })).expect(201);
    const list = async (qs: string) => (await api().get(`${V}?${qs}`).set('Cookie', mkt.cookie).expect(200)).body;
    expect((await list('q=pune')).data.map((o: { orderedBy: string }) => o.orderedBy)).toEqual(['Influencer desk']);
    expect((await list('status=pending_approval')).meta.total).toBe(2);
    expect((await list('status=approved')).meta.total).toBe(0);
    const p = await list('pageSize=1&page=2');
    expect([p.meta, p.data.length]).toEqual([{ total: 2, page: 2, pageSize: 1 }, 1]);
    expect(p.data[0].orderedBy).toBe('Brand team');
    await api().get(`${V}?status=done`).set('Cookie', mkt.cookie).expect(400);
    await api().get(`${V}?pageSize=1000`).set('Cookie', mkt.cookie).expect(400);
  });

  it('one order: unknown / bad id = 404', async () => {
    await api().get(`${V}/999`).set('Cookie', mkt.cookie).expect(404);
    await api().get(`${V}/abc`).set('Cookie', mkt.cookie).expect(404);
  });

  it('locations: save needs editor on the type; fields checked', async () => {
    await api().post(`${V}/locations`).set('Cookie', approver.cookie).send({ type: 'marketing', label: 'X', address: ADDRESS }).expect(403);
    const bad = await api().post(`${V}/locations`).set('Cookie', mkt.cookie).send({ type: 'marketing', address: { ...ADDRESS, city: '' } }).expect(400);
    expect(fields(bad).sort()).toEqual(['address.city', 'label']);
    await api().post(`${V}/locations`).set('Cookie', mkt.cookie).send({ type: 'marketing', label: 'Pune hub', address: ADDRESS }).expect(201);
    expect((await api().get(`${V}/locations?type=marketing`).set('Cookie', approver.cookie).expect(200)).body.data[0].label).toBe('Pune hub');
    await api().get(`${V}/locations`).set('Cookie', mkt.cookie).expect(400);
    expect(await rows('SELECT created_by FROM bulk_locations')).toEqual([{ created_by: mkt.userId }]);
  });
});

describe('bulk orders step 2: edit, cancel, approve, reject (timeline)', () => {
  const one = async (who: TestLogin, id: string) => (await api().get(`${V}/${id}`).set('Cookie', who.cookie).expect(200)).body.data;
  const post = (who: TestLogin, id: string, what: string, body: Record<string, unknown> = {}) => api().post(`${V}/${id}/${what}`).set('Cookie', who.cookie).send(body);

  it("the requester's type may edit a pending order: same PO number, lines priced again, still pending; others may not", async () => {
    const o = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const edited = (await api().put(`${V}/${o.id}`).set('Cookie', inst.cookie)
      .send(order({ type: 'marketing', ...INSTITUTION, receiverName: 'Asha', lines: [{ pepCode: 'SKU_B', qty: 2, discountPct: 10 }] })).expect(200)).body.data;
    expect(edited).toMatchObject({ poNumber: o.poNumber, type: 'institutional', status: 'pending_approval', receiverName: 'Asha', lineCount: 1, totalValue: 628.2 });
    expect(edited.lines).toEqual([expect.objectContaining({ lineNo: 1, pepCode: 'SKU_B', qty: 2, discountPct: 10, unitPrice: 314.1, requestedQty: 2, requestedDiscountPct: 10 })]);
    expect(edited.events.map((e: { action: string }) => e.action)).toEqual(['created', 'edited']);
    expect(edited.events[1].changes.fields).toEqual(['receiverName']);
    await api().put(`${V}/${o.id}`).set('Cookie', approver.cookie).send(order({ type: 'institutional' })).expect(403);
    await api().put(`${V}/${o.id}`).set('Cookie', mkt.cookie).send(order({ type: 'institutional' })).expect(404);
  });

  it('cancel: by its type, reason optional; a cancelled order cannot be edited, approved or cancelled again', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    await post(approver, o.id, 'cancel').expect(403);
    const c = (await post(mkt, o.id, 'cancel', { reason: 'Event postponed' }).expect(200)).body.data;
    expect(c.status).toBe('cancelled');
    expect(c.events[1]).toMatchObject({ action: 'cancelled', note: 'Event postponed', by: { id: mkt.userId } });
    expect((await post(approver, o.id, 'approve').expect(409)).body.error.code).toBe('BULK_ORDER_NOT_PENDING');
    await post(mkt, o.id, 'cancel').expect(409);
    await api().put(`${V}/${o.id}`).set('Cookie', mkt.cookie).send(order()).expect(409);
    expect((await api().get(`${V}?status=cancelled`).set('Cookie', mkt.cookie).expect(200)).body.meta.total).toBe(1);
  });

  it("approve: approver changes qty / discount, removes a line; priced on TODAY's MRP; requested values kept; changes on the timeline", async () => {
    const o = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data; // SKU_A 10 @30% (MRP 100), SKU_B 3 @12.5%
    await rows('UPDATE master_skus SET mrp = 110 WHERE id = ?', [skuA]); // MRP changed since the order
    await post(inst, o.id, 'approve').expect(403);
    const a = (await post(approver, o.id, 'approve', { lines: [{ lineNo: 1, qty: 8, discountPct: 25 }], removeLines: [2], note: 'Cut to budget' }).expect(200)).body.data;
    expect(a).toMatchObject({ status: 'approved', decidedBy: { id: approver.userId }, decisionNote: 'Cut to budget', lineCount: 1, totalUnits: 8, totalMrp: 880, totalValue: 660 });
    expect(a.lines).toEqual([expect.objectContaining({ lineNo: 1, mrp: 110, qty: 8, discountPct: 25, unitPrice: 82.5, lineTotal: 660, requestedQty: 10, requestedDiscountPct: 30 })]);
    expect(a.events[1]).toMatchObject({ action: 'approved', note: 'Cut to budget', by: { id: approver.userId } });
    expect(a.events[1].changes.lines).toEqual([
      { lineNo: 1, pepCode: 'SKU_A', qty: [10, 8], discountPct: [30, 25], mrp: [100, 110] },
      { lineNo: 2, pepCode: 'SKU_B', removed: true },
    ]);
    // the requester sees the same
    expect((await one(inst, o.id)).totalValue).toBe(660);
    expect((await post(approver, o.id, 'reject', { reason: 'x' }).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_PENDING');
  });

  it('approve a Marketing order: qty may change, a discount is refused, every unit stays ₹1', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    expect(fields(await post(approver, o.id, 'approve', { lines: [{ lineNo: 1, discountPct: 20 }] }).expect(400))).toEqual(['lines[0].discountPct']);
    const a = (await post(approver, o.id, 'approve', { lines: [{ lineNo: 1, qty: 4 }, { lineNo: 2, discountPct: 0 }] }).expect(200)).body.data;
    expect(a).toMatchObject({ status: 'approved', totalUnits: 7, totalValue: 7 });
    expect(a.lines.map((l: Record<string, unknown>) => [l.qty, l.unitPrice, l.lineTotal])).toEqual([[4, 1, 4], [3, 1, 3]]);
  });

  it('a Marketing order saved with discounts before the ₹1 rule: approval sets every unit to ₹1 (on the timeline)', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    await rows('UPDATE bulk_order_lines SET discount_pct = 30, requested_discount_pct = 30, unit_price = 70, line_total = 700 WHERE order_id = ? AND line_no = 1', [o.id]);
    const a = (await post(approver, o.id, 'approve').expect(200)).body.data;
    expect(a.lines[0]).toMatchObject({ discountPct: 0, unitPrice: 1, lineTotal: 10, requestedDiscountPct: 30 });
    expect(a.events[1].changes.lines).toEqual([{ lineNo: 1, pepCode: 'SKU_A', discountPct: [30, 0] }]);
  });

  it('approve checks: known line numbers, at least one line stays, every SKU still sellable today', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    expect(fields(await post(approver, o.id, 'approve', { lines: [{ lineNo: 9, qty: 0 }] }).expect(400)).sort()).toEqual(['lines[0].lineNo', 'lines[0].qty']);
    expect(fields(await post(approver, o.id, 'approve', { removeLines: [1, 2] }).expect(400))).toEqual(['removeLines']);
    await rows('UPDATE master_skus SET is_active = 0 WHERE id = ?', [skuA]);
    const res = await post(approver, o.id, 'approve').expect(400);
    expect(res.body.error.details[0].message).toContain('remove the line or reject');
    expect((await post(approver, o.id, 'approve', { removeLines: [1] }).expect(200)).body.data.lineCount).toBe(1);
  });

  it('reject needs a reason; two approvers at the same moment: one decision only; admin may approve their own order', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    expect(fields(await post(approver, o.id, 'reject').expect(400))).toEqual(['reason']);
    const approver2 = await loginAs('bulk-approver');
    const [r1, r2] = await Promise.all([post(approver, o.id, 'reject', { reason: 'Over budget' }), post(approver2, o.id, 'approve')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const final = await one(approver, o.id);
    expect(final.events.filter((e: { action: string }) => e.action !== 'created')).toHaveLength(1);
    const admin = await loginAs('admin');
    const own = (await create(admin, order()).expect(201)).body.data;
    expect((await post(admin, own.id, 'approve').expect(200)).body.data).toMatchObject({ status: 'approved', decidedBy: { id: admin.userId } });
  });
});

describe('bulk orders step 3a: our team sees them in PO Processing & Review (read only)', () => {
  const T = '/api/v1/po-review/bulk-orders';

  it('anyone with PO review access sees both types + the approved-and-waiting count per type; portal people are refused', async () => {
    const m1 = (await create(mkt, order()).expect(201)).body.data;
    await create(mkt, order()).expect(201);
    const i1 = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await api().post(`${V}/${m1.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200);
    await api().post(`${V}/${i1.id}/reject`).set('Cookie', approver.cookie).send({ reason: 'No budget' }).expect(200);

    const all = (await api().get(T).set('Cookie', opsExec.cookie).expect(200)).body;
    expect(all.meta).toMatchObject({ total: 3, waiting: { marketing: 1, institutional: 0 } });
    const viewer = await loginAs('viewer'); // PO review viewer: sees it too
    const approved = (await api().get(`${T}?type=marketing&status=approved`).set('Cookie', viewer.cookie).expect(200)).body;
    expect(approved.data.map((o: { poNumber: string }) => o.poNumber)).toEqual([m1.poNumber]);
    expect((await api().get(`${T}?type=institutional`).set('Cookie', viewer.cookie).expect(200)).body.data[0]).toMatchObject({ status: 'rejected', decisionNote: 'No budget' });

    const one = (await api().get(`${T}/${m1.id}`).set('Cookie', opsExec.cookie).expect(200)).body.data;
    expect(one).toMatchObject({ poNumber: m1.poNumber, status: 'approved', lineCount: 2 });
    expect(one.events.map((e: { action: string }) => e.action)).toEqual(['created', 'approved']);
    await api().get(`${T}/999999`).set('Cookie', opsExec.cookie).expect(404);
    await api().get(`${T}?status=done`).set('Cookie', opsExec.cookie).expect(400);

    for (const portal of [mkt, approver]) {
      await api().get(T).set('Cookie', portal.cookie).expect(403);
      await api().get(`${T}/${m1.id}`).set('Cookie', portal.cookie).expect(403);
    }
    await api().get(T).expect(401);
  });
});

describe('bulk orders: payment check + documents + settings (2026-11-12)', () => {
  const T = '/api/v1/po-review/bulk-orders';
  const PDF = Buffer.from('%PDF-1.4\n% proof\n');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const up = (who: TestLogin, id: string, kind: string, file: Buffer, name: string, base = V) =>
    api().post(`${base}/${id}/documents`).set('Cookie', who.cookie).field('kind', kind).attach('file', file, name);
  const pay = (who: TestLogin, id: string, body: Record<string, unknown>) => api().post(`${V}/${id}/payment`).set('Cookie', who.cookie).send(body);

  it('payment check per type: Institutional ON (awaiting proof), Marketing OFF (no payment line); admin turns it on for new orders only', async () => {
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const m = (await create(mkt, order()).expect(201)).body.data;
    expect(i.payment).toMatchObject({ status: 'awaiting_proof', by: null });
    expect(m.payment).toBeNull();

    for (const who of [mkt, approver, opsExec]) expect((await api().get(`${V}/settings`).set('Cookie', who.cookie).expect(403)).body.error.code).toBe('BULK_NOT_SETTINGS_ADMIN');
    const admin = await loginAs('admin');
    expect((await api().get(`${V}/settings`).set('Cookie', admin.cookie).expect(200)).body.data.map((x: { type: string; paymentCheck: boolean }) => [x.type, x.paymentCheck]))
      .toEqual([['marketing', false], ['institutional', true]]);
    await api().put(`${V}/settings/marketing`).set('Cookie', admin.cookie).send({ paymentCheck: 'yes' }).expect(400);
    await api().put(`${V}/settings/other`).set('Cookie', admin.cookie).send({ paymentCheck: true }).expect(400);
    await api().put(`${V}/settings/marketing`).set('Cookie', mkt.cookie).send({ paymentCheck: true }).expect(403);
    const after = (await api().put(`${V}/settings/marketing`).set('Cookie', admin.cookie).send({ paymentCheck: true }).expect(200)).body.data;
    expect(after[0]).toMatchObject({ type: 'marketing', paymentCheck: true, updatedBy: { id: admin.userId } });
    expect((await create(mkt, order()).expect(201)).body.data.payment.status).toBe('awaiting_proof');
    expect((await api().get(`${V}/${m.id}`).set('Cookie', mkt.cookie).expect(200)).body.data.payment).toBeNull(); // older order unchanged
  });

  it('proof upload -> proof uploaded; admin verifies / refuses (reason); a new proof replaces the old one; never blocks approval', async () => {
    const admin = await loginAs('admin');
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await api().post(`${V}/${i.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200); // no proof needed to approve
    expect((await pay(admin, i.id, { action: 'verify' }).expect(409)).body.error.code).toBe('BULK_PAYMENT_NO_PROOF');

    const a = (await up(inst, i.id, 'payment_proof', PDF, 'utr-1.pdf').expect(201)).body.data;
    expect(a.payment.status).toBe('proof_uploaded');
    expect(a.documents).toMatchObject([{ kind: 'payment_proof', fileName: 'utr-1.pdf', contentType: 'application/pdf', replacedAt: null }]);
    const file = await api().get(`${V}/${i.id}/documents/${a.documents[0].id}`).set('Cookie', approver.cookie).buffer(true)
      .parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); }).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    await pay(inst, i.id, { action: 'verify' }).expect(403); // only "verify payments" (admin / developer)
    expect((await pay(approver, i.id, { action: 'verify' }).expect(403)).body.error.code).toBe('BULK_NOT_PAYMENT_VERIFIER'); // 2026-11-13: not the approver
    expect(fields(await pay(admin, i.id, { action: 'refuse' }).expect(400))).toEqual(['note']);
    const refused = (await pay(admin, i.id, { action: 'refuse', note: 'Amount short by Rs 500' }).expect(200)).body.data;
    expect(refused.payment).toMatchObject({ status: 'refused', by: { id: admin.userId }, note: 'Amount short by Rs 500' });

    const b = (await up(inst, i.id, 'payment_proof', PNG, 'utr-2.png').expect(201)).body.data;
    expect(b.payment.status).toBe('proof_uploaded');
    expect(b.documents.map((d: { fileName: string; replacedAt: string | null }) => [d.fileName, d.replacedAt === null])).toEqual([['utr-2.png', true], ['utr-1.pdf', false]]);
    const ok = (await pay(admin, i.id, { action: 'verify', note: 'UTR matched' }).expect(200)).body.data;
    expect(ok.payment.status).toBe('verified');
    expect(ok.events.filter((e: { action: string }) => e.action === 'payment').map((e: { changes: { status: string[] } }) => e.changes.status))
      .toEqual([['awaiting_proof', 'proof_uploaded'], ['proof_uploaded', 'refused'], ['refused', 'proof_uploaded'], ['proof_uploaded', 'verified']]);
    expect(await count('bulk_order_documents')).toBe(2); // nothing deleted
  });

  it('not needed (free order); no check on the type = 409; closed orders take nothing; uploads checked; other types cannot see a file', async () => {
    const dev = await loginAs('developer');
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    expect((await pay(dev, i.id, { action: 'not_needed', note: 'Sample for school' }).expect(200)).body.data.payment.status).toBe('not_needed');
    expect(fields(await pay(dev, i.id, { action: 'paid' }).expect(400))).toEqual(['action']);

    const m = (await create(mkt, order()).expect(201)).body.data;
    expect((await pay(dev, m.id, { action: 'not_needed' }).expect(409)).body.error.code).toBe('BULK_PAYMENT_NOT_TRACKED');
    const mDoc = (await up(mkt, m.id, 'proforma_invoice', PDF, 'pi.pdf').expect(201)).body.data; // documents on every type
    expect(mDoc.payment).toBeNull();
    // no payment check (Marketing, 2026-11-13): a proof of payment is refused, nothing stored
    const noProof = await up(mkt, m.id, 'payment_proof', PDF, 'utr.pdf').expect(400);
    expect(fields(noProof)).toEqual(['kind']);
    expect(noProof.body.error.details[0].message).toContain('no payment check');
    expect(await count('bulk_order_documents')).toBe(1);
    await api().get(`${V}/${m.id}/documents/${mDoc.documents[0].id}`).set('Cookie', inst.cookie).expect(404);
    await api().get(`${V}/${m.id}/documents/999999`).set('Cookie', mkt.cookie).expect(404);

    await up(inst, m.id, 'invoice', PDF, 'x.pdf').expect(404);
    expect(fields(await up(mkt, m.id, 'receipt', Buffer.from('hello'), 'a.txt').expect(400))).toEqual(['kind', 'file']);
    expect(fields(await api().post(`${V}/${m.id}/documents`).set('Cookie', mkt.cookie).field('kind', 'invoice').expect(400))).toEqual(['file']);

    await api().post(`${V}/${m.id}/cancel`).set('Cookie', mkt.cookie).send({}).expect(200);
    expect((await up(mkt, m.id, 'invoice', PDF, 'late.pdf').expect(409)).body.error.code).toBe('BULK_ORDER_CLOSED');
  });

  it('our team: PO review editors upload (viewers only read), see payment + documents; portal people are refused', async () => {
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const d = (await up(opsExec, i.id, 'invoice', PDF, 'inv-77.pdf', T).expect(201)).body.data;
    expect(d.documents[0]).toMatchObject({ kind: 'invoice', by: { id: opsExec.userId } });
    expect(d.payment.status).toBe('awaiting_proof'); // an invoice is not a proof
    const viewer = await loginAs('viewer');
    await up(viewer, i.id, 'invoice', PDF, 'v.pdf', T).expect(403);
    await api().get(`${T}/${i.id}/documents/${d.documents[0].id}`).set('Cookie', viewer.cookie).expect(200);
    const list = (await api().get(`${T}?type=institutional`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(list[0].payment.status).toBe('awaiting_proof');
    await up(inst, i.id, 'invoice', PDF, 'p.pdf', T).expect(403);
    await api().get(`${T}/${i.id}/documents/${d.documents[0].id}`).set('Cookie', inst.cookie).expect(403);
  });

  it('POST_FG payments (2026-11-13): "Payments to verify" list + count; only admin / developer verify (or a role it is switched on for in Roles)', async () => {
    const teamPay = (who: TestLogin, id: string, body: Record<string, unknown>) => api().post(`${T}/${id}/payment`).set('Cookie', who.cookie).send(body);
    const a = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const b = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await up(inst, a.id, 'payment_proof', PDF, 'utr-a.pdf').expect(201);
    await up(inst, b.id, 'payment_proof', PDF, 'utr-b.pdf').expect(201);
    await api().post(`${V}/${b.id}/cancel`).set('Cookie', inst.cookie).send({}).expect(200); // closed: not counted

    const toVerify = (await api().get(`${T}?type=institutional&payment=proof_uploaded`).set('Cookie', opsExec.cookie).expect(200)).body;
    expect(toVerify.data.map((o: { id: string }) => o.id)).toEqual([b.id, a.id]);
    expect(toVerify.meta.paymentsToVerify).toEqual({ marketing: 0, institutional: 1 });
    expect(fields(await api().get(`${T}?payment=paid`).set('Cookie', opsExec.cookie).expect(400))).toEqual(['payment']);

    // PO review editor without the permission: refused; portal-only people: no PO review page
    expect((await teamPay(opsExec, a.id, { action: 'verify' }).expect(403)).body.error.code).toBe('BULK_NOT_PAYMENT_VERIFIER');
    await teamPay(approver, a.id, { action: 'verify' }).expect(403);
    const admin = await loginAs('admin');
    const done = (await teamPay(admin, a.id, { action: 'verify', note: 'UTR 1234 matched' }).expect(200)).body.data;
    expect(done.payment).toMatchObject({ status: 'verified', by: { id: admin.userId }, note: 'UTR 1234 matched' });
    expect((await api().get(`${T}?payment=proof_uploaded`).set('Cookie', opsExec.cookie).expect(200)).body.meta.paymentsToVerify.institutional).toBe(0);
    await teamPay(admin, '999999', { action: 'not_needed' }).expect(404);

    // later (user): a role gets it from Users & Roles -> Roles, no code: the Operations Executive role now verifies
    const c = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await api().patch('/api/v1/admin/roles/operations-executive').set('Cookie', admin.cookie).send({ grants: { '/operations/po-review': 'viewer', 'bulk-orders:verify-payment': 'editor' } }).expect(200); // the screen sends the full set
    const ops2 = await loginAs('operations-executive');
    expect((await teamPay(ops2, c.id, { action: 'not_needed', note: 'Free sample' }).expect(200)).body.data.payment.status).toBe('not_needed');
    expect((await api().get('/api/v1/auth/me').set('Cookie', ops2.cookie).expect(200)).body.data.capabilities['bulk-orders:verify-payment']).toBe(true);
  });
});

describe('bulk orders step 3b: Institutional requester details + our team creates the sale order (2026-11-12)', () => {
  const T = '/api/v1/po-review/bulk-orders';
  const WH = 'MUM_WAREHOUSE2';
  const SALE = { facilityCode: WH, uniwareChannel: 'INSTITUTIONAL_B2B', customerCode: 'CUST_SUNRISE_01' };
  const approve = (id: string) => api().post(`${V}/${id}/approve`).set('Cookie', approver.cookie).send({}).expect(200);
  const processIt = (who: TestLogin, id: string, body: Record<string, unknown> = SALE) => api().post(`${T}/${id}/process`).set('Cookie', who.cookie).send(body);
  const approvedInst = async (over: Record<string, unknown> = {}) => {
    const i = (await create(inst, order({ type: 'institutional', ...over })).expect(201)).body.data as { id: string; poNumber: string };
    await approve(i.id);
    return i;
  };

  beforeEach(async () => {
    const main = await insert('master_facilities', { code: WH, name: 'Bhiwandi', entity: 'PEP', state: 'Maharashtra', is_active: 1, source: 'manual', uniware_export: 0 });
    await insert('master_facilities', { code: 'MUM_Warehouse2', name: 'Bhiwandi child', parent_facility_id: main, entity: 'PEP', state: 'Maharashtra', is_active: 1, source: 'manual', uniware_export: 0 });
    await insert('master_facilities', { code: 'OLD_WH', name: 'Closed', entity: 'PEP', state: 'Maharashtra', is_active: 0, source: 'manual', uniware_export: 0 });
  });

  it('Institutional orders need the institution name + billing address (or same as delivery); GSTIN / email checked when given', async () => {
    const bare = { ...order({ type: 'institutional' }), institutionName: undefined, billingSameAsDelivery: undefined, gstin: 'NOT-A-GSTIN', contactEmail: 'nope' };
    expect(fields(await create(inst, bare).expect(400))).toEqual(expect.arrayContaining(['billingAddress', 'billingAddress.line', 'contactEmail', 'gstin', 'institutionName']));
    const same = (await create(inst, order({ type: 'institutional', gstin: '27aaacs1234a1z5' })).expect(201)).body.data;
    expect(same.institution).toEqual({ name: 'Sunrise Public School', gstin: '27AAACS1234A1Z5', email: 'office@sunrise.example', billingAddress: ADDRESS });
    const billing = { line: 'Accounts, 4 Hill Rd', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
    const own = (await create(inst, order({ type: 'institutional', gstin: '', billingSameAsDelivery: false, billingAddress: billing })).expect(201)).body.data;
    expect(own.institution).toMatchObject({ gstin: null, billingAddress: billing });
    expect((await create(mkt, order()).expect(201)).body.data.institution).toBeNull(); // Marketing: none asked
  });

  it('only PO review editors process, only approved Institutional orders, with an active warehouse + channel + customer code', async () => {
    const pending = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    expect((await processIt(opsExec, pending.id).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_APPROVED');
    const i = await approvedInst();
    const viewer = await loginAs('viewer');
    await processIt(viewer, i.id).expect(403);
    await api().get(`${T}/${i.id}/process-options`).set('Cookie', viewer.cookie).expect(403);
    for (const portal of [inst, approver]) await processIt(portal, i.id).expect(403);
    expect(fields(await processIt(opsExec, i.id, {}).expect(400)).sort()).toEqual(['customerCode', 'facilityCode', 'uniwareChannel']);
    expect(fields(await processIt(opsExec, i.id, { ...SALE, facilityCode: 'OLD_WH' }).expect(400))).toEqual(['facilityCode']);
    expect(fields(await processIt(opsExec, i.id, { ...SALE, facilityCode: 'mum_warehouse2' }).expect(400))).toEqual(['facilityCode']); // case = another warehouse
    const opts = (await api().get(`${T}/${i.id}/process-options`).set('Cookie', opsExec.cookie).expect(200)).body.data;
    expect(opts).toEqual({ facilities: [{ code: WH, name: 'Bhiwandi', parentCode: null }, { code: 'MUM_Warehouse2', name: 'Bhiwandi child', parentCode: WH }], customers: [] }); // child under its main
    expect(await count('master_purchase_orders')).toBe(0);
  });

  it('process = a normal saved PO: erp_ sale order, PO rows, CSV at the approved price, Processed tab (no Verify), payment never blocks', async () => {
    const i = await approvedInst();
    const done = (await processIt(opsExec, i.id).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'processing', payment: { status: 'awaiting_proof' }, saleOrder: { ...SALE, by: { id: opsExec.userId } } });
    const code = done.saleOrder.code as string;
    expect(code).toMatch(/^erp_\d{11}$/);
    expect(done.events.map((e: { action: string }) => e.action)).toEqual(['created', 'approved', 'processed']);

    const [po] = await rows<{ uid: string; channel: string; facility: string; customerCode: string; orderNo1: string; poNumber: string; location: string | null }>(
      'SELECT uid, channel, facility, customerCode, orderNo1, poNumber, location FROM master_purchase_orders');
    expect(po).toMatchObject({ channel: 'Bulk Institutional', facility: WH, customerCode: SALE.customerCode, orderNo1: code, poNumber: i.poNumber, location: null });
    const lines = await rows<{ skuCode: string; qty: number; poValue: string }>('SELECT skuCode, qty, poValue FROM details_purchase_orders WHERE shipmentOrderId = ? ORDER BY id', [po.uid]);
    expect(lines.map((l) => [l.skuCode, l.qty, Number(l.poValue)])).toEqual([['SKU_A', 10, 700], ['SKU_B', 3, 916.14]]);

    const [up] = await rows<{ id: string; source: string; status: string; channel: string; external_id: string }>('SELECT id, source, status, channel, external_id FROM po_uploads');
    expect(up).toMatchObject({ source: 'bulk', status: 'completed', channel: 'Bulk Institutional', external_id: i.poNumber });
    const csvs = [...s3Objects(`bulk-orders/${i.poNumber}/sale-order-1/`).entries()].filter(([k]) => k.endsWith('.csv'));
    expect(csvs).toHaveLength(1);
    const csv = csvs[0][1];
    expect(csv).toContain(`${code},${i.poNumber},0,INSTITUTIONAL_B2B,SKU_A,STD,SKU_A,SKU_A,70.00,FALSE,10,CUST_SUNRISE_01,${WH},`);
    expect(csv).toContain(',305.38,FALSE,3,');

    // Processed tab + CSV unlocked at once (no Verify step for bulk orders)
    const processed = (await api().get('/api/v1/po-review?status=completed').set('Cookie', opsExec.cookie).expect(200)).body.data as { uploadId?: string; id?: string }[];
    expect(processed.map((p) => String(p.uploadId ?? p.id))).toContain(String(up.id));
    await api().get(`/api/v1/po-review/${up.id}/uniware-csv`).set('Cookie', opsExec.cookie).expect(200);
    expect((await api().get(`/api/v1/po-verify?uploadIds=${up.id}`).set('Cookie', opsExec.cookie).expect(200)).body.data.items[0].state).not.toBe('to_verify');

    expect((await processIt(opsExec, i.id).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_APPROVED'); // never twice
    expect(await count('master_purchase_orders')).toBe(1);
  });

  it('customer book: the next order of the same GSTIN (or name + pincode) gets the channel + code suggested; one row, used twice', async () => {
    const a = await approvedInst();
    await processIt(opsExec, a.id).expect(200);
    const b = await approvedInst({ receiverName: 'Asha' });
    const opts = (await api().get(`${T}/${b.id}/process-options`).set('Cookie', opsExec.cookie).expect(200)).body.data;
    expect(opts.customers).toEqual([expect.objectContaining({ name: 'Sunrise Public School', uniwareChannel: 'INSTITUTIONAL_B2B', customerCode: 'CUST_SUNRISE_01', usedCount: 1, matchedBy: 'gstin' })]);
    const c = await approvedInst({ gstin: '', institutionName: 'sunrise public school.' });
    expect((await api().get(`${T}/${c.id}/process-options`).set('Cookie', opsExec.cookie).expect(200)).body.data.customers[0].matchedBy).toBe('name');
    await processIt(opsExec, b.id, { ...SALE, customerCode: 'CUST_SUNRISE_02' }).expect(200);
    const book = await rows<{ used_count: number; customer_code: string }>('SELECT used_count, customer_code FROM bulk_customers');
    expect(book).toEqual([{ used_count: 2, customer_code: 'CUST_SUNRISE_02' }]);
  });

  it('Marketing (2026-11-13): processed the same way (channel + customer code typed, e.g. Jiva), CSV at ₹1 a unit, no customer book row', async () => {
    const m = (await create(mkt, order()).expect(201)).body.data as { id: string; poNumber: string };
    await approve(m.id);
    expect((await api().get(`${T}/${m.id}/process-options`).set('Cookie', opsExec.cookie).expect(200)).body.data.customers).toEqual([]);
    const JIVA = { facilityCode: WH, uniwareChannel: 'JIVA', customerCode: 'CUST_JIVA_01' };
    const done = (await processIt(opsExec, m.id, JIVA).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'processing', payment: null, totalValue: 13, saleOrder: { ...JIVA } });
    const code = done.saleOrder.code as string;
    const [po] = await rows<{ uid: string; channel: string; customerCode: string }>('SELECT uid, channel, customerCode FROM master_purchase_orders');
    expect(po).toMatchObject({ channel: 'Bulk Marketing', customerCode: 'CUST_JIVA_01' });
    const lines = await rows<{ skuCode: string; qty: number; poValue: string }>('SELECT skuCode, qty, poValue FROM details_purchase_orders WHERE shipmentOrderId = ? ORDER BY id', [po.uid]);
    expect(lines.map((l) => [l.skuCode, l.qty, Number(l.poValue)])).toEqual([['SKU_A', 10, 10], ['SKU_B', 3, 3]]);
    const csv = [...s3Objects(`bulk-orders/${m.poNumber}/sale-order-1/`).entries()].find(([k]) => k.endsWith('.csv'))![1];
    expect(csv).toContain(`${code},${m.poNumber},0,JIVA,SKU_A,STD,SKU_A,SKU_A,1.00,FALSE,10,CUST_JIVA_01,${WH},`);
    expect(csv).toContain(',1.00,FALSE,3,');
    expect(await count('bulk_customers')).toBe(0);
  });

  it('a Marketing order approved with discounts before the ₹1 rule is punched at ₹1 (lines set, on the timeline)', async () => {
    const m = (await create(mkt, order()).expect(201)).body.data as { id: string; poNumber: string };
    await approve(m.id);
    await rows('UPDATE bulk_order_lines SET discount_pct = 30, unit_price = 70, line_total = 700 WHERE order_id = ? AND line_no = 1', [m.id]);
    const done = (await processIt(opsExec, m.id).expect(200)).body.data;
    expect(done.totalValue).toBe(13);
    expect(done.lines[0]).toMatchObject({ discountPct: 0, unitPrice: 1, lineTotal: 10 });
    expect(done.events.at(-1).changes).toMatchObject({ repricedLines: [1], unitPrice: 1 });
    const csv = [...s3Objects(`bulk-orders/${m.poNumber}/sale-order-1/`).entries()].find(([k]) => k.endsWith('.csv'))![1];
    expect(csv).not.toContain('70.00');
  });

  it('send back (optional, Verify panel) cancels that sale order and puts the order back to approved; it is processed again, never reopened', async () => {
    const i = await approvedInst();
    await processIt(opsExec, i.id).expect(200);
    const [up] = await rows<{ id: string }>('SELECT id FROM po_uploads');
    await api().post(`/api/v1/po-verify/${up.id}/send-back`).set('Cookie', opsExec.cookie).send({ remark: 'wrong warehouse' }).expect(200);
    const back = (await api().get(`${T}/${i.id}`).set('Cookie', opsExec.cookie).expect(200)).body.data;
    expect(back).toMatchObject({ status: 'approved', saleOrder: null });
    expect(back.events.at(-1)).toMatchObject({ action: 'sent_back', note: 'wrong warehouse' });
    expect((await rows<{ statusActive: string }>('SELECT statusActive FROM master_purchase_orders'))[0].statusActive).toBe('Inactive');
    expect((await rows<{ status: string }>('SELECT status FROM po_uploads'))[0].status).toBe('rejected');
    expect((await api().post(`/api/v1/po-review/${up.id}/reopen`).set('Cookie', opsExec.cookie).send({ remark: 'x' }).expect(409)).body.error.code).toBe('BULK_UPLOAD_NOT_REOPENABLE');

    const again = (await processIt(opsExec, i.id).expect(200)).body.data;
    expect(again.status).toBe('processing');
    expect((await rows<{ external_id: string }>('SELECT external_id FROM po_uploads ORDER BY id')).map((r) => r.external_id)).toEqual([i.poNumber, `${i.poNumber}-2`]);
    expect([...s3Objects(`bulk-orders/${i.poNumber}/sale-order-2/`).keys()].some((k) => k.endsWith('order.json'))).toBe(true);
  });
});
