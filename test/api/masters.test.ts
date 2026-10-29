import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * Masters API (2026-10-28): lists, Add forms, Edit, switch on / off, History, Recent changes.
 * Who: lists need viewer on the master's page; add / edit / switch / form-options need the admin or developer role.
 * Every write must leave a master_change_logs row (History), and nothing is ever deleted.
 */
covers([
  'GET /masters/pep-skus', 'GET /masters/channel-skus', 'GET /masters/channel-customers', 'GET /masters/channel-locations', 'GET /masters/warehouses/pep',
  'GET /masters/form-options', 'POST /masters/pep-skus', 'POST /masters/channel-skus', 'POST /masters/channels', 'POST /masters/channel-locations',
  'PATCH /masters/edit/:type/:id', 'POST /masters/active/:type/:id', 'GET /masters/history/:type/:id', 'GET /masters/changes',
]);

const P = '/api/v1/masters';
let m: Masters;
let admin: TestLogin;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
});
afterAll(closeDb);

const LISTS = ['/pep-skus', '/channel-skus', '/channel-customers', '/channel-locations', '/warehouses/pep'];

describe('who may use the Masters API', () => {
  it('401 without a login, on every list', async () => {
    for (const path of LISTS) {
      const res = await api().get(P + path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('403 for a person with no role (no page access)', async () => {
    const nobody = await loginAs(null);
    for (const path of LISTS) expect((await api().get(P + path).set('Cookie', nobody.cookie)).status, path).toBe(403);
  });

  it('a Masters viewer (operations-executive) can read the lists but not add / edit / switch', async () => {
    const viewer = await loginAs('operations-executive');
    for (const path of LISTS) expect((await api().get(P + path).set('Cookie', viewer.cookie)).status, path).toBe(200);
    const refused = [
      api().get(`${P}/form-options`).set('Cookie', viewer.cookie),
      api().post(`${P}/pep-skus`).set('Cookie', viewer.cookie).send({}),
      api().patch(`${P}/edit/pep_sku/${m.pepSkuId}`).set('Cookie', viewer.cookie).send({ changes: { mrp: 1 } }),
      api().post(`${P}/active/pep_sku/${m.pepSkuId}`).set('Cookie', viewer.cookie).send({ active: false }),
    ];
    for (const res of await Promise.all(refused)) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MASTER_ADD_NOT_ALLOWED');
    }
    expect(await count('master_change_logs')).toBe(0);
  });

  it('a logged-out session is refused', async () => {
    expect((await api().post('/api/v1/auth/logout').set('Cookie', admin.cookie)).status).toBeLessThan(300);
    expect((await api().get(`${P}/pep-skus`).set('Cookie', admin.cookie)).status).toBe(401);
  });
});

describe('lists', () => {
  it('send every seeded row with its id and status', async () => {
    const get = async (path: string) => (await api().get(P + path).set('Cookie', admin.cookie).expect(200)).body as { data: Record<string, unknown>[]; meta: { total: number } };
    const pep = await get('/pep-skus');
    expect(pep.meta.total).toBe(1);
    expect(pep.data[0]).toMatchObject({ id: String(m.pepSkuId), pepCode: m.pepCode, mrp: 499, isActive: true });
    expect((await get('/channel-skus')).data[0]).toMatchObject({ id: String(m.channelSkuId), channelCode: m.channelCode, pepCode: m.pepCode, margin: 0.3, isActive: true });
    expect((await get('/channel-customers')).data[0]).toMatchObject({ id: m.channelId, displayName: 'BigBasket', channelType: 'B2B', locationCount: 1 });
    expect((await get('/channel-locations')).data[0]).toMatchObject({ id: String(m.locationId), locationCode: m.locationCode, facilityCode: m.facilityCode, city: 'Mumbai', isActive: true });
    expect((await get('/warehouses/pep')).data[0]).toMatchObject({ id: m.facilityId, facilityCode: m.facilityCode, locationCount: 1, inMaster: true });
  });
});

describe('Add forms', () => {
  const pepSku = {
    pepCode: 'MCAFF_TEST_NEW', productName: 'New test SKU', brand: 'mCaffeine', productType: 'SIMPLE', mrp: 299, gstTaxType: '18', eanCode: '8906000000024',
    hsnCode: '33049990', lengthMm: 10, widthMm: 10, heightMm: 10, weightG: 50, shelfLife: 365, isActive: true,
  };

  it('form-options lists channels, active warehouses and PEP SKUs', async () => {
    const res = await api().get(`${P}/form-options`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.data.channels).toEqual([{ id: m.channelId, name: 'BigBasket', active: true }]);
    expect(res.body.data.facilities.map((f: { code: string }) => f.code)).toEqual([m.facilityCode]);
    expect(res.body.data.pepSkus.map((s: { code: string }) => s.code)).toContain(m.pepCode);
  });

  it('adds a PEP SKU with a "created" History row and the remark', async () => {
    const res = await api().post(`${P}/pep-skus`).set('Cookie', admin.cookie).send({ ...pepSku, remark: 'new launch' }).expect(201);
    const [log] = await rows<{ action: string; record_id: string; remark: string; user_id: number; new_value: string }>(
      `SELECT action, record_id, remark, user_id, new_value FROM master_change_logs WHERE master_type = 'pep_sku'`);
    expect(log).toMatchObject({ action: 'created', record_id: String(res.body.data.id), remark: 'new launch', user_id: admin.userId });
    expect(log.new_value).toContain('mrp: 299');
  });

  it('refuses a PEP SKU with every problem listed at once, and a duplicate code; nothing written', async () => {
    const bad = await api().post(`${P}/pep-skus`).set('Cookie', admin.cookie).send({ ...pepSku, mrp: -1, eanCode: '12', productName: '' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['eanCode', 'mrp', 'productName']);
    const dup = await api().post(`${P}/pep-skus`).set('Cookie', admin.cookie).send({ ...pepSku, pepCode: m.pepCode.toLowerCase() }).expect(400);
    expect(dup.body.error.details[0]).toMatchObject({ field: 'pepCode', code: 'FIELD_ALREADY_EXISTS' });
    expect(await count('master_skus')).toBe(1);
    expect(await count('master_change_logs')).toBe(0);
  });

  it('maps a channel SKU; the same code is refused while the old row is active and allowed once it is switched off', async () => {
    const body = { channelId: m.channelId, channelCode: m.channelCode, pepCode: m.pepCode, productName: 'x', brand: 'mCaffeine', mrp: 499, marginPercent: 30, rateAfterMargin: 349.3, eanCode: '8906000000017' };
    const dup = await api().post(`${P}/channel-skus`).set('Cookie', admin.cookie).send(body).expect(400);
    expect(dup.body.error.details[0]).toMatchObject({ field: 'channelCode', code: 'FIELD_ALREADY_EXISTS' });
    await api().post(`${P}/active/channel_sku/${m.channelSkuId}`).set('Cookie', admin.cookie).send({ active: false }).expect(200);
    const ok = await api().post(`${P}/channel-skus`).set('Cookie', admin.cookie).send(body).expect(201);
    expect(ok.body.data.channel).toBe('BigBasket');
    const [row] = await rows<{ margin: string; pep_sku_id: number; is_active: number }>('SELECT margin, pep_sku_id, is_active FROM master_channel_skus WHERE id = ?', [ok.body.data.id]);
    expect(row).toMatchObject({ margin: '0.3000', pep_sku_id: m.pepSkuId, is_active: 1 });
  });

  it('refuses a channel SKU whose rate is above MRP or whose PEP code does not exist', async () => {
    const res = await api().post(`${P}/channel-skus`).set('Cookie', admin.cookie)
      .send({ channelId: m.channelId, channelCode: 'NEW-1', pepCode: 'NOPE', productName: 'x', brand: 'b', mrp: 100, marginPercent: 10, rateAfterMargin: 120, eanCode: '8906000000017' }).expect(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['pepCode', 'rateAfterMargin']);
  });

  it('adds a channel; a name / alias used by another channel is refused', async () => {
    const ok = await api().post(`${P}/channels`).set('Cookie', admin.cookie).send({ displayName: 'Test Channel', slug: 'test-channel', aliases: ['Test Channel'], isActive: true }).expect(201);
    expect(ok.body.data.displayName).toBe('Test Channel');
    const clash = await api().post(`${P}/channels`).set('Cookie', admin.cookie).send({ displayName: 'Other', slug: 'other', aliases: ['big basket'], isActive: true }).expect(400);
    expect(clash.body.error.details[0]).toMatchObject({ field: 'aliases', code: 'FIELD_ALREADY_EXISTS' });
  });

  it('adds a channel location served by an ACTIVE warehouse only', async () => {
    const body = {
      channelId: m.channelId, locationCode: 'WMS-NEW-FC', uniwareCustomerCode: 'C2', uniwareChannelCode: 'BB2', facilityCode: m.facilityCode, consigneeName: 'DC2',
      consigneeGstNumber: '27aaaci1234a1z5', consigneeState: 'Maharashtra', consigneePinCode: '400002', shippingAddress: 'a', billingAddress: 'b', buyerType: 'B2B',
      buyerGstNumber: '27AAACI1234A1Z5', buyerState: 'Maharashtra', buyerPinCode: '400002', tallyLedgerName: 'BB', appointmentChannel: 'Yes',
    };
    const ok = await api().post(`${P}/channel-locations`).set('Cookie', admin.cookie).send(body).expect(201);
    const [row] = await rows<{ consignee_gst_number: string; facility_id: number }>('SELECT consignee_gst_number, facility_id FROM details_channels WHERE id = ?', [ok.body.data.id]);
    expect(row).toMatchObject({ consignee_gst_number: '27AAACI1234A1Z5', facility_id: m.facilityId });
    await api().post(`${P}/active/facility/${m.facilityId}`).set('Cookie', admin.cookie).send({ active: false }).expect(200);
    const refused = await api().post(`${P}/channel-locations`).set('Cookie', admin.cookie).send({ ...body, locationCode: 'WMS-NEW-2' }).expect(400);
    expect(refused.body.error.details[0]).toMatchObject({ field: 'facilityCode', code: 'FIELD_NOT_FOUND' });
  });
});

describe('Edit', () => {
  const edit = (type: string, id: number, body: object) => api().patch(`${P}/edit/${type}/${id}`).set('Cookie', admin.cookie).send(body);

  it('saves only what changed, logs old -> new per field with the remark', async () => {
    const res = await edit('pep_sku', m.pepSkuId, { changes: { mrp: 549, productName: 'Test Coffee Body Scrub 100g' }, original: { mrp: 499 }, remark: 'price change' }).expect(200);
    expect(res.body.data.changed).toEqual(['mrp']);
    expect((await rows<{ mrp: string }>('SELECT mrp FROM master_skus WHERE id = ?', [m.pepSkuId]))[0].mrp).toBe('549.00');
    const logs = await rows('SELECT action, field_name, old_value, new_value, remark FROM master_change_logs');
    expect(logs).toEqual([{ action: 'field_changed', field_name: 'mrp', old_value: '499.00', new_value: '549', remark: 'price change' }]);
  });

  it('keeps keys locked and refuses unknown fields', async () => {
    const res = await edit('pep_sku', m.pepSkuId, { changes: { pepCode: 'X', foo: 1 } }).expect(400);
    expect(res.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'pepCode', code: 'FIELD_LOCKED' }), expect.objectContaining({ field: 'foo', code: 'FIELD_NOT_EDITABLE' }),
    ]));
    await edit('location', m.locationId, { changes: { locationCode: 'X' } }).expect(400);
    await edit('channel_sku', m.channelSkuId, { changes: { channelCode: 'X' } }).expect(400);
    await edit('facility', m.facilityId, { changes: { code: 'X' } }).expect(400);
    await edit('channel', m.channelId, { changes: { slug: 'x' } }).expect(400);
    expect(await count('master_change_logs')).toBe(0);
  });

  it('409 when someone else changed the field meanwhile, with what it is now; nothing saved', async () => {
    await edit('pep_sku', m.pepSkuId, { changes: { mrp: 520 }, original: { mrp: 499 } }).expect(200);
    const res = await edit('pep_sku', m.pepSkuId, { changes: { mrp: 530 }, original: { mrp: 499 } }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'MASTER_EDIT_CONFLICT', details: [{ field: 'mrp', now: '520.00' }] });
    expect((await rows<{ mrp: string }>('SELECT mrp FROM master_skus WHERE id = ?', [m.pepSkuId]))[0].mrp).toBe('520.00');
  });

  it('channel SKU margin is edited as a percent and stored as a fraction; a new PEP code sets pep_sku_id', async () => {
    await edit('channel_sku', m.channelSkuId, { changes: { marginPercent: 25 } }).expect(200);
    expect((await rows<{ margin: string }>('SELECT margin FROM master_channel_skus WHERE id = ?', [m.channelSkuId]))[0].margin).toBe('0.2500');
    const bad = await edit('channel_sku', m.channelSkuId, { changes: { pepCode: 'NOPE', rateAfterMargin: 9999 } }).expect(400);
    expect(bad.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['pepCode', 'rateAfterMargin']);
  });

  it('channel expiry days must be from <= to; location facility must exist and be active', async () => {
    const res = await edit('channel', m.channelId, { changes: { expiryDaysMin: 100 } }).expect(400);
    expect(res.body.error.details[0]).toMatchObject({ field: 'expiryDaysMin', code: 'FIELD_RANGE_REVERSED' });
    await edit('channel', m.channelId, { changes: { channelType: 'B2C', expiryDaysMax: 120 } }).expect(200);
    const loc = await edit('location', m.locationId, { changes: { facilityCode: 'NOPE' } }).expect(400);
    expect(loc.body.error.details[0]).toMatchObject({ field: 'facilityCode', code: 'FIELD_NOT_FOUND' });
  });

  it('same values -> nothing written; unknown row -> 404', async () => {
    const res = await edit('location', m.locationId, { changes: { city: 'Mumbai' } }).expect(200);
    expect(res.body.data.changed).toEqual([]);
    expect(await count('master_change_logs')).toBe(0);
    expect((await edit('pep_sku', 999999, { changes: { mrp: 1 } })).status).toBe(404);
  });
});

describe('switch on / off', () => {
  it('switches a row off and on again, logged each time, never deleted', async () => {
    const off = await api().post(`${P}/active/location/${m.locationId}`).set('Cookie', admin.cookie).send({ active: false, remark: 'closed DC' }).expect(200);
    expect(off.body.data).toEqual({ active: false, changed: true });
    const again = await api().post(`${P}/active/location/${m.locationId}`).set('Cookie', admin.cookie).send({ active: false }).expect(200);
    expect(again.body.data.changed).toBe(false);
    await api().post(`${P}/active/location/${m.locationId}`).set('Cookie', admin.cookie).send({ active: true }).expect(200);
    expect(await count('details_channels')).toBe(1);
    const logs = await rows<{ action: string; remark: string | null }>('SELECT action, remark FROM master_change_logs ORDER BY id');
    expect(logs).toEqual([{ action: 'deactivated', remark: 'closed DC' }, { action: 'activated', remark: null }]);
  });

  it('needs `active` as true / false', async () => {
    const res = await api().post(`${P}/active/pep_sku/${m.pepSkuId}`).set('Cookie', admin.cookie).send({}).expect(400);
    expect(res.body.error.details[0]).toMatchObject({ field: 'active', code: 'FIELD_REQUIRED' });
  });
});

describe('History and Recent changes', () => {
  it("a row's History lists its changes newest first, with who", async () => {
    await api().patch(`${P}/edit/pep_sku/${m.pepSkuId}`).set('Cookie', admin.cookie).send({ changes: { mrp: 550 } }).expect(200);
    await api().post(`${P}/active/pep_sku/${m.pepSkuId}`).set('Cookie', admin.cookie).send({ active: false }).expect(200);
    const viewer = await loginAs('operations-executive');
    const res = await api().get(`${P}/history/pep_sku/${m.pepSkuId}`).set('Cookie', viewer.cookie).expect(200);
    expect(res.body.data.map((h: { action: string }) => h.action)).toEqual(['deactivated', 'field_changed']);
    expect(res.body.data[1]).toMatchObject({ field: 'mrp', oldValue: '499.00', newValue: '550', byEmail: admin.email, type: 'pep_sku', from: 'masters' });
  });

  it('refuses an unknown master or a bad id; needs the page of that master', async () => {
    expect((await api().get(`${P}/history/nope/1`).set('Cookie', admin.cookie)).body.error.code).toBe('MASTER_HISTORY_BAD_REQUEST');
    expect((await api().get(`${P}/history/pep_sku/abc`).set('Cookie', admin.cookie)).status).toBe(400);
    const nobody = await loginAs(null);
    expect((await api().get(`${P}/history/pep_sku/${m.pepSkuId}`).set('Cookie', nobody.cookie)).status).toBe(403);
  });

  it('Recent changes: every master, filter by master, days 1-365', async () => {
    await api().patch(`${P}/edit/pep_sku/${m.pepSkuId}`).set('Cookie', admin.cookie).send({ changes: { mrp: 550 } }).expect(200);
    await api().patch(`${P}/edit/location/${m.locationId}`).set('Cookie', admin.cookie).send({ changes: { city: 'Thane' } }).expect(200);
    const all = await api().get(`${P}/changes`).set('Cookie', admin.cookie).expect(200);
    expect(all.body.data.map((h: { type: string }) => h.type).sort()).toEqual(['location', 'pep_sku']);
    const only = await api().get(`${P}/changes?type=location&days=30`).set('Cookie', admin.cookie).expect(200);
    expect(only.body.data).toHaveLength(1);
    expect(only.body.data[0]).toMatchObject({ rowKey: 'BigBasket | WMS-TEST-FC', field: 'city', newValue: 'Thane' });
    expect((await api().get(`${P}/changes?days=0`).set('Cookie', admin.cookie)).status).toBe(400);
  });
});
