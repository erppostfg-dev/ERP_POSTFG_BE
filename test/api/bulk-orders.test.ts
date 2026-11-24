import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkCustomerAddresses1795300000000 } from '../../src/migrations/1795300000000-BulkCustomerAddresses';
import { BulkOrderFields1795800000000 } from '../../src/migrations/1795800000000-BulkOrderFields';
import { loadBulkSkus } from '../../src/modules/bulk-orders/bulk-skus-load';
import { BulkOrderBrand1795900000000 } from '../../src/migrations/1795900000000-BulkOrderBrand';
import { BulkOrderReceivers1796200000000 } from '../../src/migrations/1796200000000-BulkOrderReceivers';
import { BulkInstitutionCustomers1796300000000 } from '../../src/migrations/1796300000000-BulkInstitutionCustomers';
import { BulkFinance1796400000000 } from '../../src/migrations/1796400000000-BulkFinance';
import { BulkPaymentDetails1796500000000 } from '../../src/migrations/1796500000000-BulkPaymentDetails';
import { BulkBuyerOrgs1796600000000 } from '../../src/migrations/1796600000000-BulkBuyerOrgs';
import { MARKETING_UNIT_PRICE } from '../../src/constants';
import { runPoSyncPass } from '../../src/modules/po-uniware-sync/sync.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { covers } from '../helpers/routes';

/*
 * Bulk Orders portal step 1 (2026-11-11): access by the 3 bulk roles (each only its own type, nothing of POST_FG),
 * SKU search with MRP, price = MRP less discount % from OUR master (never the request's), unique PO numbers per type
 * and year (also under parallel creates), saved locations per type, validation, and nothing of the PO chain touched.
 */
covers(['GET /bulk-orders/settings/orgs', 'POST /bulk-orders/settings/orgs', 'PUT /bulk-orders/settings/orgs/:orgId']);
covers(['POST /bulk-orders/receivers/check', 'POST /bulk-orders/duplicate-check', 'GET /bulk-orders/:id/stock', 'GET /po-review/bulk-orders/:id/stock']);
covers(['GET /bulk-orders/customers', 'POST /bulk-orders/customers', 'PUT /bulk-orders/customers/:customerId',
  'POST /bulk-orders/customers/:customerId/addresses', 'PUT /bulk-orders/customers/:customerId/addresses/:addressId', 'POST /bulk-orders/customers/:customerId/gstin']);
covers(['GET /bulk-orders/settings/notifications', 'PUT /bulk-orders/settings/notifications', 'POST /bulk-orders/:id/remind']);
covers(['GET /bulk-orders', 'POST /bulk-orders', 'GET /bulk-orders/skus', 'GET /bulk-orders/locations', 'POST /bulk-orders/locations', 'GET /bulk-orders/:id',
  'PUT /bulk-orders/:id', 'POST /bulk-orders/:id/cancel', 'POST /bulk-orders/:id/approve', 'POST /bulk-orders/:id/reject',
  'GET /po-review/bulk-orders', 'GET /po-review/bulk-orders/:id',
  'POST /bulk-orders/:id/documents', 'GET /bulk-orders/:id/documents/:docId', 'POST /bulk-orders/:id/payment', 'GET /bulk-orders/settings',
  'PUT /bulk-orders/settings/:type', 'POST /po-review/bulk-orders/:id/documents', 'GET /po-review/bulk-orders/:id/documents/:docId',
  'GET /po-review/bulk-orders/:id/process-options', 'POST /po-review/bulk-orders/:id/process', 'POST /po-review/bulk-orders/:id/payment',
  'POST /po-review/bulk-orders/customers/:customerId/hide']);

// v2 piece 3: the mail sender is a recorder (bulk notifications)
const mailbox = vi.hoisted(() => ({ sent: [] as { to: string[]; subject: string; text: string }[] }));
// 2026-11-24: the in-transit Daily Snapshot (stock on the approval screen) faked: its sheet text + whether a report exists
const snap = vi.hoisted(() => ({ csv: '', shown: true }));
vi.mock('../../src/modules/intransit/snapshot.service', async () => {
  const { Readable } = await import('stream');
  return {
    getSnapshot: async () => ({
      requested: '', latestMissing: false, shown: snap.shown ? { day: '2026-11-24', runId: '1', builtAt: '' } : null,
      files: snap.shown ? [{ name: 'Sheet35(2)', key: 'k', etag: `e${snap.csv.length}`, size: snap.csv.length }] : [],
    }),
    snapshotFile: async () => ({ body: Readable.from([Buffer.from(snap.csv)]), etag: 'e' }),
  };
});
vi.mock('../../src/modules/mail/mailer.service', async (orig) => ({
  ...(await orig<object>()),
  sendMail: vi.fn(async (m: { to: string[]; subject: string; text: string }) => { mailbox.sent.push(m); }),
}));
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
/** Default lines: Institutional with discounts (MRP less discount %); Marketing without (every unit at MARKETING_UNIT_PRICE, no discount). */
const order = (over: Record<string, unknown> = {}) => {
  const discounted = over.type === 'institutional';
  const o: Record<string, unknown> = {
    type: 'marketing', brand: 'mCaffeine', orderedBy: 'Brand team', receiverName: 'Ravi Kumar', receiverPhone: '+91 98765-43210',
    address: ADDRESS, neededBy: TOMORROW, mode: 'Regular', priority: 'Normal',
    lines: discounted ? [{ pepCode: 'SKU_A', qty: 10, discountPct: 30 }, { pepCode: 'SKU_B', qty: 3, discountPct: 12.5 }] : [{ pepCode: 'SKU_A', qty: 10 }, { pepCode: 'SKU_B', qty: 3 }],
    ...over,
  };
  return o.type === 'institutional' ? { ...INSTITUTION, ...o } : o;
};
const create = (who: TestLogin, body: Record<string, unknown>) => api().post(V).set('Cookie', who.cookie).send(body);
/** An edit (v2 1e: every edit carries a remark). */
const edit = (who: TestLogin, id: string, body: Record<string, unknown>, remark = 'Test edit') => api().put(`${V}/${id}`).set('Cookie', who.cookie).send({ remark, ...body });
const fields = (res: { body: { error: { details: { field: string }[] } } }) => res.body.error.details.map((d) => d.field);
/** An order as our team (POST_FG) sees it: with amounts also on Marketing / Head office (the portal hides them, 2026-11-24). */
const asTeam = async (id: string) => (await api().get(`/api/v1/po-review/bulk-orders/${id}`).set('Cookie', opsExec.cookie).expect(200)).body.data;

beforeEach(async () => {
  await resetDb();
  const now = new Date();
  skuA = await insert('master_skus', { pep_code: 'SKU_A', brand_name: 'mCaffeine', product_name: 'Coffee Body Scrub 100g', mrp: 100, ean_code: '8900000000011', is_active: 1, bulk_orderable: 1, created_at: now, updated_at: now });
  await insert('master_skus', { pep_code: 'SKU_B', brand_name: 'mCaffeine', product_name: 'Coffee Face Wash 100ml', mrp: 349, ean_code: '8900000000028', is_active: 1, bulk_orderable: 1, created_at: now, updated_at: now });
  await insert('master_skus', { pep_code: 'SKU_OFF', brand_name: 'mCaffeine', product_name: 'Coffee Old Pack', mrp: 199, is_active: 0, bulk_orderable: 1, created_at: now, updated_at: now });
  await insert('master_skus', { pep_code: 'SKU_NOMRP', brand_name: 'mCaffeine', product_name: 'Coffee Tester', mrp: null, is_active: 1, bulk_orderable: 1, created_at: now, updated_at: now });
  mkt = await loginAs('bulk-marketing');
  inst = await loginAs('bulk-institutional');
  approver = await loginAs('bulk-approver');
  opsExec = await loginAs('operations-executive');
  // The tests written for v1 (every order waits for approval) keep that: threshold 0 for every type = any order needs
  // approval. The v2 rules with the shipped values (100 / Porter / Institutional never) are tested in their own block.
  await rows('UPDATE bulk_type_settings SET approval_over_units = 0');
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
    const q = async (text: string) => (await api().get(`${V}/skus`).query({ q: text, brand: 'mCaffeine' }).set('Cookie', mkt.cookie).expect(200)).body.data as { pepCode: string; mrp: number }[];
    expect((await q('SKU')).map((s) => s.pepCode)).toEqual(['SKU_A', 'SKU_B']);
    expect(await q('face wash')).toEqual([{ pepCode: 'SKU_B', name: 'Coffee Face Wash 100ml', mrp: 349, ean: '8900000000028', brand: 'mCaffeine' }]);
    expect((await q('8900000000011')).map((s) => s.pepCode)).toEqual(['SKU_A']);
    expect(await q('S')).toEqual([]);
    expect(await q('100%')).toEqual([]);
  });

  it('searches the shared cached SKU list: a Masters save shows at once; the order price is always read fresh', async () => {
    const mrpOf = async () => (await api().get(`${V}/skus?q=SKU_A&brand=mCaffeine`).set('Cookie', mkt.cookie).expect(200)).body.data[0].mrp as number;
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
      { lineNo: 1, receiverNo: 1, pepCode: 'SKU_A', name: 'Coffee Body Scrub 100g', mrp: 100, qty: 10, discountPct: 30, unitPrice: 70, lineTotal: 700, requestedQty: 10, requestedDiscountPct: 30 },
      { lineNo: 2, receiverNo: 1, pepCode: 'SKU_B', name: 'Coffee Face Wash 100ml', mrp: 349, qty: 3, discountPct: 12.5, unitPrice: 305.38, lineTotal: 916.14, requestedQty: 3, requestedDiscountPct: 12.5 },
    ]);
    expect((await api().get(`${V}/${o.id}`).set('Cookie', inst.cookie).expect(200)).body.data).toEqual(o);
  });

  it('Marketing: every unit at MARKETING_UNIT_PRICE (₹0.01, v2 2026-11-23; was ₹1) whatever the MRP, no discount (a discount sent = 400), MRP still kept', async () => {
    const o = (await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 10 }, { pepCode: 'SKU_B', qty: 3, discountPct: 0 }] })).expect(201)).body.data;
    expect(o).toMatchObject({ poNumber: `MKT-${YEAR}-0001`, type: 'marketing', lineCount: 2, totalUnits: 13, totalMrp: null, totalValue: null }); // portal: no amounts
    expect(await asTeam(o.id)).toMatchObject({ totalMrp: 2047, totalValue: 0.13 });
    expect((await asTeam(o.id)).lines.map((l: Record<string, unknown>) => [l.pepCode, l.mrp, l.discountPct, l.unitPrice, l.lineTotal])).toEqual([['SKU_A', 100, 0, 0.01, 0.1], ['SKU_B', 349, 0, 0.01, 0.03]]);
    const res = await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 1, discountPct: 30 }] })).expect(400);
    expect(fields(res)).toEqual(['lines[0].discountPct']);
    expect(res.body.error.details[0].message).toContain('take no discount');
    expect(res.body.error.details[0].message).not.toMatch(/marketing|head_office|₹/); // no type code or price shown (v2: free orders)
    const edited = (await edit(mkt, o.id, order({ lines: [{ pepCode: 'SKU_B', qty: 5 }] })).expect(200)).body.data;
    expect(edited).toMatchObject({ totalValue: null, totalMrp: null });
    expect(await asTeam(edited.id)).toMatchObject({ totalValue: 0.05, totalMrp: 1745 });
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
      'brand', 'mode', 'neededBy', 'orderedBy', 'receiverName', 'receiverPhone',
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

  it('Institutional: no delivery mode (ignored); Normal priority by default (v2 1d)', async () => {
    const o = (await create(inst, order({ type: 'institutional', mode: 'Porter', priority: undefined })).expect(201)).body.data;
    expect(o).toMatchObject({ mode: null, priority: 'Normal', poNumber: `INST-${YEAR}-0001` });
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
    expect([p.meta, p.data.length]).toEqual([expect.objectContaining({ total: 2, page: 2, pageSize: 1 }), 1]); // + approvalRules (v2 1c)
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
    const edited = (await edit(inst, o.id, order({ type: 'marketing', ...INSTITUTION, receiverName: 'Asha', lines: [{ pepCode: 'SKU_B', qty: 2, discountPct: 10 }] })).expect(200)).body.data;
    expect(edited).toMatchObject({ poNumber: o.poNumber, type: 'institutional', status: 'pending_approval', receiverName: 'Asha', lineCount: 1, totalValue: 628.2 });
    expect(edited.lines).toEqual([expect.objectContaining({ lineNo: 1, pepCode: 'SKU_B', qty: 2, discountPct: 10, unitPrice: 314.1, requestedQty: 2, requestedDiscountPct: 10 })]);
    expect(edited.events.map((e: { action: string }) => e.action)).toEqual(['created', 'edited']);
    expect(edited.events[1].changes.fields).toEqual(['receiverName']);
    await edit(approver, o.id, order({ type: 'institutional' })).expect(403);
    await edit(mkt, o.id, order({ type: 'institutional' })).expect(404);
  });

  it('cancel: by its type, reason optional; a cancelled order cannot be edited, approved or cancelled again', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    await post(approver, o.id, 'cancel').expect(403);
    const c = (await post(mkt, o.id, 'cancel', { reason: 'Event postponed' }).expect(200)).body.data;
    expect(c.status).toBe('cancelled');
    expect(c.events[1]).toMatchObject({ action: 'cancelled', note: 'Event postponed', by: { id: mkt.userId } });
    expect((await post(approver, o.id, 'approve').expect(409)).body.error.code).toBe('BULK_ORDER_NOT_PENDING');
    await post(mkt, o.id, 'cancel').expect(409);
    await edit(mkt, o.id, order()).expect(409);
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

  it('approve a Marketing order: qty may change, a discount is refused, every unit stays at ₹0.01', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    expect(fields(await post(approver, o.id, 'approve', { lines: [{ lineNo: 1, discountPct: 20 }] }).expect(400))).toEqual(['lines[0].discountPct']);
    const a = (await post(approver, o.id, 'approve', { lines: [{ lineNo: 1, qty: 4 }, { lineNo: 2, discountPct: 0 }] }).expect(200)).body.data;
    expect(a).toMatchObject({ status: 'approved', totalUnits: 7, totalValue: null });
    expect(await asTeam(o.id)).toMatchObject({ totalValue: 0.07 });
    expect((await asTeam(o.id)).lines.map((l: Record<string, unknown>) => [l.qty, l.unitPrice, l.lineTotal])).toEqual([[4, 0.01, 0.04], [3, 0.01, 0.03]]);
  });

  it('a Marketing order saved with discounts before the fixed-price rule: approval sets every unit to ₹0.01 (on the timeline)', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data;
    await rows('UPDATE bulk_order_lines SET discount_pct = 30, requested_discount_pct = 30, unit_price = 70, line_total = 700 WHERE order_id = ? AND line_no = 1', [o.id]);
    const a = (await post(approver, o.id, 'approve').expect(200)).body.data;
    expect((await asTeam(o.id)).lines[0]).toMatchObject({ discountPct: 0, unitPrice: 0.01, lineTotal: 0.1, requestedDiscountPct: 30 });
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
    expect(i.payment).toMatchObject({ status: 'unbilled', by: null, link: null });
    expect(m.payment).toBeNull();

    for (const who of [mkt, approver, opsExec]) expect((await api().get(`${V}/settings`).set('Cookie', who.cookie).expect(403)).body.error.code).toBe('BULK_NOT_SETTINGS_ADMIN');
    const admin = await loginAs('admin');
    expect((await api().get(`${V}/settings`).set('Cookie', admin.cookie).expect(200)).body.data.map((x: { type: string; paymentCheck: boolean }) => [x.type, x.paymentCheck]))
      .toEqual([['marketing', false], ['head_office', false], ['institutional', true]]); // head_office: v2 1a, no row = off
    await api().put(`${V}/settings/marketing`).set('Cookie', admin.cookie).send({ paymentCheck: 'yes' }).expect(400);
    await api().put(`${V}/settings/other`).set('Cookie', admin.cookie).send({ paymentCheck: true }).expect(400);
    await api().put(`${V}/settings/marketing`).set('Cookie', mkt.cookie).send({ paymentCheck: true }).expect(403);
    const after = (await api().put(`${V}/settings/marketing`).set('Cookie', admin.cookie).send({ paymentCheck: true }).expect(200)).body.data;
    expect(after[0]).toMatchObject({ type: 'marketing', paymentCheck: true, updatedBy: { id: admin.userId } });
    expect((await create(mkt, order()).expect(201)).body.data.payment.status).toBe('unbilled');
    expect((await api().get(`${V}/${m.id}`).set('Cookie', mkt.cookie).expect(200)).body.data.payment).toBeNull(); // older order unchanged
  });

  it('proof upload -> proof uploaded; admin verifies / refuses (reason); a new proof replaces the old one; never blocks approval', async () => {
    const admin = await loginAs('admin');
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await api().post(`${V}/${i.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200); // no proof needed to approve
    expect((await pay(admin, i.id, { action: 'verify' }).expect(409)).body.error.code).toBe('BULK_PAYMENT_NO_PROOF');

    const a = (await up(inst, i.id, 'payment_proof', PDF, 'utr-1.pdf').expect(201)).body.data;
    expect(a.payment.status).toBe('payment_submitted');
    expect(a.documents).toMatchObject([{ kind: 'payment_proof', fileName: 'utr-1.pdf', contentType: 'application/pdf', replacedAt: null }]);
    const file = await api().get(`${V}/${i.id}/documents/${a.documents[0].id}`).set('Cookie', approver.cookie).buffer(true)
      .parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); }).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    await pay(inst, i.id, { action: 'verify' }).expect(403); // only "verify payments" (admin / developer)
    expect((await pay(approver, i.id, { action: 'verify' }).expect(403)).body.error.code).toBe('BULK_NOT_PAYMENT_VERIFIER'); // 2026-11-13: not the approver
    expect(fields(await pay(admin, i.id, { action: 'refuse' }).expect(400))).toEqual(['note']);
    const refused = (await pay(admin, i.id, { action: 'refuse', note: 'Amount short by Rs 500' }).expect(200)).body.data;
    expect(refused.payment).toMatchObject({ status: 'unbilled', by: { id: admin.userId }, note: 'Amount short by Rs 500' }); // v2 5b: back to waiting (no invoice)

    const b = (await up(inst, i.id, 'payment_proof', PNG, 'utr-2.png').expect(201)).body.data;
    expect(b.payment.status).toBe('payment_submitted');
    expect(b.documents.map((d: { fileName: string; replacedAt: string | null }) => [d.fileName, d.replacedAt === null])).toEqual([['utr-2.png', true], ['utr-1.pdf', false]]);
    const ok = (await pay(admin, i.id, { action: 'verify', note: 'UTR matched' }).expect(200)).body.data;
    expect(ok.payment.status).toBe('paid');
    expect(ok.events.filter((e: { action: string }) => e.action === 'payment').map((e: { changes: { status: string[] } }) => e.changes.status))
      .toEqual([['unbilled', 'payment_submitted'], ['payment_submitted', 'unbilled'], ['unbilled', 'payment_submitted'], ['payment_submitted', 'paid']]);
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
    expect(d.payment.status).toBe('invoiced'); // v2 5b: an invoice = invoiced (not a proof)
    const viewer = await loginAs('viewer');
    await up(viewer, i.id, 'invoice', PDF, 'v.pdf', T).expect(403);
    await api().get(`${T}/${i.id}/documents/${d.documents[0].id}`).set('Cookie', viewer.cookie).expect(200);
    const list = (await api().get(`${T}?type=institutional`).set('Cookie', viewer.cookie).expect(200)).body.data;
    expect(list[0].payment.status).toBe('invoiced');
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

    const toVerify = (await api().get(`${T}?type=institutional&payment=payment_submitted`).set('Cookie', opsExec.cookie).expect(200)).body;
    expect(toVerify.data.map((o: { id: string }) => o.id)).toEqual([b.id, a.id]);
    expect(toVerify.meta.paymentsToVerify).toEqual({ marketing: 0, head_office: 0, institutional: 1 });
    expect(fields(await api().get(`${T}?payment=verified`).set('Cookie', opsExec.cookie).expect(400))).toEqual(['payment']); // old name

    // PO review editor without the permission: refused; portal-only people: no PO review page
    expect((await teamPay(opsExec, a.id, { action: 'verify' }).expect(403)).body.error.code).toBe('BULK_NOT_PAYMENT_VERIFIER');
    await teamPay(approver, a.id, { action: 'verify' }).expect(403);
    const admin = await loginAs('admin');
    const done = (await teamPay(admin, a.id, { action: 'verify', note: 'UTR 1234 matched' }).expect(200)).body.data;
    expect(done.payment).toMatchObject({ status: 'paid', by: { id: admin.userId }, note: 'UTR 1234 matched' });
    expect((await api().get(`${T}?payment=payment_submitted`).set('Cookie', opsExec.cookie).expect(200)).body.meta.paymentsToVerify.institutional).toBe(0);
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
    const main = await insert('master_facilities', { code: WH, name: 'Bhiwandi', entity: 'PEP', state: 'Maharashtra', is_active: 1, intransit_type: 'MWH', source: 'manual', uniware_export: 0 });
    await insert('master_facilities', { code: 'MUM_Warehouse2', name: 'Bhiwandi child', parent_facility_id: main, entity: 'PEP', state: 'Maharashtra', is_active: 1, intransit_type: 'MWH', source: 'manual', uniware_export: 0 });
    // not mother warehouses: never offered, refused (2026-11-24)
    await insert('master_facilities', { code: 'DS_NCR_TEST', name: 'Dark store', entity: 'PEP', state: 'Delhi', is_active: 1, intransit_type: 'DarkStore', source: 'manual', uniware_export: 0 });
    await insert('master_facilities', { code: 'HYP_AHMD', name: 'D2C', entity: 'PEP', state: 'Gujarat', is_active: 1, intransit_type: 'D2C', source: 'manual', uniware_export: 0 });
    await insert('master_facilities', { code: 'OLD_WH', name: 'Closed', entity: 'PEP', state: 'Maharashtra', is_active: 0, source: 'manual', uniware_export: 0 });
  });

  it('Institutional orders need the institution name + billing address (or same as delivery); GSTIN / email checked when given', async () => {
    const bare = { ...order({ type: 'institutional' }), institutionName: undefined, billingSameAsDelivery: undefined, gstin: 'NOT-A-GSTIN', contactEmail: 'nope' };
    expect(fields(await create(inst, bare).expect(400))).toEqual(expect.arrayContaining(['billingAddress', 'billingAddress.line', 'contactEmail', 'gstin', 'institutionName']));
    const same = (await create(inst, order({ type: 'institutional', gstin: '27aaacs1234a1z5' })).expect(201)).body.data;
    expect(same.institution).toEqual({ customerId: null, gstinVerified: null, name: 'Sunrise Public School', gstin: '27AAACS1234A1Z5', email: 'office@sunrise.example', billingAddress: ADDRESS });
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
    expect(opts).toEqual({ facilities: [{ code: WH, name: 'Bhiwandi', parentCode: null }], customers: [] }); // mother warehouses only: no child, dark store, D2C
    for (const not of ['MUM_Warehouse2', 'DS_NCR_TEST', 'HYP_AHMD']) expect(fields(await processIt(opsExec, i.id, { ...SALE, facilityCode: not }).expect(400))).toEqual(['facilityCode']);
    expect(await count('master_purchase_orders')).toBe(0);
  });

  it('process = a normal saved PO: erp_ sale order, PO rows, CSV at the approved price, Processed tab (no Verify), payment never blocks', async () => {
    const i = await approvedInst();
    const done = (await processIt(opsExec, i.id).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'processing', payment: { status: 'unbilled' }, saleOrder: { ...SALE, by: { id: opsExec.userId } } });
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

  const optsOf = async (id: string) => (await api().get(`${T}/${id}/process-options`).set('Cookie', opsExec.cookie).expect(200)).body.data as {
    customers: { id: string; matchedBy: string; customerCode: string; usedCount: number; deliveryAddress: unknown }[]
  };
  const OTHER = { line: 'Block C, 7 Lake View Road', city: 'Pune', state: 'Maharashtra', pincode: '411014' };

  it('customer book = address book: the same delivery address comes first (the panel fills it), then same GSTIN, then name + pincode', async () => {
    const a = await approvedInst();
    await processIt(opsExec, a.id).expect(200);
    // same address written differently (case, punctuation, spaces) = same address
    const b = await approvedInst({ receiverName: 'Asha', address: { ...ADDRESS, line: '12 mg road,  ANDHERI east.' } });
    expect((await optsOf(b.id)).customers).toEqual([expect.objectContaining({
      name: 'Sunrise Public School', uniwareChannel: 'INSTITUTIONAL_B2B', customerCode: 'CUST_SUNRISE_01', usedCount: 1, matchedBy: 'address',
      receiverName: 'Ravi Kumar', deliveryAddress: ADDRESS,
    })]);
    // same institution (GSTIN) at another address: suggested as "same GSTIN", not filled
    const c = await approvedInst({ address: OTHER });
    expect((await optsOf(c.id)).customers.map((x) => x.matchedBy)).toEqual(['gstin']);
    // no GSTIN, same name + pincode
    const d = await approvedInst({ gstin: '', institutionName: 'sunrise public school.', address: { ...ADDRESS, line: 'Gate 2, MG Road' } });
    expect((await optsOf(d.id)).customers.map((x) => x.matchedBy)).toEqual(['name']);
    // another type never gets them (other Uniware channel)
    const m = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await approve(m.id);
    expect((await optsOf(m.id)).customers).toEqual([]);
  });

  it('nothing is overwritten: same address + same code = one more use; a NEW code for the address = a new row, newest first', async () => {
    await processIt(opsExec, (await approvedInst()).id).expect(200);
    await processIt(opsExec, (await approvedInst({ receiverName: 'Asha' })).id).expect(200); // same address + code
    expect(await rows('SELECT used_count, customer_code FROM bulk_customers')).toEqual([{ used_count: 2, customer_code: 'CUST_SUNRISE_01' }]);
    await processIt(opsExec, (await approvedInst()).id, { ...SALE, customerCode: 'CUST_SUNRISE_02' }).expect(200);
    expect(await rows('SELECT used_count, customer_code FROM bulk_customers ORDER BY id')).toEqual([
      { used_count: 2, customer_code: 'CUST_SUNRISE_01' }, { used_count: 1, customer_code: 'CUST_SUNRISE_02' }]);
    const next = await approvedInst();
    expect((await optsOf(next.id)).customers.map((x) => [x.customerCode, x.matchedBy])).toEqual([['CUST_SUNRISE_02', 'address'], ['CUST_SUNRISE_01', 'address']]);
    const [ord] = await rows<{ customer_id: string }>('SELECT customer_id FROM bulk_orders WHERE customer_code = ? ORDER BY id DESC LIMIT 1', ['CUST_SUNRISE_02']);
    const [row] = await rows<{ id: string }>('SELECT id FROM bulk_customers WHERE customer_code = ?', ['CUST_SUNRISE_02']);
    expect(String(ord.customer_id)).toBe(String(row.id));
  });

  it("Don't suggest again: editors only, hidden (never deleted), shown again when that code is typed for the address again", async () => {
    await processIt(opsExec, (await approvedInst()).id).expect(200);
    const next = await approvedInst();
    const [saved] = (await optsOf(next.id)).customers;
    const hide = (who: TestLogin, id: string) => api().post(`${T}/customers/${id}/hide`).set('Cookie', who.cookie).send({});
    await hide(await loginAs('viewer'), saved.id).expect(403);
    await hide(inst, saved.id).expect(403);
    expect((await hide(opsExec, '999999').expect(404)).body.error.code).toBe('BULK_CUSTOMER_NOT_FOUND');
    expect((await hide(opsExec, saved.id).expect(200)).body.data).toEqual({ id: saved.id, hidden: true });
    await hide(opsExec, saved.id).expect(200); // twice = fine
    expect((await optsOf(next.id)).customers).toEqual([]);
    const [h] = await rows<{ hidden_by: number }>('SELECT hidden_by FROM bulk_customers');
    expect(h.hidden_by).toBe(opsExec.userId);
    await processIt(opsExec, next.id).expect(200); // typed again for this address
    expect(await rows('SELECT used_count, hidden_at FROM bulk_customers')).toEqual([{ used_count: 2, hidden_at: null }]);
  });

  it('migration BulkCustomerAddresses fills the book from the orders processed before it (Marketing too, one row per address + code)', async () => {
    await processIt(opsExec, (await approvedInst()).id).expect(200);
    await processIt(opsExec, (await approvedInst({ address: OTHER })).id, { ...SALE, customerCode: 'CUST_SUNRISE_PUNE' }).expect(200);
    const m = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await approve(m.id);
    await processIt(opsExec, m.id, { facilityCode: WH, uniwareChannel: 'JIVA', customerCode: 'CUST_JIVA_01' }).expect(200);
    // as on dev before this change: one Institutional row (the first order's customer), no Marketing row
    const [first] = await rows<{ id: string }>('SELECT id FROM bulk_customers ORDER BY id LIMIT 1');
    await rows('DELETE FROM bulk_customers WHERE id <> ?', [first.id]);
    await rows("UPDATE bulk_orders SET customer_id = NULL WHERE order_type = 'marketing'");
    const qr = (await db()).createQueryRunner();
    try {
      const mig = new BulkCustomerAddresses1795300000000();
      await mig.down(qr);
      await mig.up(qr);
    } finally {
      await qr.release();
    }
    const book = await rows<{ order_type: string; customer_code: string; ship_pincode: string; address_key: string | null }>(
      'SELECT order_type, customer_code, ship_pincode, address_key FROM bulk_customers ORDER BY id');
    expect(book.map((b) => [b.order_type, b.customer_code, b.ship_pincode])).toEqual([
      ['institutional', 'CUST_SUNRISE_01', ADDRESS.pincode], ['institutional', 'CUST_SUNRISE_PUNE', OTHER.pincode], ['marketing', 'CUST_JIVA_01', ADDRESS.pincode]]);
    // the migration's key = the app's key: the next Marketing order at that address gets JIVA filled
    const m2 = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await approve(m2.id);
    expect((await optsOf(m2.id)).customers.map((x) => [x.customerCode, x.matchedBy])).toEqual([['CUST_JIVA_01', 'address']]);
  });

  it('Marketing (2026-11-13): processed the same way (channel + customer code typed, e.g. Jiva), CSV at ₹0.01 a unit, address saved in the book', async () => {
    const m = (await create(mkt, order()).expect(201)).body.data as { id: string; poNumber: string };
    await approve(m.id);
    expect((await api().get(`${T}/${m.id}/process-options`).set('Cookie', opsExec.cookie).expect(200)).body.data.customers).toEqual([]);
    const JIVA = { facilityCode: WH, uniwareChannel: 'JIVA', customerCode: 'CUST_JIVA_01' };
    const done = (await processIt(opsExec, m.id, JIVA).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'processing', payment: null, totalValue: 0.13, saleOrder: { ...JIVA } });
    const code = done.saleOrder.code as string;
    const [po] = await rows<{ uid: string; channel: string; customerCode: string }>('SELECT uid, channel, customerCode FROM master_purchase_orders');
    expect(po).toMatchObject({ channel: 'Bulk Marketing', customerCode: 'CUST_JIVA_01' });
    const lines = await rows<{ skuCode: string; qty: number; poValue: string }>('SELECT skuCode, qty, poValue FROM details_purchase_orders WHERE shipmentOrderId = ? ORDER BY id', [po.uid]);
    expect(lines.map((l) => [l.skuCode, l.qty, Number(l.poValue)])).toEqual([['SKU_A', 10, 0.1], ['SKU_B', 3, 0.03]]);
    const csv = [...s3Objects(`bulk-orders/${m.poNumber}/sale-order-1/`).entries()].find(([k]) => k.endsWith('.csv'))![1];
    expect(csv).toContain(`${code},${m.poNumber},0,JIVA,SKU_A,STD,SKU_A,SKU_A,0.01,FALSE,10,CUST_JIVA_01,${WH},`);
    expect(csv).toContain(',0.01,FALSE,3,');
    expect(await rows('SELECT order_type, name, gstin, uniware_channel, customer_code, used_count FROM bulk_customers')).toEqual([
      { order_type: 'marketing', name: 'Ravi Kumar', gstin: null, uniware_channel: 'JIVA', customer_code: 'CUST_JIVA_01', used_count: 1 }]);
    const m2 = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await approve(m2.id);
    expect((await optsOf(m2.id)).customers).toEqual([expect.objectContaining({ uniwareChannel: 'JIVA', customerCode: 'CUST_JIVA_01', matchedBy: 'address' })]);
  });

  it('a Marketing order approved with discounts before the fixed-price rule is punched at ₹0.01 (lines set, on the timeline)', async () => {
    const m = (await create(mkt, order()).expect(201)).body.data as { id: string; poNumber: string };
    await approve(m.id);
    await rows('UPDATE bulk_order_lines SET discount_pct = 30, unit_price = 70, line_total = 700 WHERE order_id = ? AND line_no = 1', [m.id]);
    const done = (await processIt(opsExec, m.id).expect(200)).body.data;
    expect(done.totalValue).toBe(0.13);
    expect(done.lines[0]).toMatchObject({ discountPct: 0, unitPrice: 0.01, lineTotal: 0.1 });
    expect(done.events.at(-1).changes).toMatchObject({ repricedLines: [1], unitPrice: 0.01 });
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

/*
 * Bulk Orders Portal v2, piece 1a (2026-11-23, user: "if it works like marketing then build like marketing"): Head office
 * orders = the Marketing people (Marketing page / role), the same approvers, HO-<year>-NNNN, ₹1 a unit with no discount,
 * no institution details / payment check, the saved PO in channel Bulk Marketing (group Marketing).
 */
describe('bulk orders v2: Head office works like Marketing', () => {
  const T = '/api/v1/po-review/bulk-orders';
  const WH = 'MUM_WAREHOUSE2';
  const HO = { type: 'head_office' };

  it('Marketing people create it (HO- series of its own), ₹0.01 a unit, a discount refused, delivery mode kept; Institutional people cannot', async () => {
    const o = (await create(mkt, order(HO)).expect(201)).body.data;
    expect(o).toMatchObject({ poNumber: `HO-${YEAR}-0001`, type: 'head_office', mode: 'Regular', totalUnits: 13, totalValue: null, payment: null });
    expect(await asTeam(o.id)).toMatchObject({ totalValue: 0.13 });
    expect((await asTeam(o.id)).lines.map((l: Record<string, unknown>) => [l.pepCode, l.discountPct, l.unitPrice])).toEqual([['SKU_A', 0, 0.01], ['SKU_B', 0, 0.01]]);
    const m = (await create(mkt, order()).expect(201)).body.data;
    expect(m.poNumber).toBe(`MKT-${YEAR}-0001`); // Marketing's own series is untouched
    expect((await create(mkt, order({ ...HO, poNumber: undefined })).expect(201)).body.data.poNumber).toBe(`HO-${YEAR}-0002`);
    expect(fields(await create(mkt, order({ ...HO, lines: [{ pepCode: 'SKU_A', qty: 1, discountPct: 10 }] })).expect(400))).toEqual(['lines[0].discountPct']);
    expect((await create(inst, order(HO)).expect(403)).body.error.code).toBe('BULK_TYPE_NOT_ALLOWED');
    await create(approver, order(HO)).expect(403);
  });

  it('seen by Marketing people and approvers (not Institutional); approved like Marketing', async () => {
    const o = (await create(mkt, order(HO)).expect(201)).body.data as { id: string };
    expect((await api().get(`${V}?type=head_office`).set('Cookie', mkt.cookie).expect(200)).body.meta.total).toBe(1);
    await api().get(`${V}/${o.id}`).set('Cookie', inst.cookie).expect(404);
    await api().get(`${V}?type=head_office`).set('Cookie', inst.cookie).expect(403);
    const done = (await api().post(`${V}/${o.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'approved', totalValue: null });
    expect(await asTeam(o.id)).toMatchObject({ totalValue: 0.13 });
  });

  it('our team processes it like Marketing: saved PO in Bulk Marketing (group Marketing), CSV at ₹0.01, its own address book', async () => {
    await insert('master_facilities', { code: WH, name: 'Bhiwandi', entity: 'PEP', state: 'Maharashtra', is_active: 1, intransit_type: 'MWH', source: 'manual', uniware_export: 0 });
    const o = (await create(mkt, order(HO)).expect(201)).body.data as { id: string; poNumber: string };
    await api().post(`${V}/${o.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200);
    const SALE = { facilityCode: WH, uniwareChannel: 'JIVA', customerCode: 'CUST_HO_01' };
    const done = (await api().post(`${T}/${o.id}/process`).set('Cookie', opsExec.cookie).send(SALE).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'processing', totalValue: 0.13, saleOrder: SALE });
    const [po] = await rows<{ channel: string; poGroup: string; poNumber: string }>('SELECT channel, poGroup, poNumber FROM master_purchase_orders');
    expect(po).toEqual({ channel: 'Bulk Marketing', poGroup: 'Marketing', poNumber: o.poNumber });
    const csv = [...s3Objects(`bulk-orders/${o.poNumber}/sale-order-1/`).entries()].find(([k]) => k.endsWith('.csv'))![1];
    expect(csv).toContain(',0.01,FALSE,10,CUST_HO_01,');
    expect(await rows('SELECT order_type, customer_code FROM bulk_customers')).toEqual([{ order_type: 'head_office', customer_code: 'CUST_HO_01' }]);
  });

  it('settings list Head office (payment check off; no row needed)', async () => {
    const admin = await loginAs('admin');
    const list = (await api().get(`${V}/settings`).set('Cookie', admin.cookie).expect(200)).body.data as { type: string; paymentCheck: boolean }[];
    expect(list.find((s) => s.type === 'head_office')).toMatchObject({ paymentCheck: false });
  });
});

/*
 * Bulk Orders Portal v2, piece 1b (2026-11-23): Marketing / Head office every unit at MARKETING_UNIT_PRICE (₹0.01, a
 * constant until Uniware confirms it), Institutional: no 100% discount, every line at least ₹1 (create, edit, approve).
 */
describe('bulk orders v2: pricing rules', () => {
  const act = (who: TestLogin, id: string, what: string, body: Record<string, unknown> = {}) => api().post(`${V}/${id}/${what}`).set('Cookie', who.cookie).send(body);
  const inst1 = (lines: Record<string, unknown>[]) => order({ type: 'institutional', lines });

  it('Marketing / Head office use the one constant MARKETING_UNIT_PRICE', async () => {
    for (const type of ['marketing', 'head_office']) {
      const o = (await create(mkt, order({ type })).expect(201)).body.data;
      expect((await asTeam(o.id)).lines.map((l: { unitPrice: number }) => l.unitPrice)).toEqual([MARKETING_UNIT_PRICE, MARKETING_UNIT_PRICE]);
    }
  });

  it('Institutional: 100% discount refused; a line under ₹1 refused (named), at exactly ₹1 accepted; edit checked the same', async () => {
    let res = await create(inst, inst1([{ pepCode: 'SKU_A', qty: 5, discountPct: 100 }])).expect(400);
    expect(fields(res)).toEqual(['lines[0].discountPct']);
    expect(res.body.error.details[0].message).toContain('100% is not allowed');
    // MRP 100 at 99.5% = ₹0.50 a unit: 1 unit = ₹0.50 (refused), 2 units = ₹1.00 (ok)
    res = await create(inst, inst1([{ pepCode: 'SKU_B', qty: 1 }, { pepCode: 'SKU_A', qty: 1, discountPct: 99.5 }])).expect(400);
    expect(fields(res)).toEqual(['lines[1].discountPct']);
    expect(res.body.error.details[0].message).toContain('at least ₹1');
    const ok = (await create(inst, inst1([{ pepCode: 'SKU_A', qty: 2, discountPct: 99.5 }])).expect(201)).body.data;
    expect(ok.lines[0]).toMatchObject({ unitPrice: 0.5, lineTotal: 1 });
    res = await edit(inst, ok.id, inst1([{ pepCode: 'SKU_A', qty: 1, discountPct: 99.5 }])).expect(400);
    expect(fields(res)).toEqual(['lines[0].discountPct']);
  });

  it('approve: 100% refused, a line pushed under ₹1 refused, nothing changed', async () => {
    const o = (await create(inst, inst1([{ pepCode: 'SKU_A', qty: 1, discountPct: 10 }])).expect(201)).body.data;
    expect(fields(await act(approver, o.id, 'approve', { lines: [{ lineNo: 1, discountPct: 100 }] }).expect(400))).toEqual(['lines[0].discountPct']);
    const res = await act(approver, o.id, 'approve', { lines: [{ lineNo: 1, discountPct: 99.5 }] }).expect(400);
    expect(res.body.error.details[0]).toMatchObject({ field: 'line 1' });
    expect(res.body.error.details[0].message).toContain('at least ₹1');
    const now = (await api().get(`${V}/${o.id}`).set('Cookie', inst.cookie).expect(200)).body.data;
    expect(now).toMatchObject({ status: 'pending_approval', totalValue: 90 });
  });
});

/*
 * Bulk Orders Portal v2, piece 1c (2026-11-23): approval only when the total units are MORE than the type's threshold
 * (Marketing / Head office 100 as shipped by the migration, Institutional never) or the delivery is Porter; otherwise
 * 'submitted' = straight to our team. Edits apply the rules again; the admin changes the threshold in Settings.
 */
describe('bulk orders v2: approval rules', () => {
  const T = '/api/v1/po-review/bulk-orders';
  const WH = 'MUM_WAREHOUSE2';
  const units = (n: number, over: Record<string, unknown> = {}) => order({ lines: [{ pepCode: 'SKU_A', qty: n }], ...over });
  beforeEach(async () => {
    // the values the migration ships (this file's first beforeEach set every type to 0 for the v1 tests)
    await rows("UPDATE bulk_type_settings SET approval_over_units = CASE order_type WHEN 'institutional' THEN NULL ELSE 100 END");
  });

  it('create: 100 units -> submitted, 101 -> pending (why on the timeline), Porter -> pending at any size; Head office the same; Institutional never', async () => {
    const at100 = (await create(mkt, units(100)).expect(201)).body.data;
    expect(at100.status).toBe('submitted');
    expect(at100.events[0]).toMatchObject({ action: 'created', changes: { approval: [] } });
    const at101 = (await create(mkt, units(101)).expect(201)).body.data;
    expect(at101.status).toBe('pending_approval');
    expect(at101.events[0].changes.approval).toEqual(['101 units (over 100)']);
    const porter = (await create(mkt, units(5, { mode: 'Porter' })).expect(201)).body.data;
    expect(porter.status).toBe('pending_approval');
    expect(porter.events[0].changes.approval).toEqual(['Porter delivery']);
    expect((await create(mkt, units(150, { type: 'head_office', mode: 'Porter' })).expect(201)).body.data.events[0].changes.approval)
      .toEqual(['150 units (over 100)', 'Porter delivery']);
    expect((await create(mkt, units(40, { type: 'head_office' })).expect(201)).body.data.status).toBe('submitted');
    const big = (await create(inst, order({ type: 'institutional', lines: [{ pepCode: 'SKU_A', qty: 500, discountPct: 10 }] })).expect(201)).body.data;
    expect(big.status).toBe('submitted');
    // a submitted order is not the approver's: approve refused
    expect((await api().post(`${V}/${at100.id}/approve`).set('Cookie', approver.cookie).send({}).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_PENDING');
  });

  it('edits apply the rules again (both ways, on the timeline); a submitted order can be cancelled', async () => {
    const o = (await create(mkt, units(50)).expect(201)).body.data as { id: string };
    let e = (await edit(mkt, o.id, units(150)).expect(200)).body.data;
    expect(e.status).toBe('pending_approval');
    expect(e.events.at(-1).changes).toMatchObject({ status: ['submitted', 'pending_approval'], approval: ['150 units (over 100)'] });
    e = (await edit(mkt, o.id, units(20)).expect(200)).body.data;
    expect(e.status).toBe('submitted');
    expect(e.events.at(-1).changes).toMatchObject({ status: ['pending_approval', 'submitted'], approval: [] });
    e = (await edit(mkt, o.id, units(30)).expect(200)).body.data;
    expect(e.events.at(-1).changes.status).toBeUndefined(); // status unchanged: no status entry
    expect((await api().post(`${V}/${o.id}/cancel`).set('Cookie', mkt.cookie).send({}).expect(200)).body.data.status).toBe('cancelled');
    expect((await edit(mkt, o.id, units(30)).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_EDITABLE');
  });

  it('our team: a submitted order counts as waiting and is processed like an approved one; then no more edits; send back -> submitted again', async () => {
    await insert('master_facilities', { code: WH, name: 'Bhiwandi', entity: 'PEP', state: 'Maharashtra', is_active: 1, intransit_type: 'MWH', source: 'manual', uniware_export: 0 });
    const o = (await create(mkt, units(10)).expect(201)).body.data as { id: string };
    expect((await api().get(T).set('Cookie', opsExec.cookie).expect(200)).body.meta.waiting.marketing).toBe(1);
    expect((await api().get(`${T}?status=ready`).set('Cookie', opsExec.cookie).expect(200)).body.meta.total).toBe(1); // approved + submitted
    await api().get(`${T}?status=nope`).set('Cookie', opsExec.cookie).expect(400);
    const done = (await api().post(`${T}/${o.id}/process`).set('Cookie', opsExec.cookie).send({ facilityCode: WH, uniwareChannel: 'JIVA', customerCode: 'C1' }).expect(200)).body.data;
    expect(done.status).toBe('processing');
    expect((await edit(mkt, o.id, units(5)).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_EDITABLE');
    const [up] = await rows<{ id: string }>('SELECT id FROM po_uploads');
    await api().post(`/api/v1/po-verify/${up.id}/send-back`).set('Cookie', opsExec.cookie).send({ remark: 'wrong warehouse' }).expect(200);
    expect((await api().get(`${V}/${o.id}`).set('Cookie', mkt.cookie).expect(200)).body.data.status).toBe('submitted');
  });

  it('settings: admin changes the threshold (applies to new orders), null = never; checked; only admin', async () => {
    const admin = await loginAs('admin');
    const S = `${V}/settings`;
    expect(((await api().get(S).set('Cookie', admin.cookie).expect(200)).body.data as { type: string; approvalOverUnits: number | null }[]).map((x) => [x.type, x.approvalOverUnits]))
      .toEqual([['marketing', 100], ['head_office', 100], ['institutional', null]]);
    for (const bad of [-1, 1.5, 'x', 2_000_000]) expect(fields(await api().put(`${S}/marketing`).set('Cookie', admin.cookie).send({ approvalOverUnits: bad }).expect(400))).toEqual(['approvalOverUnits']);
    await api().put(`${S}/marketing`).set('Cookie', admin.cookie).send({}).expect(400);
    await api().put(`${S}/marketing`).set('Cookie', mkt.cookie).send({ approvalOverUnits: 50 }).expect(403);
    const after = (await api().put(`${S}/marketing`).set('Cookie', admin.cookie).send({ approvalOverUnits: 50 }).expect(200)).body.data;
    expect(after[0]).toMatchObject({ type: 'marketing', approvalOverUnits: 50, paymentCheck: false }); // payment check kept
    // the portal list tells the order form the rules of the types I see (not Institutional's for Marketing people)
    expect((await api().get(V).set('Cookie', mkt.cookie).expect(200)).body.meta.approvalRules).toEqual({
      marketing: { overUnits: 50, modes: ['Porter'] }, head_office: { overUnits: 100, modes: ['Porter'] } });
    expect((await api().get(V).set('Cookie', inst.cookie).expect(200)).body.meta.approvalRules).toEqual({ institutional: { overUnits: null, modes: [] } });
    expect((await create(mkt, units(60)).expect(201)).body.data.status).toBe('pending_approval');
    await api().put(`${S}/marketing`).set('Cookie', admin.cookie).send({ approvalOverUnits: null }).expect(200);
    expect((await create(mkt, units(5000)).expect(201)).body.data.status).toBe('submitted');
    expect((await create(mkt, units(5, { mode: 'Porter' })).expect(201)).body.data.status).toBe('pending_approval'); // Porter still
  });
});

/*
 * Bulk Orders Portal v2, piece 1d (2026-11-23): Normal / Fast-track (remarks required, Needed by required), Needed by
 * optional for Normal, modes Porter / Regular, Purpose for Marketing only, every wrong field reported together; the
 * migration BulkOrderFields renames Standard -> Normal and Courier / Self pickup -> Regular.
 */
describe('bulk orders v2: order form fields', () => {
  it('Normal: Needed by optional (empty kept), no remarks kept; Fast-track: remarks + Needed by required, reported together', async () => {
    const n = (await create(mkt, order({ neededBy: undefined, fastTrackRemarks: 'ignored on Normal' })).expect(201)).body.data;
    expect(n).toMatchObject({ priority: 'Normal', neededBy: null, fastTrackRemarks: null });
    const bad = await create(mkt, order({ priority: 'Fast-track', neededBy: undefined })).expect(400);
    expect(fields(bad).sort()).toEqual(['fastTrackRemarks', 'neededBy']);
    const f = (await create(mkt, order({ priority: 'Fast-track', fastTrackRemarks: 'Launch event on Friday' })).expect(201)).body.data;
    expect(f).toMatchObject({ priority: 'Fast-track', neededBy: TOMORROW, fastTrackRemarks: 'Launch event on Friday' });
    expect(fields(await create(mkt, order({ neededBy: '2020-01-01' })).expect(400))).toEqual(['neededBy']);
  });

  it('modes Porter / Regular only (old Courier refused); Purpose kept on Marketing only; special instructions = note', async () => {
    expect(fields(await create(mkt, order({ mode: 'Courier' })).expect(400))).toEqual(['mode']);
    expect(fields(await create(mkt, order({ priority: 'Standard' })).expect(400))).toEqual(['priority']);
    const m = (await create(mkt, order({ purpose: 'Influencer seeding', note: 'Gift wrap each kit' })).expect(201)).body.data;
    expect(m).toMatchObject({ mode: 'Regular', purpose: 'Influencer seeding', note: 'Gift wrap each kit' });
    const ho = (await create(mkt, order({ type: 'head_office', purpose: 'not for head office' })).expect(201)).body.data;
    expect(ho.purpose).toBeNull();
    const i = (await create(inst, order({ type: 'institutional', purpose: 'x' })).expect(201)).body.data;
    expect(i.purpose).toBeNull();
    expect(fields(await create(mkt, order({ purpose: 'x'.repeat(201) })).expect(400))).toEqual(['purpose']);
  });

  it('edit keeps the new fields; switching to Normal drops the remarks', async () => {
    const o = (await create(mkt, order({ priority: 'Fast-track', fastTrackRemarks: 'Urgent', purpose: 'Event' })).expect(201)).body.data as { id: string };
    const e = (await edit(mkt, o.id, order({ neededBy: undefined, purpose: 'Event 2' })).expect(200)).body.data;
    expect(e).toMatchObject({ priority: 'Normal', fastTrackRemarks: null, neededBy: null, purpose: 'Event 2' });
  });

  it('migration BulkOrderFields renames the old words (Standard -> Normal, Courier / Self pickup -> Regular) and down() puts them back', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await rows("UPDATE bulk_orders SET priority = 'Standard', delivery_mode = 'Self pickup' WHERE id = ?", [o.id]);
    const qr = (await db()).createQueryRunner();
    try {
      await new BulkOrderFields1795800000000().down(qr);
      await new BulkOrderFields1795800000000().up(qr);
    } finally {
      await qr.release();
    }
    expect((await rows<{ priority: string; delivery_mode: string }>('SELECT priority, delivery_mode FROM bulk_orders WHERE id = ?', [o.id]))[0])
      .toEqual({ priority: 'Normal', delivery_mode: 'Regular' });
  });
});

/*
 * Bulk Orders Portal v2, piece 1e (2026-11-24): every edit needs a remark (kept with it), the history keeps each changed
 * field old -> new and each line added / removed / changed, and the order says how often it was edited ("Edited" tag).
 */
describe('bulk orders v2: edits with a remark and a field-by-field history', () => {
  it('an edit without a remark is refused, reported with the other wrong fields; nothing saved', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data as { id: string };
    const res = await api().put(`${V}/${o.id}`).set('Cookie', mkt.cookie).send(order({ receiverName: 'Asha' })).expect(400);
    expect(fields(res)).toEqual(['remark']);
    const both = await api().put(`${V}/${o.id}`).set('Cookie', mkt.cookie).send(order({ receiverPhone: '12' })).expect(400);
    expect(fields(both).sort()).toEqual(['receiverPhone', 'remark']);
    expect((await api().get(`${V}/${o.id}`).set('Cookie', mkt.cookie).expect(200)).body.data).toMatchObject({ receiverName: 'Ravi Kumar', editCount: 0 });
  });

  it('the history keeps the remark, every field old -> new and every line change; lists show the edit count', async () => {
    await insert('master_skus', { pep_code: 'SKU_C', brand_name: 'mCaffeine', product_name: 'Coffee Lip Balm', mrp: 199, is_active: 1, bulk_orderable: 1, created_at: new Date(), updated_at: new Date() });
    const o = (await create(mkt, order()).expect(201)).body.data as { id: string }; // SKU_A 10, SKU_B 3, Normal
    const e = (await edit(mkt, o.id, order({
      receiverName: 'Asha', neededBy: undefined, purpose: 'Diwali event',
      lines: [{ pepCode: 'SKU_A', qty: 12 }, { pepCode: 'SKU_C', qty: 1 }],
    }), 'Receiver changed + one more kit').expect(200)).body.data;
    const ev = e.events.at(-1);
    expect(ev).toMatchObject({ action: 'edited', note: 'Receiver changed + one more kit' });
    expect(ev.changes.fieldChanges).toEqual(expect.arrayContaining([
      { field: 'receiverName', from: 'Ravi Kumar', to: 'Asha' },
      { field: 'neededBy', from: TOMORROW, to: null },
      { field: 'purpose', from: null, to: 'Diwali event' },
    ]));
    expect(ev.changes.lineChanges).toEqual([
      { pepCode: 'SKU_A', change: 'changed', qty: [10, 12] },
      { pepCode: 'SKU_C', change: 'added', qty: [0, 1] },
      { pepCode: 'SKU_B', change: 'removed', qty: [3, 0] },
    ]);
    expect(e.editCount).toBe(1);
    await edit(mkt, o.id, order({ receiverName: 'Asha', lines: [{ pepCode: 'SKU_A', qty: 12 }, { pepCode: 'SKU_C', qty: 1 }] }), 'Date back').expect(200);
    const listed = (await api().get(V).set('Cookie', approver.cookie).expect(200)).body.data.find((x: { id: string }) => x.id === o.id);
    expect(listed.editCount).toBe(2);
  });

  it('a discount change shows old -> new on its line (Institutional)', async () => {
    const o = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data as { id: string }; // SKU_A @30, SKU_B @12.5
    const e = (await edit(inst, o.id, order({ type: 'institutional', lines: [{ pepCode: 'SKU_A', qty: 10, discountPct: 25 }, { pepCode: 'SKU_B', qty: 3, discountPct: 12.5 }] }), 'Agreed 25%').expect(200)).body.data;
    expect(e.events.at(-1).changes.lineChanges).toEqual([{ pepCode: 'SKU_A', change: 'changed', discountPct: [30, 25] }]);
  });
});

/*
 * Bulk Orders Portal v2, piece 1f (2026-11-24, user: "check the brand name from that column and show only one brand"):
 * the brand = the PEP SKU master's brand_name (case ignored, empty / "0" = none); the form lists the brands, searches
 * one brand's SKUs, and an order takes SKUs of its one brand only; the brand is kept on the order.
 */
describe('bulk orders v2: one brand per order, from the SKU master', () => {
  const now = () => new Date();
  beforeEach(async () => {
    await insert('master_skus', { pep_code: 'HYP_SERUM', brand_name: 'HYPHEN', product_name: 'Hyphen Serum', mrp: 499, is_active: 1, bulk_orderable: 1, created_at: now(), updated_at: now() });
    await insert('master_skus', { pep_code: 'SKU_CAPS', brand_name: 'MCAFFEINE', product_name: 'Coffee Scrub caps spelling', mrp: 299, is_active: 1, bulk_orderable: 1, created_at: now(), updated_at: now() });
    await insert('master_skus', { pep_code: 'SKU_NOBRAND', brand_name: '0', product_name: 'Coffee Combo no brand', mrp: 599, is_active: 1, bulk_orderable: 1, created_at: now(), updated_at: now() });
    await insert('master_skus', { pep_code: 'DND_OFF', brand_name: 'Drip N Dip', product_name: 'Old DND', mrp: 199, is_active: 0, bulk_orderable: 1, created_at: now(), updated_at: now() });
  });
  const skus = async (q: string, brand?: string) =>
    ((await api().get(`${V}/skus`).query({ q, ...(brand !== undefined ? { brand } : {}) }).set('Cookie', mkt.cookie).expect(200)).body.data as { pepCode: string }[]).map((s) => s.pepCode);

  it('brands = the orderable SKUs\' brand_name values (most used spelling, A-Z); empty / "0" / inactive left out', async () => {
    expect((await api().get(V).set('Cookie', mkt.cookie).expect(200)).body.meta.brands).toEqual(['HYPHEN', 'mCaffeine']);
  });

  it('search shows only the chosen brand (case ignored); no brand chosen = nothing', async () => {
    expect(await skus('coffee', 'mCaffeine')).toEqual(['SKU_A', 'SKU_B', 'SKU_CAPS']);
    expect(await skus('coffee', 'MCAFFEINE')).toEqual(['SKU_A', 'SKU_B', 'SKU_CAPS']);
    expect(await skus('serum', 'HYPHEN')).toEqual(['HYP_SERUM']);
    expect(await skus('serum', 'mCaffeine')).toEqual([]);
    expect(await skus('coffee')).toEqual([]);
    expect(await skus('combo', 'mCaffeine')).toEqual([]); // no brand in the master: under no brand
  });

  it('an order takes its brand\'s SKUs only (named line + why), the brand is kept; brand required', async () => {
    let res = await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 2 }, { pepCode: 'HYP_SERUM', qty: 1 }, { pepCode: 'SKU_NOBRAND', qty: 1 }] })).expect(400);
    expect(fields(res)).toEqual(['lines[1].pepCode', 'lines[2].pepCode']);
    expect(res.body.error.details[0].message).toContain('not a mCaffeine SKU (its brand in the PEP SKU master: HYPHEN)');
    expect(res.body.error.details[1].message).toContain('none: ask the masters team');
    res = await create(mkt, order({ brand: undefined })).expect(400);
    expect(fields(res)).toEqual(['brand']);
    const o = (await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 2 }, { pepCode: 'SKU_CAPS', qty: 1 }] })).expect(201)).body.data;
    expect(o.brand).toBe('mCaffeine');
    const h = (await create(mkt, order({ brand: 'HYPHEN', lines: [{ pepCode: 'HYP_SERUM', qty: 3 }] })).expect(201)).body.data;
    expect(h.brand).toBe('HYPHEN');
    // an edit is checked the same way
    expect(fields(await edit(mkt, h.id, order({ brand: 'HYPHEN', lines: [{ pepCode: 'SKU_A', qty: 1 }] })).expect(400))).toEqual(['lines[0].pepCode']);
  });

  it('migration BulkOrderBrand fills old orders whose SKUs have one brand; mixed / unbranded stay empty', async () => {
    const one = (await create(mkt, order()).expect(201)).body.data as { id: string };
    const two = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await rows("UPDATE bulk_order_lines SET pep_code = 'SKU_NOBRAND' WHERE order_id = ? AND line_no = 2", [two.id]);
    const qr = (await db()).createQueryRunner();
    try {
      await new BulkOrderBrand1795900000000().down(qr);
      await new BulkOrderBrand1795900000000().up(qr);
    } finally {
      await qr.release();
    }
    expect(await rows('SELECT id, brand FROM bulk_orders ORDER BY id')).toEqual([{ id: one.id, brand: 'mCaffeine' }, { id: two.id, brand: null }]);
  });
});

/*
 * Bulk Orders Portal v2 piece 2a (2026-11-24, user "go"): a Marketing / Head office order goes to several receivers,
 * each its own address + SKU lines (bulk_order_receivers; receiver 1 also on the order row); an uploaded receivers file
 * is checked row by row (nothing saved). One sale order per receiver = piece 2b (until then processing refuses).
 */
describe('bulk orders v2: several receivers per order', () => {
  const PUNE = { line: '4 Hill Rd, Baner', city: 'Pune', state: 'Maharashtra', pincode: '411045' };
  const ravi = (lines: unknown[] = [{ pepCode: 'SKU_A', qty: 10 }, { pepCode: 'SKU_B', qty: 3 }]) => ({ receiverName: 'Ravi Kumar', receiverPhone: '+91 98765-43210', address: ADDRESS, lines });
  const meera = (lines: unknown[] = [{ pepCode: 'SKU_A', qty: 5 }]) => ({ receiverName: 'Meera Shah', receiverPhone: '9988776655', address: PUNE, lines });
  const meeraSaved = (lines?: unknown[]) => ({ ...meera(lines), saveLocationAs: 'Pune office' });
  const many = (receivers: unknown[], over: Record<string, unknown> = {}) => {
    const { receiverName: _n, receiverPhone: _p, address: _a, lines: _l, ...rest } = order(over);
    return { ...rest, receivers };
  };
  beforeEach(async () => {
    await rows("UPDATE bulk_type_settings SET approval_over_units = CASE order_type WHEN 'institutional' THEN NULL ELSE 100 END");
  });
  type Full = { id: string; poNumber: string; status: string; receiverCount: number; receivers: { receiverNo: number; receiverName: string; totalUnits: number }[]; lines: { lineNo: number; receiverNo: number; pepCode: string; qty: number }[]; events: { action: string; changes: Record<string, unknown> }[] };

  it('create: each receiver its address + lines (same SKU on two receivers is fine), lines numbered across them, receiver 1 on the order, search finds any receiver', async () => {
    const o = (await create(mkt, many([ravi(), meeraSaved()])).expect(201)).body.data as Full & Record<string, unknown>;
    expect(o).toMatchObject({ status: 'submitted', receiverCount: 2, receiverName: 'Ravi Kumar', receiverPhone: '9876543210', lineCount: 3, totalUnits: 18 });
    expect(o.receivers).toEqual([
      { receiverNo: 1, receiverName: 'Ravi Kumar', receiverPhone: '9876543210', location: { id: null, label: null, address: ADDRESS }, totalUnits: 13, status: null, saleOrderCode: null, tracking: null },
      { receiverNo: 2, receiverName: 'Meera Shah', receiverPhone: '9988776655', location: { id: expect.any(String), label: 'Pune office', address: PUNE }, totalUnits: 5, status: null, saleOrderCode: null, tracking: null },
    ]);
    expect(o.lines.map((l) => [l.lineNo, l.receiverNo, l.pepCode, l.qty])).toEqual([[1, 1, 'SKU_A', 10], [2, 1, 'SKU_B', 3], [3, 2, 'SKU_A', 5]]);
    expect(await rows('SELECT receiver_no n, total_units u FROM bulk_order_receivers WHERE order_id = ? ORDER BY receiver_no', [o.id])).toEqual([{ n: 1, u: 13 }, { n: 2, u: 5 }]);
    const found = (await api().get(V).query({ q: 'Meera' }).set('Cookie', mkt.cookie).expect(200)).body.data as { id: string; receiverCount: number }[];
    expect(found.map((x) => [x.id, x.receiverCount])).toEqual([[o.id, 2]]);
    // the approval rule counts every receiver's units (100 for Marketing): 60 + 50 = 110
    const big = (await create(mkt, many([ravi([{ pepCode: 'SKU_A', qty: 60 }]), meera([{ pepCode: 'SKU_A', qty: 50 }])])).expect(201)).body.data;
    expect(big.status).toBe('pending_approval');
    // one receiver the old way: one receiver row too
    const one = (await create(mkt, order()).expect(201)).body.data as Full;
    expect([one.receiverCount, one.receivers.map((r) => r.receiverName)]).toEqual([1, ['Ravi Kumar']]);
  });

  it('checks per receiver (fields named receivers[i]...), Marketing / Head office only, at most 50, save-as names not twice', async () => {
    expect(fields(await create(inst, many([ravi()], { type: 'institutional' })).expect(400))).toEqual(['receivers']);
    expect(fields(await create(mkt, many([])).expect(400))).toEqual(['receivers']);
    expect(fields(await create(mkt, many(Array.from({ length: 51 }, () => ravi()))).expect(400))).toEqual(['receivers']);
    const bad = { receiverName: 'X', receiverPhone: '123', address: { ...PUNE, pincode: '0123' }, lines: [{ pepCode: 'SKU_A', qty: 0 }] };
    expect(fields(await create(mkt, many([ravi(), bad])).expect(400)).sort()).toEqual(['receivers[1].address.pincode', 'receivers[1].lines[0].qty', 'receivers[1].receiverPhone']);
    expect(fields(await create(mkt, many([meeraSaved(), meeraSaved()])).expect(400))).toEqual(['receivers[1].saveLocationAs']);
    const off = await create(mkt, many([ravi(), meera([{ pepCode: 'NOPE', qty: 1 }])])).expect(400);
    expect(fields(off)).toEqual(['receivers[1].lines[0].pepCode']);
    expect(await count('bulk_orders')).toBe(0);
  });

  it('edit: receivers added / changed / removed + line changes per receiver in the history; approve keeps a line per receiver and updates their units; ONE sale order for all receivers', async () => {
    const o = (await create(mkt, many([ravi(), meera()])).expect(201)).body.data as Full;
    const changed = (await edit(mkt, o.id, many([ravi([{ pepCode: 'SKU_A', qty: 12 }, { pepCode: 'SKU_B', qty: 3 }]), { ...meera(), receiverName: 'Meera S', saveLocationAs: undefined }, { ...meera([{ pepCode: 'SKU_B', qty: 2 }]), receiverName: 'Anil', saveLocationAs: undefined }]), 'Third person added').expect(200)).body.data as Full;
    expect(changed.receivers.map((r) => [r.receiverNo, r.receiverName, r.totalUnits])).toEqual([[1, 'Ravi Kumar', 15], [2, 'Meera S', 5], [3, 'Anil', 2]]);
    const ev = changed.events.find((e) => e.action === 'edited')!.changes;
    expect(ev.receiverChanges).toEqual([
      { receiverNo: 2, change: 'changed', name: 'Meera S', fields: [{ field: 'receiverName', from: 'Meera Shah', to: 'Meera S' }] },
      { receiverNo: 3, change: 'added', name: 'Anil' },
    ]);
    expect(ev.lineChanges).toEqual([{ receiverNo: 1, pepCode: 'SKU_A', change: 'changed', qty: [10, 12] }, { receiverNo: 3, pepCode: 'SKU_B', change: 'added', qty: [0, 2] }]);
    expect(ev.linesAfter).toEqual(['R1 SKU_A x12 @0%', 'R1 SKU_B x3 @0%', 'R2 SKU_A x5 @0%', 'R3 SKU_B x2 @0%']);
    const fewer = (await edit(mkt, o.id, many([ravi()]), 'Only Ravi').expect(200)).body.data as Full;
    expect([fewer.receiverCount, (fewer.events.filter((e) => e.action === 'edited')[1].changes.receiverChanges as { change: string }[]).map((x) => x.change)]).toEqual([1, ['removed', 'removed']]);

    // approve: big order (pending), receiver 2's only line cannot go; a qty change moves its receiver's units
    const big = (await create(mkt, many([ravi([{ pepCode: 'SKU_A', qty: 60 }]), meera([{ pepCode: 'SKU_B', qty: 50 }])])).expect(201)).body.data as Full;
    const r2line = big.lines.find((l) => l.receiverNo === 2)!.lineNo;
    expect(fields(await api().post(`${V}/${big.id}/approve`).set('Cookie', approver.cookie).send({ removeLines: [r2line] }).expect(400))).toEqual(['removeLines']);
    const ok = (await api().post(`${V}/${big.id}/approve`).set('Cookie', approver.cookie).send({ lines: [{ lineNo: r2line, qty: 40 }] }).expect(200)).body.data as Full;
    expect(ok.receivers.map((r) => r.totalUnits)).toEqual([60, 40]);
    // user 2026-11-24: ONE sale order for the whole order (several shipments in Uniware); every receiver carries it
    await insert('master_facilities', { code: 'MUM_WAREHOUSE2', name: 'Bhiwandi', entity: 'PEP', state: 'Maharashtra', is_active: 1, intransit_type: 'MWH', source: 'manual', uniware_export: 0 });
    const done = (await api().post(`/api/v1/po-review/bulk-orders/${big.id}/process`).set('Cookie', opsExec.cookie).send({ facilityCode: 'MUM_WAREHOUSE2', uniwareChannel: 'JIVA', customerCode: 'C1' }).expect(200)).body.data as Full & { saleOrder: { code: string } };
    expect(done.receivers.map((r) => [r.receiverNo, (r as unknown as { saleOrderCode: string }).saleOrderCode])).toEqual([[1, done.saleOrder.code], [2, done.saleOrder.code]]);
    const file = JSON.parse([...s3Objects().entries()].find(([k]) => k.includes(`/${big.poNumber}/`) && k.endsWith('order.json'))![1]) as { receivers: { name: string; lines: unknown[] }[] };
    expect(file.receivers.map((r) => [r.name, r.lines.length])).toEqual([['Ravi Kumar', 1], ['Meera Shah', 1]]);
  });

  it('drafts keep their receivers; submit checks them all', async () => {
    const d = (await create(mkt, { ...many([ravi(), { receiverName: 'Half done', lines: [] }]), draft: true }).expect(201)).body.data as Full;
    expect([d.status, d.receiverCount, d.receivers.map((r) => r.receiverName)]).toEqual(['draft', 2, ['Ravi Kumar', 'Half done']]);
    expect(fields(await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send(many([ravi(), { receiverName: 'Half done', lines: [] }])).expect(400)).sort())
      .toEqual(['receivers[1].address', 'receivers[1].address.city', 'receivers[1].address.line', 'receivers[1].address.pincode', 'receivers[1].address.state', 'receivers[1].lines', 'receivers[1].receiverPhone']);
    const sent = (await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send(many([ravi(), meera()])).expect(200)).body.data as Full;
    expect([sent.status, sent.poNumber, sent.receivers.length]).toEqual(['submitted', `MKT-${YEAR}-0001`, 2]);
  });

  it('receivers file check: rows grouped per receiver, each bad row with its reason, nothing saved; Marketing / Head office editors only', async () => {
    const R = `${V}/receivers/check`;
    const row = (over: Record<string, unknown>) => ({ receiverName: 'Ravi Kumar', receiverPhone: '+91 98765 43210', line: ADDRESS.line, city: 'Mumbai', state: 'Maharashtra', pincode: 400069, pepCode: 'SKU_A', qty: 10, ...over });
    const rowsIn = [
      row({ row: 2 }), row({ row: 3, pepCode: 'sku_b', qty: '3' }),
      row({ row: 4, receiverName: 'Meera Shah', receiverPhone: 9988776655, line: PUNE.line, city: 'Pune', pincode: '411045' }),
      row({ row: 5, receiverPhone: '123', pepCode: 'NOPE', qty: 0 }),
      row({ row: 6, qty: 4 }),
    ];
    const out = (await api().post(R).set('Cookie', mkt.cookie).send({ type: 'marketing', brand: 'mCaffeine', rows: rowsIn }).expect(200)).body.data;
    expect(out.rowCount).toBe(5);
    expect(out.receivers).toEqual([
      { receiverName: 'Ravi Kumar', receiverPhone: '9876543210', address: ADDRESS, rows: [2, 3], lines: [
        { pepCode: 'SKU_A', name: 'Coffee Body Scrub 100g', mrp: 100, qty: 10 }, { pepCode: 'SKU_B', name: 'Coffee Face Wash 100ml', mrp: 349, qty: 3 }] },
      { receiverName: 'Meera Shah', receiverPhone: '9988776655', address: PUNE, rows: [4], lines: [{ pepCode: 'SKU_A', name: 'Coffee Body Scrub 100g', mrp: 100, qty: 10 }] },
    ]);
    expect((out.errors as { row: number; field: string }[]).map((e) => [e.row, e.field])).toEqual([[5, 'receiverPhone'], [5, 'pepCode'], [5, 'qty'], [6, 'pepCode']]);
    expect(out.errors[3].message).toMatch(/already on another row/);
    expect(fields(await api().post(R).set('Cookie', inst.cookie).send({ type: 'institutional', brand: 'mCaffeine', rows: rowsIn }).expect(400))).toEqual(['type']);
    await api().post(R).set('Cookie', inst.cookie).send({ type: 'marketing', brand: 'mCaffeine', rows: rowsIn }).expect(403);
    expect(fields(await api().post(R).set('Cookie', mkt.cookie).send({ type: 'marketing', brand: 'mCaffeine', rows: [] }).expect(400))).toEqual(['rows']);
    expect(await count('bulk_orders')).toBe(0);
  });

  it('migration BulkOrderReceivers: every existing order gets its receiver 1 (down + up)', async () => {
    const a = (await create(mkt, order()).expect(201)).body.data as Full;
    const b = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data as Full;
    const before = await rows('SELECT order_id, receiver_no, receiver_name, receiver_phone, address_line, pincode, total_units FROM bulk_order_receivers ORDER BY order_id');
    const qr = (await db()).createQueryRunner();
    try {
      await new BulkOrderReceivers1796200000000().down(qr);
      await new BulkOrderReceivers1796200000000().up(qr);
    } finally {
      await qr.release();
    }
    expect(await rows('SELECT order_id, receiver_no, receiver_name, receiver_phone, address_line, pincode, total_units FROM bulk_order_receivers ORDER BY order_id')).toEqual(before);
    expect(before.map((r) => (r as { order_id: string }).order_id).map(String)).toEqual([a.id, b.id]);
    expect(await rows('SELECT DISTINCT receiver_no n FROM bulk_order_lines')).toEqual([{ n: 1 }]);
  });
});

/*
 * Bulk Orders Portal v2 piece 5a (2026-11-24, user "GO"; PRD "Customers page"): Institutional customers (company,
 * GSTIN unverified until finance, billing, contact, default discount, shipping addresses), kept by our Institutional
 * team for now; an Institutional order placed for a customer takes its company / GSTIN / email / billing.
 */
describe('bulk orders v2: Institutional customers', () => {
  const C = `${V}/customers`;
  const BILL = { line: 'Accounts, 4 Hill Rd', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
  const SHIP = { line: 'Gate 2, Sunrise School, Baner', city: 'Pune', state: 'Maharashtra', pincode: '411045' };
  const cust = (over: Record<string, unknown> = {}) => ({
    companyName: 'Sunrise Public School', gstin: '27aaacs1234a1z5', billingAddress: BILL, contactName: 'Asha Rao', contactPhone: '+91 98200 11223',
    contactEmail: 'accounts@sunrise.example', defaultDiscountPct: 12.5, addresses: [{ label: 'Main campus', address: SHIP }], ...over,
  });
  type Cust = { id: string; companyName: string; gstin: string | null; gstinVerified: unknown; active: boolean; defaultDiscountPct: number; addresses: { id: string; label: string; active: boolean }[] };

  it('Institutional editors add / change / switch off customers and their addresses; viewers see them; Marketing cannot; checks + no twins', async () => {
    const c = (await api().post(C).set('Cookie', inst.cookie).send(cust()).expect(201)).body.data as Cust & Record<string, unknown>;
    expect(c).toMatchObject({
      companyName: 'Sunrise Public School', gstin: '27AAACS1234A1Z5', gstinVerified: null, billingAddress: BILL, contactName: 'Asha Rao', contactPhone: '9820011223',
      contactEmail: 'accounts@sunrise.example', defaultDiscountPct: 12.5, active: true, addresses: [{ label: 'Main campus', address: SHIP, active: true }], createdBy: { id: inst.userId },
    });
    expect(fields(await api().post(C).set('Cookie', inst.cookie).send({ gstin: 'BAD', contactPhone: '12', defaultDiscountPct: 100, addresses: [{}] }).expect(400)).sort()).toEqual([
      'addresses[0].address', 'addresses[0].address.city', 'addresses[0].address.line', 'addresses[0].address.pincode', 'addresses[0].address.state', 'addresses[0].label',
      'billingAddress', 'billingAddress.city', 'billingAddress.line', 'billingAddress.pincode', 'billingAddress.state', 'companyName', 'contactName', 'contactPhone', 'defaultDiscountPct', 'gstin',
    ]);
    expect((await api().post(C).set('Cookie', inst.cookie).send(cust({ companyName: 'Other' })).expect(409)).body.error.code).toBe('BULK_INST_CUSTOMER_EXISTS'); // same GSTIN
    await api().post(C).set('Cookie', inst.cookie).send(cust({ companyName: 'sunrise public school', gstin: '' })).expect(409); // same name
    await api().post(C).set('Cookie', mkt.cookie).send(cust({ gstin: '' })).expect(403);
    await api().get(C).set('Cookie', mkt.cookie).expect(403);
    await api().post(C).set('Cookie', approver.cookie).send(cust({ companyName: 'X', gstin: '' })).expect(403); // approver: Institutional viewer
    expect(((await api().get(C).set('Cookie', approver.cookie).expect(200)).body.data as Cust[]).map((x) => x.companyName)).toEqual(['Sunrise Public School']);

    // a GSTIN change clears the verification (verified by finance in 5b; set here directly)
    await rows('UPDATE bulk_institution_customers SET gstin_verified_at = NOW(6), gstin_verified_by = ? WHERE id = ?', [inst.userId, c.id]);
    const same = (await api().put(`${C}/${c.id}`).set('Cookie', inst.cookie).send(cust({ contactName: 'Asha R' })).expect(200)).body.data as Cust;
    expect(same.gstinVerified).toMatchObject({ by: { id: inst.userId } });
    const moved = (await api().put(`${C}/${c.id}`).set('Cookie', inst.cookie).send(cust({ gstin: '27AAACS1234A1Z6' })).expect(200)).body.data as Cust;
    expect([moved.gstin, moved.gstinVerified]).toEqual(['27AAACS1234A1Z6', null]);
    await api().put(`${C}/999999`).set('Cookie', inst.cookie).send(cust()).expect(404);

    const two = (await api().post(`${C}/${c.id}/addresses`).set('Cookie', inst.cookie).send({ label: 'Hostel', address: { ...SHIP, line: 'Hostel block' } }).expect(201)).body.data as Cust;
    expect(two.addresses.map((a) => a.label)).toEqual(['Main campus', 'Hostel']);
    const off = (await api().put(`${C}/${c.id}/addresses/${two.addresses[0].id}`).set('Cookie', inst.cookie).send({ active: false }).expect(200)).body.data as Cust;
    expect(off.addresses.map((a) => [a.label, a.active])).toEqual([['Main campus', false], ['Hostel', true]]);
    expect(fields(await api().put(`${C}/${c.id}/addresses/${two.addresses[0].id}`).set('Cookie', inst.cookie).send({}).expect(400))).toEqual(['active']);
    const gone = (await api().put(`${C}/${c.id}`).set('Cookie', inst.cookie).send(cust({ gstin: '27AAACS1234A1Z6', active: false })).expect(200)).body.data as Cust;
    expect(gone.active).toBe(false);
    // a switched-off customer frees its name
    await api().post(C).set('Cookie', inst.cookie).send(cust({ gstin: '' })).expect(201);
  });

  it('an Institutional order for a customer takes its company / GSTIN / email / billing (not verified yet); a switched-off / unknown customer = 400; the typed way still works', async () => {
    const c = (await api().post(C).set('Cookie', inst.cookie).send(cust()).expect(201)).body.data as Cust;
    const { institutionName: _n, gstin: _g, contactEmail: _e, billingSameAsDelivery: _b, ...noInst } = order({ type: 'institutional' });
    const o = (await create(inst, { ...noInst, customerId: c.id, address: SHIP }).expect(201)).body.data;
    expect(o.institution).toEqual({ customerId: c.id, gstinVerified: false, name: 'Sunrise Public School', gstin: '27AAACS1234A1Z5', email: 'accounts@sunrise.example', billingAddress: BILL });
    await rows('UPDATE bulk_institution_customers SET gstin_verified_at = NOW(6) WHERE id = ?', [c.id]);
    expect((await api().get(`${V}/${o.id}`).set('Cookie', inst.cookie).expect(200)).body.data.institution.gstinVerified).toBe(true);
    const list = (await api().get(V).set('Cookie', inst.cookie).expect(200)).body.data as { id: string; institution: { gstinVerified: boolean } }[];
    expect(list.find((x) => x.id === o.id)!.institution.gstinVerified).toBe(true);
    expect(fields(await create(inst, { ...noInst, customerId: '999999', address: SHIP }).expect(400))).toEqual(['customerId']);
    expect(fields(await create(inst, { ...noInst, customerId: 'abc', address: SHIP }).expect(400))).toEqual(['customerId']);
    await api().put(`${C}/${c.id}`).set('Cookie', inst.cookie).send(cust({ active: false })).expect(200);
    expect(fields(await create(inst, { ...noInst, customerId: c.id, address: SHIP }).expect(400))).toEqual(['customerId']);
    const typed = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    expect(typed.institution).toMatchObject({ customerId: null, gstinVerified: null, name: 'Sunrise Public School' });
  });

  it('migration BulkInstitutionCustomers: down + up keeps orders, adds the tables again', async () => {
    const o = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const qr = (await db()).createQueryRunner();
    try {
      // the later BulkBuyerOrgs adds a column to its table: undone first, done again after
      await new BulkBuyerOrgs1796600000000().down(qr);
      await new BulkInstitutionCustomers1796300000000().down(qr);
      await new BulkInstitutionCustomers1796300000000().up(qr);
      await new BulkBuyerOrgs1796600000000().up(qr);
    } finally {
      await qr.release();
    }
    expect(await rows('SELECT id, institution_customer_id c FROM bulk_orders')).toEqual([{ id: String(o.id), c: null }]);
    expect(await count('bulk_institution_customers')).toBe(0);
  });
});

/*
 * Bulk Orders Portal v2 piece 5b (2026-11-24, user "GO": Finance + admin / developer; PRD "Invoices and payments"):
 * role bulk-finance (portal only: Institutional orders + the verify payments permission); payment unbilled -> invoiced
 * -> payment_submitted -> paid (refused = back to invoiced); the Razorpay link pasted by finance; customer GSTIN verify.
 */
describe('bulk orders v2: finance (invoice, payment link, verify payment, GSTIN)', () => {
  const PDF = Buffer.from('%PDF-1.4 test');
  const up = (who: TestLogin, id: string, kind: string, name: string) => api().post(`${V}/${id}/documents`).set('Cookie', who.cookie).field('kind', kind).attach('file', PDF, name);
  const pay = (who: TestLogin, id: string, body: Record<string, unknown>) => api().post(`${V}/${id}/payment`).set('Cookie', who.cookie).send(body);
  const LINK = 'https://rzp.io/l/sunrise-inst-0001';

  it('finance sees Institutional orders only, uploads the invoice (invoiced), pastes the link (buyer sees it), refuses (back to invoiced) and verifies (paid)', async () => {
    const fin = await loginAs('bulk-finance');
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const m = (await create(mkt, order()).expect(201)).body.data;
    expect((await api().get(V).set('Cookie', fin.cookie).expect(200)).body.data.map((x: { id: string }) => x.id)).toEqual([i.id]);
    await api().get(`${V}/${m.id}`).set('Cookie', fin.cookie).expect(404);
    await create(fin, order({ type: 'institutional' })).expect(403); // viewer: places no orders

    expect((await up(fin, i.id, 'invoice', 'INV-77.pdf').expect(201)).body.data.payment.status).toBe('invoiced');
    expect(fields(await pay(fin, i.id, { action: 'set_details', link: 'http://rzp.io/l/x' }).expect(400))).toEqual(['link']);
    expect(fields(await pay(fin, i.id, { action: 'set_details' }).expect(400))).toEqual(['link']);
    expect((await pay(inst, i.id, { action: 'set_details', link: LINK }).expect(403)).body.error.code).toBe('BULK_NOT_PAYMENT_DETAILS'); // the buyer cannot
    const linked = (await pay(fin, i.id, { action: 'set_details', link: LINK }).expect(200)).body.data;
    expect(linked.payment).toMatchObject({ status: 'invoiced', link: LINK });
    expect((await api().get(`${V}/${i.id}`).set('Cookie', inst.cookie).expect(200)).body.data.payment.link).toBe(LINK);

    expect((await pay(fin, i.id, { action: 'verify' }).expect(409)).body.error.code).toBe('BULK_PAYMENT_NO_PROOF');
    expect((await up(inst, i.id, 'payment_proof', 'utr.pdf').expect(201)).body.data.payment.status).toBe('payment_submitted');
    const refused = (await pay(fin, i.id, { action: 'refuse', note: 'UTR not found' }).expect(200)).body.data;
    expect(refused.payment).toMatchObject({ status: 'invoiced', note: 'UTR not found', by: { id: fin.userId } });
    await up(inst, i.id, 'payment_proof', 'utr-2.pdf').expect(201);
    const paid = (await pay(fin, i.id, { action: 'verify', note: 'UTR 99 matched' }).expect(200)).body.data;
    expect(paid.payment).toMatchObject({ status: 'paid', link: LINK });
    expect(paid.events.filter((e: { action: string }) => e.action === 'payment').map((e: { changes: Record<string, unknown> }) => e.changes.status ?? 'link'))
      .toEqual([['unbilled', 'invoiced'], 'link', ['invoiced', 'payment_submitted'], ['payment_submitted', 'invoiced'], ['invoiced', 'payment_submitted'], ['payment_submitted', 'paid']]);
  });

  it('finance verifies a customer GSTIN (others cannot); orders show it; a customer without GSTIN = 409; bulk-finance is a portal-only role', async () => {
    const fin = await loginAs('bulk-finance');
    const C = `${V}/customers`;
    const body = { companyName: 'Sunrise Public School', gstin: '27AAACS1234A1Z5', billingAddress: ADDRESS, contactName: 'Asha', contactPhone: '9820011223' };
    const c = (await api().post(C).set('Cookie', inst.cookie).send(body).expect(201)).body.data;
    await api().post(`${C}/${c.id}/gstin`).set('Cookie', inst.cookie).send({ verified: true }).expect(403);
    expect(fields(await api().post(`${C}/${c.id}/gstin`).set('Cookie', fin.cookie).send({ verified: 'yes' }).expect(400))).toEqual(['verified']);
    const v = (await api().post(`${C}/${c.id}/gstin`).set('Cookie', fin.cookie).send({ verified: true }).expect(200)).body.data;
    expect(v.gstinVerified).toMatchObject({ by: { id: fin.userId } });
    expect((await api().get(C).set('Cookie', fin.cookie).expect(200)).body.data[0].gstinVerified).not.toBeNull();
    expect((await api().post(`${C}/${c.id}/gstin`).set('Cookie', fin.cookie).send({ verified: false }).expect(200)).body.data.gstinVerified).toBeNull();
    const noG = (await api().post(C).set('Cookie', inst.cookie).send({ ...body, companyName: 'No GST School', gstin: '' }).expect(201)).body.data;
    expect((await api().post(`${C}/${noG.id}/gstin`).set('Cookie', fin.cookie).send({ verified: true }).expect(409)).body.error.code).toBe('BULK_INST_CUSTOMER_NO_GSTIN');
    await api().post(`${C}/999999/gstin`).set('Cookie', fin.cookie).send({ verified: true }).expect(404);
    const me = (await api().get('/api/v1/auth/me').set('Cookie', fin.cookie).expect(200)).body.data;
    expect([me.access['/bulk-orders/institutional'], me.access['/bulk-orders/marketing'], me.access['/operations']]).toEqual(['viewer', 'none', 'none']);
  });

  it('migration BulkFinance: old payment statuses renamed (invoice -> invoiced), down + up', async () => {
    const a = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const b = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await up(inst, b.id, 'invoice', 'inv.pdf').expect(201);
    const c = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    await up(inst, c.id, 'payment_proof', 'utr.pdf').expect(201);
    const qr = (await db()).createQueryRunner();
    const statuses = async () => (await rows('SELECT payment_status s FROM bulk_orders ORDER BY id')).map((r) => (r as { s: string }).s);
    try {
      await new BulkFinance1796400000000().down(qr);
      expect(await statuses()).toEqual(['awaiting_proof', 'awaiting_proof', 'proof_uploaded']);
      await rows("UPDATE bulk_orders SET payment_status = 'refused' WHERE id = ?", [a.id]);
      await new BulkFinance1796400000000().up(qr);
    } finally {
      await qr.release();
    }
    expect(await statuses()).toEqual(['unbilled', 'invoiced', 'payment_submitted']);
    expect(await rows("SELECT role_key k FROM roles WHERE role_key = 'bulk-finance'")).toEqual([{ k: 'bulk-finance' }]);
  });
});

/*
 * Payment details (2026-11-24, user: "our team sends a Razorpay link generated somewhere, or a QR, or bank details; they
 * send the proof as screenshots"; "put 3"; "we give access to the payment details"): link / QR / bank details by the
 * payment details permission (bulk-finance, admin, developer); up to 3 proof files; the requester is told.
 */
describe('bulk orders: payment details (link / QR / bank details), 3 proof screenshots, buyer told', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const up = (who: TestLogin, id: string, kind: string, name: string) => api().post(`${V}/${id}/documents`).set('Cookie', who.cookie).field('kind', kind).attach('file', PNG, name);
  const pay = (who: TestLogin, id: string, body: Record<string, unknown>) => api().post(`${V}/${id}/payment`).set('Cookie', who.cookie).send(body);
  const told = async (userId: number) => (await rows<{ text: string }>('SELECT text FROM notices WHERE to_user_id = ? ORDER BY id', [userId])).map((r) => r.text);

  it('finance adds a link + bank details (each can be cleared) and a QR; the buyer cannot; the buyer is told; nothing changes the status', async () => {
    const fin = await loginAs('bulk-finance');
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const bank = 'A/c 1234567890, IFSC HDFC0001234, UPI pep@hdfc';
    const d = (await pay(fin, i.id, { action: 'set_details', link: 'https://rzp.io/l/abc', bankDetails: bank }).expect(200)).body.data;
    expect(d.payment).toMatchObject({ status: 'unbilled', link: 'https://rzp.io/l/abc', bankDetails: bank });
    expect((await told(inst.userId)).some((t) => t.startsWith(`Payment details for your bulk order ${i.poNumber}`))).toBe(true);
    const cleared = (await pay(fin, i.id, { action: 'set_details', link: '' }).expect(200)).body.data;
    expect(cleared.payment).toMatchObject({ link: null, bankDetails: bank });
    expect(fields(await pay(fin, i.id, { action: 'set_details', bankDetails: 5 }).expect(400))).toEqual(['bankDetails']);
    expect((await up(inst, i.id, 'payment_qr', 'qr.png').expect(403)).body.error.code).toBe('BULK_NOT_PAYMENT_DETAILS');
    const q = (await up(fin, i.id, 'payment_qr', 'qr.png').expect(201)).body.data;
    expect(q.documents.map((x: { kind: string }) => x.kind)).toEqual(['payment_qr']);
    expect(q.payment.status).toBe('unbilled');
    // a verifier without the details permission cannot (separate permissions)
    await rows("DELETE FROM page_permissions WHERE role = 'bulk-finance' AND page_slug = 'bulk-orders:payment-details'");
    const fin2 = await loginAs('bulk-finance');
    await pay(fin2, i.id, { action: 'set_details', link: 'https://rzp.io/l/x' }).expect(403);
  });

  it('up to 3 proof screenshots kept together; a 4th waits; a refusal sets them aside for a new set; paid / refused told to the buyer', async () => {
    const fin = await loginAs('bulk-finance');
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    for (const n of [1, 2, 3]) await up(inst, i.id, 'payment_proof', `shot-${n}.png`).expect(201);
    const four = await up(inst, i.id, 'payment_proof', 'shot-4.png').expect(400);
    expect(four.body.error.details[0].message).toMatch(/already has 3 proof files/);
    const before = (await api().get(`${V}/${i.id}`).set('Cookie', inst.cookie).expect(200)).body.data;
    expect(before.documents.filter((x: { replacedAt: string | null }) => !x.replacedAt)).toHaveLength(3);
    await pay(fin, i.id, { action: 'refuse', note: 'Amount does not match' }).expect(200);
    await up(inst, i.id, 'payment_proof', 'shot-5.png').expect(201); // a new set
    const paid = (await pay(fin, i.id, { action: 'verify' }).expect(200)).body.data;
    expect(paid.payment.status).toBe('paid');
    expect(paid.documents.filter((x: { kind: string; replacedAt: string | null }) => x.kind === 'payment_proof' && !x.replacedAt).map((x: { fileName: string }) => x.fileName)).toEqual(['shot-5.png']);
    const t = await told(inst.userId);
    expect(t.some((x) => x.includes('was not accepted: Amount does not match'))).toBe(true);
    expect(t.some((x) => x.startsWith(`Your payment for bulk order ${i.poNumber} is verified`))).toBe(true);
  });

  it('migration BulkPaymentDetails: down + up', async () => {
    const qr = (await db()).createQueryRunner();
    try {
      await new BulkPaymentDetails1796500000000().down(qr);
      expect(await count('page_permissions', "page_slug = 'bulk-orders:payment-details'")).toBe(0);
      await new BulkPaymentDetails1796500000000().up(qr);
    } finally {
      await qr.release();
    }
    expect(await rows("SELECT role FROM page_permissions WHERE page_slug = 'bulk-orders:payment-details'")).toEqual([{ role: 'bulk-finance' }]);
  });
});

/*
 * Quick wins (2026-11-24, user): Marketing / Head office amounts not in the portal API (our team keeps them); a duplicate
 * warning before Submit; our team's "waiting more than N days" filter.
 */
describe('bulk orders: free orders without amounts in the portal, duplicate warning, waiting more than N days', () => {
  it('portal answers carry no amounts on Marketing / Head office orders; Institutional and our team keep them', async () => {
    const m = (await create(mkt, order()).expect(201)).body.data;
    expect([m.totalMrp, m.totalValue, m.lines[0].mrp, m.lines[0].unitPrice, m.lines[0].lineTotal]).toEqual([null, null, null, null, null]);
    expect((await api().get(V).set('Cookie', mkt.cookie).expect(200)).body.data[0].totalValue).toBeNull();
    const team = (await api().get(`/api/v1/po-review/bulk-orders/${m.id}`).set('Cookie', opsExec.cookie).expect(200)).body.data;
    expect(team.totalValue).toBeGreaterThan(0);
    expect(team.lines[0].unitPrice).toBe(MARKETING_UNIT_PRICE);
    const i = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    expect(i.totalValue).toBe(1616.14);
  });

  it('duplicate check: my own recent order with the same SKUs to the same pincode (not others, not a cancelled one, not the order being edited)', async () => {
    const D = `${V}/duplicate-check`;
    const a = (await create(mkt, order()).expect(201)).body.data;
    const check = (who: TestLogin, body: Record<string, unknown>) => api().post(D).set('Cookie', who.cookie).send({ type: 'marketing', pepCodes: ['SKU_B', 'sku_a'], pincodes: [ADDRESS.pincode], ...body });
    expect((await check(mkt, {}).expect(200)).body.data.map((x: { poNumber: string }) => x.poNumber)).toEqual([a.poNumber]);
    expect((await check(mkt, { pepCodes: ['SKU_A'] }).expect(200)).body.data).toEqual([]); // other SKUs
    expect((await check(mkt, { pincodes: ['411001'] }).expect(200)).body.data).toEqual([]); // other place
    expect((await check(mkt, { excludeId: a.id }).expect(200)).body.data).toEqual([]); // editing that order
    await check(inst, {}).expect(403);
    expect(fields(await check(mkt, { pepCodes: [] }).expect(400))).toEqual(['pepCodes']);
    await api().post(`${V}/${a.id}/cancel`).set('Cookie', mkt.cookie).send({}).expect(200);
    expect((await check(mkt, {}).expect(200)).body.data).toEqual([]);
  });

  it('our team: ready orders waiting more than N days', async () => {
    const T = '/api/v1/po-review/bulk-orders';
    await rows('UPDATE bulk_type_settings SET approval_over_units = NULL');
    const old = (await create(mkt, order()).expect(201)).body.data;
    const fresh = (await create(mkt, order()).expect(201)).body.data;
    await rows('UPDATE bulk_orders SET created_at = DATE_SUB(NOW(6), INTERVAL 5 DAY) WHERE id = ?', [old.id]);
    const ids = async (n: number) => ((await api().get(`${T}?type=marketing&waitingDays=${n}`).set('Cookie', opsExec.cookie).expect(200)).body.data as { id: string }[]).map((x) => x.id);
    expect(await ids(3)).toEqual([old.id]);
    expect(await ids(10)).toEqual([]);
    expect(fields(await api().get(`${T}?waitingDays=0`).set('Cookie', opsExec.cookie).expect(400))).toEqual(['waitingDays']);
    expect(fresh.status).toBe('submitted');
  });
});

/*
 * Stock on the approval screen (2026-11-24, backlog M5.4): units on hand at the mother warehouses from the newest
 * in-transit report (read only; the snapshot is faked here).
 */
describe('bulk orders: stock at the mother warehouses on the approval screen', () => {
  const CSV = [
    'Split2 SKU,Entity,SKU Name,Final Location,Channel Name,Channel type,Stock Type,Final Units',
    'SKU_A,Pep,Scrub,Gurgaon,GGNMWH,GGNMWH,SOH,120',
    'SKU_A,Pep,Scrub,Mumbai,MUMMWH,MUMMWH,SOH,30',
    'SKU_A,Pep,Scrub,Mumbai,MUMMWH,MUMMWH,Intransit,500',
    'SKU_A,Pep,Scrub,Gurgaon,Return,Return,SOH,7',
    'SKU_A,Pep,Scrub,HYP_AHMD,D2C,D2C,SOH,99',
    '"SKU_B","Pep","Wash, 100ml",Kolkata,KOLMWH,KOLMWH,SOH,4',
  ].join('\n');

  it('approvers and our team see on-hand units per mother warehouse (in-transit / returns / D2C left out); others cannot; no report = a note', async () => {
    snap.csv = CSV;
    snap.shown = true;
    const o = (await create(mkt, order()).expect(201)).body.data;
    const r = (await api().get(`${V}/${o.id}/stock`).set('Cookie', approver.cookie).expect(200)).body.data;
    expect(r).toEqual({ asOf: '2026-11-24', warehouses: ['GGN', 'MUM', 'KOL'], note: null, skus: { SKU_A: { GGN: 120, MUM: 30 }, SKU_B: { KOL: 4 } } });
    expect((await api().get(`/api/v1/po-review/bulk-orders/${o.id}/stock`).set('Cookie', opsExec.cookie).expect(200)).body.data.skus.SKU_A).toEqual({ GGN: 120, MUM: 30 });
    await api().get(`${V}/${o.id}/stock`).set('Cookie', mkt.cookie).expect(403); // the requester: not an approver
    snap.shown = false;
    snap.csv = 'x';
    const none = (await api().get(`${V}/${o.id}/stock`).set('Cookie', approver.cookie).expect(200)).body.data;
    expect([none.asOf, none.note, none.skus.SKU_A]).toEqual([null, 'No stock report available (the in-transit report has not been built yet)', null]);
  });
});

/*
 * Buyer organisations (2026-11-24, user "yes do this too"): an outside buyer sees only its organisation's orders +
 * customers; our people (no organisation) see everything; admins set them up in POST_FG.
 */
describe('bulk orders: buyer organisations (outside buyers see only their own)', () => {
  const O = `${V}/settings/orgs`;
  const CUST = { companyName: 'Sunrise Public School', billingAddress: ADDRESS, contactName: 'Asha', contactPhone: '9820011223' };

  it('admins add an organisation with its people (existing users, one organisation each); others cannot', async () => {
    const admin = await loginAs('admin');
    const buyer = await loginAs('bulk-institutional');
    await api().get(O).set('Cookie', inst.cookie).expect(403);
    expect(fields(await api().post(O).set('Cookie', admin.cookie).send({ name: 'Sunrise Group', emails: ['nobody@x.com'] }).expect(400))).toEqual(['emails']);
    const org = (await api().post(O).set('Cookie', admin.cookie).send({ name: 'Sunrise Group', emails: [buyer.email] }).expect(201)).body.data;
    expect(org).toMatchObject({ name: 'Sunrise Group', active: true, members: [{ userId: buyer.userId, email: buyer.email }] });
    expect((await api().post(O).set('Cookie', admin.cookie).send({ name: 'sunrise group' }).expect(409)).body.error.code).toBe('BULK_ORG_EXISTS');
    const other = (await api().post(O).set('Cookie', admin.cookie).send({ name: 'Other Co' }).expect(201)).body.data;
    expect((await api().put(`${O}/${other.id}`).set('Cookie', admin.cookie).send({ emails: [buyer.email] }).expect(409)).body.error.code).toBe('BULK_ORG_USER_TAKEN');
    const off = (await api().put(`${O}/${org.id}`).set('Cookie', admin.cookie).send({ active: false, emails: [] }).expect(200)).body.data;
    expect([off.active, off.members]).toEqual([false, []]);
    await api().put(`${O}/999999`).set('Cookie', admin.cookie).send({ active: true }).expect(404);
  });

  it("an outside buyer sees and uses only its organisation's customers and orders; our people see all", async () => {
    const admin = await loginAs('admin');
    const buyer = await loginAs('bulk-institutional');
    await api().post(O).set('Cookie', admin.cookie).send({ name: 'Sunrise Group', emails: [buyer.email] }).expect(201);
    const ours = (await api().post(`${V}/customers`).set('Cookie', inst.cookie).send({ ...CUST, companyName: 'Our Customer' }).expect(201)).body.data;
    const theirs = (await api().post(`${V}/customers`).set('Cookie', buyer.cookie).send(CUST).expect(201)).body.data;
    expect(((await api().get(`${V}/customers`).set('Cookie', buyer.cookie).expect(200)).body.data as { id: string }[]).map((c) => c.id)).toEqual([theirs.id]);
    expect(((await api().get(`${V}/customers`).set('Cookie', inst.cookie).expect(200)).body.data as { id: string }[]).map((c) => c.id).sort()).toEqual([ours.id, theirs.id].sort());
    await api().put(`${V}/customers/${ours.id}`).set('Cookie', buyer.cookie).send(CUST).expect(404);

    const { institutionName: _n, gstin: _g, contactEmail: _e, billingSameAsDelivery: _b, ...noInst } = order({ type: 'institutional' });
    expect(fields(await create(buyer, { ...noInst, customerId: ours.id }).expect(400))).toEqual(['customerId']); // not its customer
    const mine = (await create(buyer, { ...noInst, customerId: theirs.id }).expect(201)).body.data;
    const ourOrder = (await create(inst, order({ type: 'institutional' })).expect(201)).body.data;
    const forThem = (await create(inst, { ...noInst, customerId: theirs.id }).expect(201)).body.data; // our team orders for their customer
    expect(((await api().get(V).set('Cookie', buyer.cookie).expect(200)).body.data as { id: string }[]).map((x) => x.id).sort()).toEqual([mine.id, forThem.id].sort());
    await api().get(`${V}/${ourOrder.id}`).set('Cookie', buyer.cookie).expect(404);
    await api().post(`${V}/${ourOrder.id}/cancel`).set('Cookie', buyer.cookie).send({}).expect(404);
    expect(((await api().get(V).set('Cookie', inst.cookie).expect(200)).body.data as unknown[]).length).toBe(3);
    expect(await rows('SELECT id, buyer_org_id IS NOT NULL org FROM bulk_orders ORDER BY id')).toEqual([
      { id: mine.id, org: '1' }, { id: ourOrder.id, org: '0' }, { id: forThem.id, org: '1' },
    ]);
  });

  it('migration BulkBuyerOrgs: down + up', async () => {
    const qr = (await db()).createQueryRunner();
    try {
      await new BulkBuyerOrgs1796600000000().down(qr);
      await new BulkBuyerOrgs1796600000000().up(qr);
    } finally {
      await qr.release();
    }
    expect(await count('bulk_buyer_orgs')).toBe(0);
  });
});

/*
 * Bulk Orders SKU list (2026-11-24, user: only the 540 "final to consider" SKUs, no others): master_skus.bulk_orderable;
 * loaded by npm run bulk:skus (the file IS the list), changed one by one in Masters > PEP SKUs > Edit.
 */
describe('bulk orders: only SKUs on the Bulk Orders list', () => {
  const now = () => new Date();
  let admin: TestLogin;
  beforeEach(async () => {
    admin = await loginAs('admin');
    await insert('master_skus', { pep_code: 'SKU_HIDDEN', brand_name: 'mCaffeine', product_name: 'Coffee Hidden Pack', mrp: 150, is_active: 1, bulk_orderable: 0, created_at: now(), updated_at: now() });
    await insert('master_skus', { pep_code: 'HYP_HIDDEN', brand_name: 'HYPHEN', product_name: 'Hyphen Hidden', mrp: 150, is_active: 1, bulk_orderable: 0, created_at: now(), updated_at: now() });
  });
  const skus = async (q: string, brand: string) =>
    ((await api().get(`${V}/skus`).query({ q, brand }).set('Cookie', mkt.cookie).expect(200)).body.data as { pepCode: string }[]).map((x) => x.pepCode);

  it('a SKU off the list is not searched, its brand not offered, and an order / edit / draft with it is refused', async () => {
    expect(await skus('coffee', 'mCaffeine')).toEqual(['SKU_A', 'SKU_B']);
    expect((await api().get(V).set('Cookie', mkt.cookie).expect(200)).body.meta.brands).toEqual(['mCaffeine']); // HYPHEN has only a hidden SKU
    const res = await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 1 }, { pepCode: 'SKU_HIDDEN', qty: 1 }] })).expect(400);
    expect(fields(res)).toEqual(['lines[1].pepCode']);
    expect(res.body.error.details[0].message).toBe('SKU_HIDDEN is not on the Bulk Orders SKU list: ask the masters team');
    const o = (await create(mkt, order()).expect(201)).body.data as { id: string };
    expect(fields(await edit(mkt, o.id, order({ lines: [{ pepCode: 'SKU_HIDDEN', qty: 1 }] })).expect(400))).toEqual(['lines[0].pepCode']);
  });

  it('Masters > PEP SKUs: the list shows it and Edit switches it (Yes / No, History row); the portal follows at once', async () => {
    const list = (await api().get('/api/v1/masters/pep-skus').set('Cookie', admin.cookie).expect(200)).body.data as { id: string; pepCode: string; bulkOrderable: boolean }[];
    const hidden = list.find((x) => x.pepCode === 'SKU_HIDDEN')!;
    expect(hidden.bulkOrderable).toBe(false);
    expect(list.find((x) => x.pepCode === 'SKU_A')!.bulkOrderable).toBe(true);
    await api().patch(`/api/v1/masters/edit/pep_sku/${hidden.id}`).set('Cookie', admin.cookie).send({ changes: { bulkOrderable: 'maybe' } }).expect(400);
    await api().patch(`/api/v1/masters/edit/pep_sku/${hidden.id}`).set('Cookie', admin.cookie).send({ changes: { bulkOrderable: 'Yes' }, original: { bulkOrderable: 'No' } }).expect(200);
    expect(await rows('SELECT bulk_orderable b FROM master_skus WHERE id = ?', [hidden.id])).toEqual([{ b: 1 }]);
    expect(await rows("SELECT field_name f, old_value o, new_value n FROM master_change_logs WHERE row_key = 'SKU_HIDDEN'")).toEqual([{ f: 'bulkOrderable', o: 'No', n: 'Yes' }]);
    expect(await skus('coffee', 'mCaffeine')).toEqual(['SKU_A', 'SKU_B', 'SKU_HIDDEN']);
  });

  it('loader (npm run bulk:skus): the file is the list (others OFF), empty brands filled, a different brand kept; dry run writes nothing', async () => {
    await insert('master_skus', { pep_code: 'SKU_ZERO', brand_name: '0', product_name: 'Coffee Zero Brand', mrp: 99, is_active: 1, created_at: now(), updated_at: now() });
    const file = [
      { pepCode: 'SKU_A', brand: 'mCaffeine' }, { pepCode: 'SKU_HIDDEN', brand: 'mCaffeine' }, { pepCode: 'SKU_ZERO', brand: 'mCaffeine' },
      { pepCode: 'HYP_HIDDEN', brand: 'mCaffeine' }, { pepCode: 'NOT_THERE', brand: 'mCaffeine' }, { pepCode: 'sku_a', brand: 'mCaffeine' },
    ];
    const dry = await loadBulkSkus(file, false, { id: null });
    expect(dry).toMatchObject({ listed: 4, on: ['SKU_HIDDEN', 'HYP_HIDDEN', 'SKU_ZERO'], notInMaster: ['NOT_THERE'], duplicates: ['sku_a'] });
    expect(dry.off).toEqual(expect.arrayContaining(['SKU_B', 'SKU_OFF', 'SKU_NOMRP']));
    expect(dry.brandFill).toEqual([{ pepCode: 'SKU_ZERO', brand: 'mCaffeine' }]);
    expect(dry.brandDiffers).toEqual([{ pepCode: 'HYP_HIDDEN', master: 'HYPHEN', file: 'mCaffeine' }]);
    expect(await rows("SELECT bulk_orderable b FROM master_skus WHERE pep_code IN ('SKU_HIDDEN', 'SKU_B') ORDER BY pep_code")).toEqual([{ b: 1 }, { b: 0 }]); // dry run: untouched (SKU_B on, SKU_HIDDEN off)
    await loadBulkSkus(file, true, { id: admin.userId });
    expect(await rows('SELECT pep_code p, bulk_orderable b, brand_name br FROM master_skus ORDER BY pep_code')).toEqual([
      { p: 'HYP_HIDDEN', b: 1, br: 'HYPHEN' }, { p: 'SKU_A', b: 1, br: 'mCaffeine' }, { p: 'SKU_B', b: 0, br: 'mCaffeine' },
      { p: 'SKU_HIDDEN', b: 1, br: 'mCaffeine' }, { p: 'SKU_NOMRP', b: 0, br: 'mCaffeine' }, { p: 'SKU_OFF', b: 0, br: 'mCaffeine' },
      { p: 'SKU_ZERO', b: 1, br: 'mCaffeine' },
    ]);
    expect(await skus('coffee', 'mCaffeine')).toEqual(['SKU_A', 'SKU_HIDDEN', 'SKU_ZERO']);
    expect((await loadBulkSkus(file, true, { id: admin.userId })).on).toEqual([]); // a re-run changes nothing
  });
});

/*
 * Bulk Orders Portal v2, piece 1g (2026-11-24, user "1G A"): drafts saved in the app (only their creator sees them;
 * empty fields allowed, wrong values still refused; Submit = every check + approval rules + the real number), the
 * "active" list filter, and the archive (closed orders not changed for 30 days leave the normal lists).
 */
describe('bulk orders v2: drafts, active filter, archive', () => {
  const T = '/api/v1/po-review/bulk-orders';

  it('a draft needs only its type: DRAFT-<id>, no number taken, only its creator sees it (not other people, not our team)', async () => {
    const d = (await create(mkt, { type: 'marketing', draft: true, receiverName: 'Asha', lines: [{ pepCode: 'SKU_A', qty: 2 }] }).expect(201)).body.data;
    expect(d).toMatchObject({ status: 'draft', poNumber: `DRAFT-${d.id}`, receiverName: 'Asha', orderedBy: '', lineCount: 1, payment: null });
    expect(await count('bulk_order_counters')).toBe(0);
    const mkt2 = await loginAs('bulk-marketing');
    for (const who of [mkt2, approver]) {
      await api().get(`${V}/${d.id}`).set('Cookie', who.cookie).expect(404);
      expect((await api().get(V).set('Cookie', who.cookie).expect(200)).body.meta.total).toBe(0);
    }
    expect((await api().get(V).set('Cookie', mkt.cookie).expect(200)).body.data.map((o: { id: string }) => o.id)).toEqual([d.id]);
    expect((await api().get(T).set('Cookie', opsExec.cookie).expect(200)).body.meta.total).toBe(0);
    await api().put(`${V}/${d.id}`).set('Cookie', mkt2.cookie).send({ draft: true }).expect(404);
    await api().post(`${V}/${d.id}/cancel`).set('Cookie', mkt2.cookie).send({}).expect(404);
    expect((await create(mkt, { draft: true }).expect(400)).body.error.details.map((x: { field: string }) => x.field)).toEqual(['type']);
    expect(fields(await create(mkt, { type: 'marketing', draft: true, receiverPhone: '12' }).expect(400))).toEqual(['receiverPhone']);
  });

  it('save again (no history row, no remark), then Submit: incomplete = every missing field, complete = real number + approval rules', async () => {
    const d = (await create(mkt, { type: 'marketing', draft: true }).expect(201)).body.data as { id: string };
    const again = (await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send({ draft: true, orderedBy: 'Brand team', lines: [{ pepCode: 'SKU_B', qty: 3 }] }).expect(200)).body.data;
    expect(again).toMatchObject({ status: 'draft', orderedBy: 'Brand team', lineCount: 1 });
    expect(again.events.map((e: { action: string }) => e.action)).toEqual(['created']);
    const missing = await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send({ orderedBy: 'Brand team', lines: [{ pepCode: 'SKU_B', qty: 3 }] }).expect(400);
    expect(fields(missing)).toEqual(expect.arrayContaining(['brand', 'receiverName', 'receiverPhone', 'address']));
    const sent = (await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send(order()).expect(200)).body.data;
    expect(sent).toMatchObject({ status: 'pending_approval', poNumber: `MKT-${YEAR}-0001` }); // this file's v1 setting: every order needs approval
    expect(sent.events.at(-1)).toMatchObject({ action: 'submitted', changes: { poNumber: `MKT-${YEAR}-0001` } });
    expect((await api().get(V).set('Cookie', approver.cookie).expect(200)).body.meta.total).toBe(1);
    // once sent it is a normal order: an edit needs a remark again
    expect(fields(await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send(order()).expect(400))).toEqual(['remark']);
    expect((await api().put(`${V}/${d.id}`).set('Cookie', mkt.cookie).send({ ...order(), draft: true }).expect(409)).body.error.code).toBe('BULK_ORDER_NOT_EDITABLE');
  });

  it('a draft can be discarded (cancel) by its creator', async () => {
    const d = (await create(mkt, { type: 'marketing', draft: true }).expect(201)).body.data as { id: string };
    expect((await api().post(`${V}/${d.id}/cancel`).set('Cookie', mkt.cookie).send({}).expect(200)).body.data.status).toBe('cancelled');
  });

  it('status=active = submitted + pending + approved; closed orders not changed for 30 days are only in the archive', async () => {
    const a = (await create(mkt, order()).expect(201)).body.data as { id: string };
    const b = (await create(mkt, order()).expect(201)).body.data as { id: string };
    const c = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await api().post(`${V}/${b.id}/reject`).set('Cookie', approver.cookie).send({ reason: 'No budget' }).expect(200);
    await api().post(`${V}/${c.id}/cancel`).set('Cookie', mkt.cookie).send({}).expect(200);
    const ids = async (q: string) => ((await api().get(`${V}?${q}`).set('Cookie', mkt.cookie).expect(200)).body.data as { id: string }[]).map((o) => o.id).sort();
    expect(await ids('status=active')).toEqual([a.id]);
    expect(await ids('')).toEqual([a.id, b.id, c.id].sort()); // closed today: still in the normal list
    await rows('UPDATE bulk_orders SET updated_at = NOW() - INTERVAL 31 DAY WHERE id IN (?, ?)', [b.id, a.id]);
    expect(await ids('')).toEqual([a.id, c.id].sort()); // the old OPEN one stays; the old closed one leaves
    expect(await ids('archived=1')).toEqual([b.id]);
    expect(await ids('archived=1&q=MKT')).toEqual([b.id]);
  });
});

/*
 * Bulk Orders Portal v2, piece 4 (2026-11-24): courier tracking from Uniware (read only). The channel PO sync reads the
 * bulk order's sale order (fake Uniware here); its packages fill AWB / courier / status / dates and move the order
 * Order placed -> Dispatched -> Delivered (never back), with a timeline row; nothing new = no row.
 */
describe('bulk orders v2: courier tracking from Uniware (sync)', () => {
  const T = '/api/v1/po-review/bulk-orders';
  const WH = 'MUM_WAREHOUSE2';
  let pkgs: Record<string, unknown>[] = [];
  const fakeUniware = { post: async <R,>(_path: string, body: unknown) => ({ saleOrderDTO: { code: (body as { code: string }).code, status: 'PROCESSING', saleOrderItems: [], shippingPackages: pkgs } }) as unknown as R };
  const placed = async () => {
    await insert('master_facilities', { code: WH, name: 'Bhiwandi', entity: 'PEP', state: 'Maharashtra', is_active: 1, intransit_type: 'MWH', source: 'manual', uniware_export: 0 });
    const o = (await create(mkt, order()).expect(201)).body.data as { id: string };
    await api().post(`${V}/${o.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200);
    await api().post(`${T}/${o.id}/process`).set('Cookie', opsExec.cookie).send({ facilityCode: WH, uniwareChannel: 'JIVA', customerCode: 'C1' }).expect(200);
    await rows('UPDATE po_uploads SET csv_downloaded_at = NOW()'); // the CSV went to Uniware: the sync reads it
    return o.id;
  };
  const one = async (id: string) => (await api().get(`${V}/${id}`).set('Cookie', mkt.cookie).expect(200)).body.data;
  const pkg = (over: Record<string, unknown>) => ({ code: 'SP1', status: 'PACKED', trackingNumber: null, shippingCourier: null, shippingProvider: null, courierStatus: null, trackingLink: null, dispatched: null, delivered: null, invoiceDisplayCode: null, items: {}, ...over });

  it('dispatched: AWB + courier + date + invoice saved, status Dispatched (timeline); the same answer again changes nothing', async () => {
    const id = await placed();
    pkgs = [pkg({ status: 'PACKED' })];
    await runPoSyncPass({ manual: true }, fakeUniware);
    expect(await one(id)).toMatchObject({ status: 'processing', tracking: null });
    pkgs = [pkg({ status: 'DISPATCHED', trackingNumber: 'AWB123', shippingCourier: 'Delhivery', courierStatus: 'In transit', trackingLink: 'https://track.example/AWB123', dispatched: Date.parse('2026-11-24T06:00:00Z'), invoiceDisplayCode: 'PEP/2627/HR/1' })];
    await runPoSyncPass({ manual: true }, fakeUniware);
    const d = await one(id);
    expect(d).toMatchObject({ status: 'dispatched', tracking: { awb: 'AWB123', courier: 'Delhivery', courierStatus: 'In transit', link: 'https://track.example/AWB123', invoiceCode: 'PEP/2627/HR/1', deliveredAt: null } });
    expect(new Date(d.tracking.dispatchedAt).toISOString()).toBe('2026-11-24T06:00:00.000Z');
    expect(d.events.at(-1)).toMatchObject({ action: 'tracking', changes: { status: ['processing', 'dispatched'], awb: 'AWB123' } });
    const events = d.events.length;
    await runPoSyncPass({ manual: true }, fakeUniware);
    expect((await one(id)).events).toHaveLength(events);
  });

  it('delivered when every live package is delivered (a cancelled one ignored); never goes back', async () => {
    const id = await placed();
    pkgs = [pkg({ code: 'SP1', status: 'DELIVERED', trackingNumber: 'A1', delivered: Date.parse('2026-11-26T10:00:00Z') }), pkg({ code: 'SP2', status: 'DISPATCHED', trackingNumber: 'A2' })];
    await runPoSyncPass({ manual: true }, fakeUniware);
    expect(await one(id)).toMatchObject({ status: 'dispatched', tracking: { awb: 'A1, A2', deliveredAt: null } });
    pkgs = [pkg({ code: 'SP1', status: 'DELIVERED', trackingNumber: 'A1', delivered: Date.parse('2026-11-26T10:00:00Z') }), pkg({ code: 'SP2', status: 'CANCELLED', trackingNumber: 'A2' })];
    await runPoSyncPass({ manual: true }, fakeUniware);
    const d = await one(id);
    expect(d).toMatchObject({ status: 'delivered', tracking: { awb: 'A1' } });
    expect(d.events.filter((e: { action: string }) => e.action === 'tracking').map((e: { changes: { status: string[] } }) => e.changes.status)).toEqual([['processing', 'dispatched'], ['dispatched', 'delivered']]);
    pkgs = [pkg({ status: 'DISPATCHED', trackingNumber: 'A1' })];
    await runPoSyncPass({ manual: true }, fakeUniware);
    expect((await one(id)).status).toBe('delivered');
  });
});

/*
 * Bulk Orders Portal v2, piece 3 (2026-11-24): notifications (bell always; email per event behind the switches in
 * Settings > Bulk Orders > Notifications) and Remind (the requester nudges our team: COPT people in Users & Roles).
 */
describe('bulk orders v2: notifications + remind', () => {
  let copt: TestLogin;
  const N = '/api/v1/bulk-orders/settings/notifications';
  // what the person RECEIVED (the bell also lists what was sent in their name: the requester's own "needs approval")
  const bell = async (who: TestLogin) => ((await api().get('/api/v1/notices').set('Cookie', who.cookie).expect(200)).body.data.items as { text: string; link: string | null; from: { id: number }; sent: boolean }[])
    .filter((n) => !n.sent).map(({ sent: _s, ...n }) => n);
  beforeEach(async () => {
    mailbox.sent.length = 0;
    copt = await loginAs('operations-executive');
    await rows("UPDATE users SET po_team = 'copt' WHERE id = ?", [copt.userId]);
    await rows("UPDATE bulk_type_settings SET approval_over_units = CASE order_type WHEN 'institutional' THEN NULL ELSE 100 END");
  });

  it('needs approval -> approvers: bell (portal bell readable) + email; not the requester, not our team', async () => {
    const o = (await create(mkt, order({ lines: [{ pepCode: 'SKU_A', qty: 150 }] })).expect(201)).body.data as { poNumber: string };
    expect((await bell(approver)).map((n) => n.text)).toEqual([expect.stringContaining(`${o.poNumber} (150 units) needs your approval`)]);
    expect((await bell(approver))[0].from.id).toBe(mkt.userId);
    expect(await bell(mkt)).toEqual([]);
    expect(await bell(copt)).toEqual([]);
    expect(mailbox.sent.map((m) => [m.to, m.subject])).toEqual([[[approver.email], `Bulk order ${o.poNumber} needs your approval`]]);
  });

  it('straight to the team -> COPT bell with the Bulk Orders tab link, no email; approve -> requester (bell + email) + team; reject -> requester with the reason', async () => {
    const s = (await create(mkt, order()).expect(201)).body.data as { poNumber: string };
    expect(await bell(copt)).toEqual([expect.objectContaining({ text: expect.stringContaining(`New bulk order ${s.poNumber}`), link: '/operations/po-review?tab=bulk' })]);
    expect(mailbox.sent).toEqual([]);
    const p = (await create(mkt, order({ mode: 'Porter' })).expect(201)).body.data as { id: string; poNumber: string };
    mailbox.sent.length = 0;
    await api().post(`${V}/${p.id}/approve`).set('Cookie', approver.cookie).send({}).expect(200);
    expect((await bell(mkt)).map((n) => n.text)).toEqual([expect.stringContaining(`${p.poNumber} was approved`)]);
    expect((await bell(copt)).map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining(`New bulk order ${p.poNumber}`)]));
    expect(mailbox.sent.map((m) => m.subject)).toEqual([`Bulk order ${p.poNumber} approved`]);
    const q = (await create(mkt, order({ mode: 'Porter' })).expect(201)).body.data as { id: string; poNumber: string };
    await api().post(`${V}/${q.id}/reject`).set('Cookie', approver.cookie).send({ reason: 'No budget this month' }).expect(200);
    expect((await bell(mkt)).map((n) => n.text)).toEqual(expect.arrayContaining([`Your bulk order ${q.poNumber} was rejected: No budget this month`]));
  });

  it('remind: not before 6 h, then bell + email to our team and a timeline row; again only after 6 h; never on a pending order', async () => {
    const o = (await create(mkt, order()).expect(201)).body.data as { id: string; poNumber: string; remindAt: string };
    expect(new Date(o.remindAt).getTime()).toBeGreaterThan(Date.now() + 5.9 * 3_600_000);
    expect((await api().post(`${V}/${o.id}/remind`).set('Cookie', mkt.cookie).send({}).expect(409)).body.error.code).toBe('BULK_REMIND_NOT_NOW');
    await rows('UPDATE bulk_orders SET created_at = NOW() - INTERVAL 7 HOUR WHERE id = ?', [o.id]);
    mailbox.sent.length = 0;
    await api().post(`${V}/${o.id}/remind`).set('Cookie', approver.cookie).send({}).expect(403); // the requester's type only
    const r = (await api().post(`${V}/${o.id}/remind`).set('Cookie', mkt.cookie).send({}).expect(200)).body.data;
    expect(r.events.at(-1)).toMatchObject({ action: 'reminded' });
    expect((await bell(copt)).map((n) => n.text)).toEqual(expect.arrayContaining([expect.stringContaining(`Reminder: bulk order ${o.poNumber}`)]));
    expect(mailbox.sent.map((m) => [m.to, m.subject])).toEqual([[[copt.email], `Reminder: bulk order ${o.poNumber} waiting to be placed`]]);
    await api().post(`${V}/${o.id}/remind`).set('Cookie', mkt.cookie).send({}).expect(409); // cooldown
    const p = (await create(mkt, order({ mode: 'Porter' })).expect(201)).body.data as { id: string };
    await rows('UPDATE bulk_orders SET created_at = NOW() - INTERVAL 7 HOUR WHERE id = ?', [p.id]);
    await api().post(`${V}/${p.id}/remind`).set('Cookie', mkt.cookie).send({}).expect(409); // pending approval
  });

  it('email switches (one place): admin only, checked; master OFF = bell only; one event OFF = that email only', async () => {
    const admin = await loginAs('admin');
    expect((await api().get(N).set('Cookie', admin.cookie).expect(200)).body.data).toEqual({ emails: true, approvalNeeded: true, decision: true, remind: true, payment: true });
    await api().get(N).set('Cookie', mkt.cookie).expect(403);
    await api().put(N).set('Cookie', admin.cookie).send({ emails: 'no' }).expect(400);
    await api().put(N).set('Cookie', admin.cookie).send({}).expect(400);
    expect((await api().put(N).set('Cookie', admin.cookie).send({ approvalNeeded: false }).expect(200)).body.data).toMatchObject({ emails: true, approvalNeeded: false, decision: true });
    await create(mkt, order({ mode: 'Porter' })).expect(201);
    expect(mailbox.sent).toEqual([]); // that email off
    expect(await bell(approver)).toHaveLength(1); // the bell still
    await api().put(N).set('Cookie', admin.cookie).send({ emails: false, approvalNeeded: true }).expect(200);
    await create(mkt, order({ mode: 'Porter' })).expect(201);
    expect(mailbox.sent).toEqual([]); // every email off
    expect(await bell(approver)).toHaveLength(2);
  });
});
