import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * D2C internal transfer routes in Masters (2026-11-03): the grid (viewer on /masters/warehouses) and the route edit
 * (admin / developer; codes + switch on / off in one call; every change in master_change_logs, type transfer_route).
 */
covers([
  'GET /masters/transfer-routes', 'PATCH /masters/transfer-routes/:id', 'GET /masters/transfer-routes/template',
  'POST /masters/transfer-routes/upload/preview', 'POST /masters/transfer-routes/upload/import',
]);

const P = '/api/v1/masters';
let m: Masters;
let admin: TestLogin;
let routeId: number;
let locationId: number;

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  const receiving = await insert('master_facilities', { code: 'TEST_WH2', name: 'Receiving', is_active: 1, source: 'manual', uniware_export: 0 });
  locationId = await insert('details_channels', {
    channel_id: m.channelId, channel_name: 'BigBasket', channel_location_code: 'TransferLoc', transfer_facility_id: receiving,
    transfer_po_prefix: 'TEST_PFX', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
  routeId = await insert('d2c_transfer_routes', {
    dispatch_facility_id: m.facilityId, location_id: locationId, uniware_channel_code: 'D2C_TRANSFER_TEST', customer_code: null,
    customer_name: 'PEP', vendor_code: null, is_active: 1,
  });
});
afterAll(closeDb);

describe('GET /masters/transfer-routes', () => {
  it('lists the route joined with sender, location, receiving facility, prefix and the missing flags', async () => {
    const res = await api().get(`${P}/transfer-routes`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      id: routeId, senderCode: m.facilityCode, locationId: String(locationId), channel: 'BigBasket', location: 'TransferLoc', receivingCode: 'TEST_WH2',
      poPrefix: 'TEST_PFX', uniwareChannelCode: 'D2C_TRANSFER_TEST', customerCode: null, vendorCode: null, isActive: true,
      missingVendor: true, missingCustomer: true, missingChannel: false,
    });
  });

  it('401 without a login, 403 without page access', async () => {
    expect((await api().get(`${P}/transfer-routes`)).status).toBe(401);
    const nobody = await loginAs(null);
    expect((await api().get(`${P}/transfer-routes`).set('Cookie', nobody.cookie)).status).toBe(403);
  });
});

describe('PATCH /masters/transfer-routes/:id', () => {
  const patch = (body: object, who = admin) => api().patch(`${P}/transfer-routes/${routeId}`).set('Cookie', who.cookie).send(body);

  it('changes codes and switches off in one call, each logged as transfer_route', async () => {
    const res = await patch({ changes: { customerCode: 'CUST_X', vendorCode: 'VEND_X', isActive: false }, original: { customerCode: null, vendorCode: null }, remark: 'from sheet' }).expect(200);
    expect(res.body.data.changed).toEqual(['customerCode', 'vendorCode', 'isActive']);
    const [r] = await rows<{ customer_code: string; vendor_code: string; is_active: number }>('SELECT customer_code, vendor_code, is_active FROM d2c_transfer_routes WHERE id = ?', [routeId]);
    expect(r).toMatchObject({ customer_code: 'CUST_X', vendor_code: 'VEND_X', is_active: 0 });
    const logs = await rows<{ field_name: string; row_key: string; remark: string }>(
      "SELECT field_name, row_key, remark FROM master_change_logs WHERE master_type = 'transfer_route' AND record_id = ? ORDER BY id", [routeId]);
    expect(logs.map((l) => l.field_name)).toEqual(['customerCode', 'vendorCode', 'is_active']);
    expect(logs[0].row_key).toBe(`${m.facilityCode} -> BigBasket | TransferLoc`);
    const history = await api().get(`${P}/history/transfer_route/${routeId}`).set('Cookie', admin.cookie).expect(200);
    expect(history.body.data).toHaveLength(3);
  });

  it('refuses locked / unknown fields, a stale original (409) and non-admins (403); nothing written', async () => {
    expect((await patch({ changes: { locationId: 5 } })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await patch({ changes: {} })).status).toBe(400);
    expect((await patch({ changes: { uniwareChannelCode: 'NEW' }, original: { uniwareChannelCode: 'OLD' } })).status).toBe(409);
    const viewer = await loginAs('operations-executive');
    expect((await patch({ changes: { vendorCode: 'V' } }, viewer)).status).toBe(403);
    expect((await api().patch(`${P}/transfer-routes/999999`).set('Cookie', admin.cookie).send({ changes: { vendorCode: 'V' } })).status).toBe(404);
    expect(await count('master_change_logs')).toBe(0);
  });
});

describe('Transfer routes upload (template, preview, import)', () => {
  const HEAD = 'Sender,Channel,Location,Uniware Channel,Customer Code,Customer Name,Vendor Code,Active';
  const send = (path: string, csv: string, who = admin, fields: Record<string, string> = {}) => {
    const req = api().post(`${P}/transfer-routes/upload/${path}`).set('Cookie', who.cookie);
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req.attach('file', Buffer.from(csv, 'utf8'), 'routes.csv');
  };
  let second: number;
  beforeEach(async () => {
    const kol = await insert('master_facilities', { code: 'TEST_WH3', name: 'Receiving 2', is_active: 1, source: 'manual', uniware_export: 0, allow_internal_transfer: 0 });
    second = await insert('details_channels', {
      channel_id: m.channelId, channel_name: 'BigBasket', channel_location_code: 'TransferLoc2', transfer_facility_id: kol,
      transfer_po_prefix: 'TEST_PFX2', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  });

  it('template: the header and one real route as the example', async () => {
    await api().patch(`${P}/transfer-routes/${routeId}`).set('Cookie', admin.cookie).send({ changes: { customerCode: 'C1', vendorCode: 'V1' } }).expect(200);
    const res = await api().get(`${P}/transfer-routes/template`).set('Cookie', admin.cookie).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')).toEqual([HEAD, `${m.facilityCode},BigBasket,TransferLoc,D2C_TRANSFER_TEST,C1,PEP,V1,Yes`, '']);
  });

  it('preview: change + new + no change; nothing written', async () => {
    const csv = [HEAD, `${m.facilityCode},BigBasket,TransferLoc,D2C_TRANSFER_TEST,,,VEND_1,`, `${m.facilityCode},bigbasket,transferloc2,D2C_NEW,CUST_2,,VEND_2,Yes`].join('\n');
    const before = await count('master_change_logs');
    const res = await send('preview', csv).expect(200);
    expect(res.body.data).toMatchObject({ canImport: true, added: 1, updated: 1, unchanged: 0, errors: 0, enable: ['TEST_WH1', 'TEST_WH3'] });
    expect(res.body.data.rows[0].changes).toEqual([{ field: 'vendorCode', old: null, value: 'VEND_1' }]);
    expect(await count('master_change_logs')).toBe(before);
    expect(await count('d2c_transfer_routes')).toBe(1);
  });

  it('import: saves every row in one go, logged; switches the receiving warehouse on', async () => {
    const csv = [HEAD, `${m.facilityCode},BigBasket,TransferLoc,D2C_TRANSFER_TEST,,,VEND_1,No`, `${m.facilityCode},BigBasket,TransferLoc2,D2C_NEW,CUST_2,New cust,VEND_2,`].join('\n');
    const res = await send('import', csv, admin, { remark: 'bulk' }).expect(201);
    expect(res.body.data).toMatchObject({ added: 1, updated: 1, switchedOn: expect.arrayContaining(['TEST_WH3']) });
    const all = await rows<{ location_id: number; uniware_channel_code: string; customer_code: string | null; customer_name: string; vendor_code: string; is_active: number }>(
      'SELECT location_id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active FROM d2c_transfer_routes ORDER BY id');
    expect(all).toMatchObject([
      { uniware_channel_code: 'D2C_TRANSFER_TEST', customer_code: null, customer_name: 'PEP', vendor_code: 'VEND_1', is_active: 0 },
      { location_id: second, uniware_channel_code: 'D2C_NEW', customer_code: 'CUST_2', customer_name: 'New cust', vendor_code: 'VEND_2', is_active: 1 },
    ]);
    const logs = await rows<{ master_type: string; action: string; remark: string }>('SELECT master_type, action, remark FROM master_change_logs ORDER BY id');
    expect(logs.every((l) => l.remark === 'bulk')).toBe(true);
    expect(logs.map((l) => `${l.master_type}:${l.action}`)).toEqual(expect.arrayContaining(['transfer_route:created', 'transfer_route:field_changed', 'transfer_route:deactivated', 'facility:field_changed']));
  });

  it('all or nothing: one bad row -> 422 with the row, nothing saved; a viewer is refused; a non-csv is refused', async () => {
    const csv = [HEAD, `${m.facilityCode},BigBasket,TransferLoc,D2C_TRANSFER_TEST,,,VEND_1,`, 'NOPE,BigBasket,TransferLoc2,X,,,,'].join('\n');
    const res = await send('import', csv).expect(422);
    expect(res.body.error.code).toBe('ROUTE_UPLOAD_INVALID');
    expect(res.body.error.details[0]).toMatchObject({ row: 3 });
    expect(await count('master_change_logs')).toBe(0);
    const viewer = await loginAs('operations-executive');
    expect((await send('preview', csv, viewer)).status).toBe(403);
    expect((await api().post(`${P}/transfer-routes/upload/preview`).set('Cookie', admin.cookie).attach('file', Buffer.from('x'), 'r.xlsx')).body.error.code).toBe('ROUTE_UPLOAD_FILE');
  });
});
