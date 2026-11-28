import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { approveMargin } from '../helpers/margins';
import { covers } from '../helpers/routes';

/*
 * Masters bulk upload (2026-11-27): Channel SKUs, PEP SKUs, Channels, Channel locations, Warehouses (Update only); Add new / Update existing, one mode per file. The check runs every
 * row through the Add / Edit code and saves nothing; apply saves all or nothing; approvals as today (a new channel SKU
 * or a margin / rate change = a margin request on the Approvals page; other fields saved at once).
 */
covers(['GET /masters/bulk/:type/format', 'GET /masters/bulk/:type/current', 'POST /masters/bulk/:type/check', 'POST /masters/bulk/:type/apply']);

const V = '/api/v1/masters/bulk/channel_sku';
let m: Masters;
let admin: TestLogin;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

const addRow = (over: Record<string, string> = {}) => ({ channel: 'BigBasket', channelCode: 'BB-NEW-1', pepCode: m.pepCode, marginPercent: '30', ...over });
const check = (body: Record<string, unknown>, who = admin) => api().post(`${V}/check`).set('Cookie', who.cookie).send(body);
const apply = (body: Record<string, unknown>, who = admin) => api().post(`${V}/apply`).set('Cookie', who.cookie).send(body);
const requests = () => rows<{ kind: string; status: string; channel_code: string; new_margin: string | null; remark: string | null }>('SELECT kind, status, channel_code, new_margin, remark FROM margin_change_requests ORDER BY id');

describe('who may use it', () => {
  it('format + current for the page viewers; check + apply for its editors (as Add / Edit)', async () => {
    await api().get(`${V}/format`).expect(401);
    const exec = await loginAs('operations-executive'); // a viewer of Channel SKUs
    expect((await api().get(`${V}/format`).set('Cookie', exec.cookie).expect(200)).body.data.columns.add.map((c: { key: string }) => c.key))
      .toEqual(['channel', 'channelCode', 'pepCode', 'marginPercent', 'rateAfterMargin', 'mrp', 'productName', 'brand', 'eanCode', 'remark']);
    await api().get(`${V}/current`).set('Cookie', exec.cookie).expect(200);
    expect((await check({ mode: 'add', rows: [addRow()] }, exec).expect(403)).body.error.code).toBe('MASTER_ADD_NOT_ALLOWED');
    expect((await apply({ mode: 'add', rows: [addRow()] }, exec).expect(403)).body.error.code).toBe('MASTER_ADD_NOT_ALLOWED');
    await rows("UPDATE page_permissions SET access_level = 'editor' WHERE role = 'operations-executive' AND page_slug = '/masters/channel-skus'");
    const editor = await loginAs('operations-executive');
    await check({ mode: 'add', rows: [addRow()] }, editor).expect(200);
  });

  it('refused: Transfer Routes (own upload), a bad mode, no rows, too many rows', async () => {
    expect((await api().get('/api/v1/masters/bulk/transfer_route/format').set('Cookie', admin.cookie).expect(400)).body.error.code).toBe('MASTER_BULK_NOT_SUPPORTED');
    expect((await check({ mode: 'replace', rows: [addRow()] }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await check({ mode: 'add', rows: [] }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await check({ mode: 'add', rows: Array.from({ length: 5001 }, () => addRow()) }).expect(400)).body.error.code).toBe('MASTER_BULK_TOO_MANY');
  });
});

describe('Add new', () => {
  it('format: the lists the Excel drop-downs read (our channels, PEP codes) and the strict columns', async () => {
    const f = (await api().get(`${V}/format`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(f.lists).toMatchObject({ channels: ['BigBasket'], pepCodes: [m.pepCode] });
    expect(f.columns.add.find((c: { key: string }) => c.key === 'marginPercent')).toMatchObject({ type: 'decimal', min: 0, max: 100, required: true });
    expect(f.maxRows).toBe(5000);
  });

  it('check: every row checked like the Add form, empty cells filled from the PEP SKU, NOTHING saved', async () => {
    const plan = (await check({
      mode: 'add', fileName: 'bb_codes.xlsx', rows: [
        addRow(), // good: name, brand, MRP, EAN from the PEP SKU, rate = MRP x (1 - 30%)
        addRow({ channelCode: m.channelCode }), // already an active row of BigBasket
        addRow({ channelCode: 'BB-NEW-2', marginPercent: 'fifty' }), // not a number
        addRow({ channelCode: 'BB-NEW-3', pepCode: 'NOPE' }), // not our SKU
        addRow({ channel: 'Nowhere', channelCode: 'BB-NEW-4' }), // not our channel
        addRow({ channelCode: '' }), // required
        addRow({ channelCode: 'BB-NEW-1' }), // twice in the file
      ],
    }).expect(200)).body.data;
    expect(plan.counts).toMatchObject({ rows: 7, new: 1, error: 6, needsApproval: 1 });
    const [good, dup, nan, sku, ch, empty, twice] = plan.rows;
    expect(good).toMatchObject({ row: 2, action: 'new', needsApproval: true, errors: [] });
    expect(good.filled).toEqual(expect.arrayContaining(['Product name = Test Coffee Body Scrub 100g (from the PEP SKU)', 'MRP = 499 (from the PEP SKU)', 'Rate after margin = 349.3 (MRP x (1 - Margin %))']));
    expect(dup.errors.join(' ')).toMatch(/Channel SKU code/);
    expect(nan.errors).toContain('Margin %: "fifty" is not a number');
    expect(sku.errors.join(' ')).toMatch(/PEP code: "NOPE" is not in the list/);
    expect(ch.errors.join(' ')).toMatch(/Channel: "Nowhere" is not in the list/);
    expect(empty.errors).toContain('Channel SKU code: required');
    expect(twice.row).toBe(8);
    expect(twice.errors.length).toBeGreaterThan(0);
    // the check saved nothing
    expect(await count('margin_change_requests')).toBe(0);
    expect(await count('master_channel_skus')).toBe(1);
  });

  it('apply: a file with any problem saves NOTHING (422 with the plan); a clean file = one margin request per row, approved as today', async () => {
    const bad = (await apply({ mode: 'add', fileName: 'x.xlsx', rows: [addRow(), addRow({ channelCode: 'BB-NEW-2', marginPercent: '120' })] }).expect(422)).body.error;
    expect(bad.code).toBe('MASTER_BULK_HAS_ERRORS');
    expect(bad.details.counts).toMatchObject({ new: 1, error: 1 });
    expect(await count('margin_change_requests')).toBe(0);

    const ok = (await apply({ mode: 'add', fileName: 'bb_codes.xlsx', rows: [addRow(), addRow({ channelCode: 'BB-NEW-2', marginPercent: '25', remark: 'new listing' })] }).expect(200)).body.data;
    expect(ok.counts).toMatchObject({ new: 2, needsApproval: 2 });
    const r = await requests();
    expect(r.map((x) => [x.kind, x.status, x.channel_code])).toEqual([['add', 'pending_l1', 'BB-NEW-1'], ['add', 'pending_l1', 'BB-NEW-2']]);
    expect(r[1].remark).toBe('Bulk upload bb_codes.xlsx: new listing');
    // not in the master until approved (Approvals page, as an Add from the form)
    expect(await count('master_channel_skus')).toBe(1);
    const [{ id }] = await rows<{ id: string }>("SELECT id FROM margin_change_requests WHERE channel_code = 'BB-NEW-1'");
    await approveMargin(String(id));
    expect(await count('master_channel_skus', "channel_code = 'BB-NEW-1' AND is_active = 1")).toBe(1);
  });
});

describe('Update existing', () => {
  const current = async () => (await api().get(`${V}/current`).set('Cookie', admin.cookie).expect(200)).body.data.rows as Record<string, string>[];

  it('current data = the Update columns (margin as a percent, Active Yes / No)', async () => {
    expect(await current()).toEqual([expect.objectContaining({
      id: String(m.channelSkuId), channel: 'BigBasket', channelCode: m.channelCode, pepCode: m.pepCode, mrp: '499', marginPercent: '30', rateAfterMargin: '349.3', active: 'Yes',
    })]);
  });

  it('empty = keep; other fields saved at once (History); margin -> approval; Active No switches off; keys / unknown rows refused', async () => {
    const [cur] = await current();
    const plan = (await check({ mode: 'update', fileName: 'edit.xlsx', rows: [{ ...cur, productName: 'Coffee Scrub NEW', brand: '', marginPercent: '35' }] }).expect(200)).body.data;
    expect(plan.rows[0]).toMatchObject({ action: 'update', needsApproval: true, errors: [] });
    expect(plan.rows[0].changes.map((c: { field: string; old: string; value: string }) => [c.field, c.old, c.value])).toEqual([['productName', 'Test Coffee Body Scrub 100g', 'Coffee Scrub NEW'], ['marginPercent', '30', '35']]);
    expect((await rows<{ product_name: string }>('SELECT product_name FROM master_channel_skus'))[0].product_name).toBe('Test Coffee Body Scrub 100g');

    // an unknown row / the same row twice (then every copy is an error) / a key changed = errors; unchanged = same
    const p2 = (await check({ mode: 'update', rows: [cur, { ...cur, id: '999999' }, cur] }).expect(200)).body.data;
    expect(p2.rows.map((r: { action: string }) => r.action)).toEqual(['error', 'error', 'error']);
    expect(p2.rows[1].errors[0]).toMatch(/no such row/);
    expect(p2.rows[2].errors[0]).toMatch(/twice in the file/);
    expect((await check({ mode: 'update', rows: [cur] }).expect(200)).body.data.rows[0].action).toBe('same');
    const key = (await check({ mode: 'update', rows: [{ ...cur, channelCode: 'OTHER' }] }).expect(200)).body.data.rows[0];
    expect(key.errors[0]).toMatch(/Channel SKU code: cannot be changed here/);

    const done = (await apply({ mode: 'update', fileName: 'edit.xlsx', rows: [{ ...cur, productName: 'Coffee Scrub NEW', marginPercent: '35', active: 'No' }] }).expect(200)).body.data;
    expect(done.counts).toMatchObject({ update: 1, needsApproval: 1 });
    const [sku] = await rows<{ product_name: string; margin: string; is_active: number }>('SELECT product_name, margin, is_active FROM master_channel_skus');
    expect(sku).toMatchObject({ product_name: 'Coffee Scrub NEW', is_active: 0 });
    expect(Number(sku.margin)).toBe(0.3); // the margin waits for its approvals
    expect((await requests()).map((r) => [r.kind, r.new_margin])).toEqual([['edit', '0.3500']]);
    const hist = await rows<{ action: string; remark: string | null }>("SELECT action, remark FROM master_change_logs WHERE master_type = 'channel_sku' ORDER BY id");
    expect(hist.map((h) => h.action)).toEqual(expect.arrayContaining(['field_changed', 'deactivated']));
    expect(hist.every((h) => h.remark === 'Bulk upload edit.xlsx')).toBe(true);
  });
});

describe('the other masters (same engine)', () => {
  const B = '/api/v1/masters/bulk';
  const post = (type: string, what: 'check' | 'apply', body: Record<string, unknown>) => api().post(`${B}/${type}/${what}`).set('Cookie', admin.cookie).send(body);
  const currentOf = async (type: string) => (await api().get(`${B}/${type}/current`).set('Cookie', admin.cookie).expect(200)).body.data.rows as Record<string, string>[];
  const logs = (type: string) => rows<{ action: string; remark: string | null }>(`SELECT action, remark FROM master_change_logs WHERE master_type = '${type}' ORDER BY id`);

  it('PEP SKUs: Add checks every field like the form (duplicate code, GST from the list); apply adds them with History', async () => {
    const pep = (over: Record<string, string> = {}) => ({
      pepCode: 'MCAFF_NEW_1', productName: 'New scrub', brand: 'mCaffeine', productType: 'SIMPLE', mrp: '299', gstTaxType: '18', eanCode: '8906000000024',
      hsnCode: '33049990', lengthMm: '60', widthMm: '60', heightMm: '120', weightG: '110', shelfLife: '730', active: 'Yes', ...over,
    });
    const plan = (await post('pep_sku', 'check', { mode: 'add', rows: [pep(), pep({ pepCode: m.pepCode }), pep({ pepCode: 'MCAFF_NEW_2', gstTaxType: '7', shelfLife: '1.5' })] }).expect(200)).body.data;
    expect(plan.rows.map((r: { action: string }) => r.action)).toEqual(['new', 'error', 'error']);
    expect(plan.rows[1].errors.join(' ')).toMatch(/PEP code/);
    expect(plan.rows[2].errors).toEqual(expect.arrayContaining(['GST %: "7" is not in the list', 'Shelf life (days): "1.5" is not a whole number']));
    expect(await count('master_skus')).toBe(1);
    await post('pep_sku', 'apply', { mode: 'add', fileName: 'skus.xlsx', rows: [pep()] }).expect(200);
    expect(await count('master_skus', "pep_code = 'MCAFF_NEW_1' AND is_active = 1")).toBe(1);
    expect((await logs('pep_sku')).map((h) => [h.action, h.remark])).toEqual([['created', 'Bulk upload skus.xlsx']]);
  });

  it('PEP SKUs: Update = current data in form units, a changed MRP saved at once, Bulk orders Yes / No', async () => {
    const [cur] = await currentOf('pep_sku');
    expect(cur).toMatchObject({ id: String(m.pepSkuId), pepCode: m.pepCode, mrp: '499', gstTaxType: '18', shelfLife: '730', bulkOrderable: 'No', active: 'Yes' });
    const done = (await post('pep_sku', 'apply', { mode: 'update', fileName: 'skus.xlsx', rows: [{ ...cur, mrp: '549', bulkOrderable: 'Yes' }] }).expect(200)).body.data;
    expect(done.counts).toMatchObject({ update: 1, needsApproval: 0 });
    const [sku] = await rows<{ mrp: string; bulk_orderable: number }>('SELECT mrp, bulk_orderable FROM master_skus');
    expect([Number(sku.mrp), Number(sku.bulk_orderable)]).toEqual([549, 1]);
  });

  it('Channels: Add (slug rule, alias of another channel refused); Update type / expiry days (min above max refused)', async () => {
    const plan = (await post('channel', 'check', { mode: 'add', rows: [
      { displayName: 'Tata Cliq', slug: 'tata-cliq', aliases: 'TATA CLIQ, TataCliq', active: 'Yes' },
      { displayName: 'Other', slug: 'Bad Slug', aliases: 'big basket', active: 'Yes' },
    ] }).expect(200)).body.data;
    expect(plan.rows.map((r: { action: string }) => r.action)).toEqual(['new', 'error']);
    expect(plan.rows[1].errors.join(' ')).toMatch(/Slug/);
    expect(await count('master_channels', "display_name = 'Tata Cliq'")).toBe(0);
    const [cur] = await currentOf('channel');
    expect(cur).toMatchObject({ displayName: 'BigBasket', channelType: 'B2B', expiryDaysMin: '60', expiryDaysMax: '90' });
    expect((await post('channel', 'check', { mode: 'update', rows: [{ ...cur, expiryDaysMin: '95' }] }).expect(200)).body.data.rows[0].action).toBe('error');
    await post('channel', 'apply', { mode: 'update', rows: [{ ...cur, channelType: 'B2C', expiryDaysMin: '30' }] }).expect(200);
    const [ch] = await rows<{ channel_type: string; expiry_days_min: number }>('SELECT channel_type, expiry_days_min FROM master_channels');
    expect(ch).toMatchObject({ channel_type: 'B2C', expiry_days_min: 30 });
  });

  it('Channel locations: Add with the exact warehouse code; duplicate location refused; current data', async () => {
    const loc = (over: Record<string, string> = {}) => ({
      channel: 'BigBasket', locationCode: 'BB_NEW_DC', uniwareCustomerCode: 'CUST_NEW', uniwareChannelCode: 'BIGBASKET_TEST', facilityCode: m.facilityCode,
      consigneeName: 'BB DC', consigneeGstNumber: '27AAACI1234A1Z5', consigneeState: 'Maharashtra', consigneePinCode: '421302',
      shippingAddress: 'Bhiwandi', billingAddress: 'Bhiwandi', buyerType: 'B2B', buyerGstNumber: '27AAACI1234A1Z5', buyerState: 'Maharashtra',
      buyerPinCode: '421302', tallyLedgerName: 'BB Bhiwandi', appointmentChannel: 'Yes', ...over,
    });
    const plan = (await post('location', 'check', { mode: 'add', rows: [
      loc(), loc({ locationCode: 'BB_2', facilityCode: m.facilityCode.toLowerCase(), consigneePinCode: '12' }), loc({ locationCode: m.locationCode }),
    ] }).expect(200)).body.data;
    expect(plan.rows.map((r: { action: string }) => r.action)).toEqual(['new', 'error', 'error']);
    expect(plan.rows[1].errors).toEqual(expect.arrayContaining([`Warehouse: "${m.facilityCode.toLowerCase()}" is not in the list (exact spelling)`, 'Consignee pincode: 6 digits']));
    expect(plan.rows[2].errors.join(' ')).toMatch(/Location code/);
    await post('location', 'apply', { mode: 'add', rows: [loc()] }).expect(200);
    expect(await count('details_channels', "channel_location_code = 'BB_NEW_DC' AND is_active = 1")).toBe(1);
    const [cur] = (await currentOf('location')).filter((r) => r.locationCode === m.locationCode);
    expect(cur).toMatchObject({ channel: 'BigBasket', facilityCode: m.facilityCode, active: 'Yes' });
  });

  it('Warehouses: Update only (no Add form); a name change + switch off, the code locked', async () => {
    const f = (await api().get(`${B}/facility/format`).set('Cookie', admin.cookie).expect(200)).body.data;
    expect(f.modes).toEqual(['update']);
    expect(f.columns.add).toBeUndefined();
    expect((await post('facility', 'check', { mode: 'add', rows: [{ code: 'X' }] }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    const [cur] = await currentOf('facility');
    expect(cur).toMatchObject({ id: String(m.facilityId), code: m.facilityCode, name: 'Test warehouse', active: 'Yes' });
    expect((await post('facility', 'check', { mode: 'update', rows: [{ ...cur, code: 'OTHER' }] }).expect(200)).body.data.rows[0].errors[0]).toMatch(/Warehouse code: cannot be changed here/);
    await post('facility', 'apply', { mode: 'update', fileName: 'wh.xlsx', rows: [{ ...cur, name: 'Bhiwandi WH', active: 'No' }] }).expect(200);
    const [wh] = await rows<{ name: string; is_active: number }>('SELECT name, is_active FROM master_facilities');
    expect(wh).toMatchObject({ name: 'Bhiwandi WH', is_active: 0 });
    expect((await logs('facility')).map((h) => h.action)).toEqual(['field_changed', 'deactivated']);
  });
});
