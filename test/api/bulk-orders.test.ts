import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Bulk Orders portal step 1 (2026-11-11): access by the 3 bulk roles (each only its own type, nothing of POST_FG),
 * SKU search with MRP, price = MRP less discount % from OUR master (never the request's), unique PO numbers per type
 * and year (also under parallel creates), saved locations per type, validation, and nothing of the PO chain touched.
 */
covers(['GET /bulk-orders', 'POST /bulk-orders', 'GET /bulk-orders/skus', 'GET /bulk-orders/locations', 'POST /bulk-orders/locations', 'GET /bulk-orders/:id']);

const V = '/api/v1/bulk-orders';
const YEAR = new Date(Date.now() + 5.5 * 3600_000).getUTCFullYear();
const TOMORROW = new Date(Date.now() + 5.5 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
const ADDRESS = { line: '12, MG Road, Andheri East', city: 'Mumbai', state: 'Maharashtra', pincode: '400069' };

let mkt: TestLogin;
let inst: TestLogin;
let approver: TestLogin;
let opsExec: TestLogin;
let skuA: number;

const order = (over: Record<string, unknown> = {}) => ({
  type: 'marketing', orderedBy: 'Brand team', receiverName: 'Ravi Kumar', receiverPhone: '+91 98765-43210',
  address: ADDRESS, neededBy: TOMORROW, mode: 'Courier', priority: 'Standard',
  lines: [{ pepCode: 'SKU_A', qty: 10, discountPct: 30 }, { pepCode: 'SKU_B', qty: 3, discountPct: 12.5 }],
  ...over,
});
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
    const o = (await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 1, discountPct: 0 }] })).expect(201)).body.data;
    expect(o.lines[0]).toMatchObject({ mrp: 120, unitPrice: 120 });
    // a Masters page save drops the cached list at once
    const admin = await loginAs('admin');
    await api().patch(`/api/v1/masters/edit/pep_sku/${skuA}`).set('Cookie', admin.cookie).send({ changes: { mrp: 150 } }).expect(200);
    expect(await mrpOf()).toBe(150);
  });
});

describe('bulk orders: create', () => {
  it('price = MRP from our master less the discount; totals; requested values kept; pending approval; phone cleaned', async () => {
    const res = await create(mkt, order({ lines: [{ pepCode: 'sku_a', qty: 10, discountPct: 30, mrp: 1, unitPrice: 1 }, { pepCode: 'SKU_B', qty: 3, discountPct: 12.5 }] })).expect(201);
    const o = res.body.data;
    expect(o).toMatchObject({
      poNumber: `MKT-${YEAR}-0001`, type: 'marketing', status: 'pending_approval', receiverPhone: '9876543210', mode: 'Courier',
      lineCount: 2, totalUnits: 13, totalMrp: 2047, totalValue: 1616.14, neededBy: TOMORROW,
      location: { id: null, label: null, address: ADDRESS }, createdBy: { id: mkt.userId },
    });
    expect(o.lines).toEqual([
      { lineNo: 1, pepCode: 'SKU_A', name: 'Coffee Body Scrub 100g', mrp: 100, qty: 10, discountPct: 30, unitPrice: 70, lineTotal: 700, requestedQty: 10, requestedDiscountPct: 30 },
      { lineNo: 2, pepCode: 'SKU_B', name: 'Coffee Face Wash 100ml', mrp: 349, qty: 3, discountPct: 12.5, unitPrice: 305.38, lineTotal: 916.14, requestedQty: 3, requestedDiscountPct: 12.5 },
    ]);
    expect((await api().get(`${V}/${o.id}`).set('Cookie', mkt.cookie).expect(200)).body.data).toEqual(o);
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
