import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OTHERS_CHANNEL, PEPIMS_FIELD_KIND, PEPIMS_LINE_FIELDS, PEPIMS_PO_FIELDS, PEPIMS_SYNC_STATE_KEY, PO_GROUP } from '../../src/constants';
import { env } from '../../src/config/env';
import { runPepimsSync } from '../../src/modules/pepims-sync/import.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';
import { covers } from '../helpers/routes';

covers(['GET /po-overview/pepims-sync', 'POST /po-overview/pepims-sync']);

/*
 * PEPIMS -> POST_FG import + sync (2026-11-16, step 2a). PEPIMS here = a small copy of its tables in the test MySQL
 * (postfg_test_pepims, env PEPIMS_SYNC_SOURCE_DB), with the columns the import reads. The import: dry run writes
 * nothing; --apply inserts PEPIMS POs with their uid / line ids, maps channel -> our channel + group + party name, keeps
 * text it cannot match, writes History (+ PEPIMS's log lines), links both sides; a re-run takes only PEPIMS changes
 * (ours changed later = ours stays); a PO we already have (channel + PO number) is linked, PEPIMS values win.
 */

const PEP = 'postfg_test_pepims';
type Conn = { query: (sql: string, params?: unknown[]) => Promise<unknown>; end: () => Promise<void> };
let pep: Conn;
let m: Masters;
let admin: TestLogin;

const connect = async (database?: string): Promise<Conn> => {
  const mysql = (await import('mysql2/promise')).default;
  return mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
    ...(database ? { database } : {}),
  });
};

const pepPo = (uid: number, o: Record<string, unknown>) => pep.query(
  'INSERT INTO shipment_orders (uid, entryDate, poDate, facility, channel, location, poNumber, totalUnits, statusActive, statusPlanning, statusWarehouse, statusLogistics, dispatchDate, currentAppointmentDate, appointmentRequestedDate, firstTransporter, orderNo1, deliveryType, invoiceValue, allAppointmentDate, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  [uid, '2026-11-01', o.poDate ?? '2026-11-01', o.facility ?? null, o.channel, o.location ?? null, o.poNumber, o.totalUnits ?? 10, 'Active', 'Confirmed',
    o.statusWarehouse ?? null, o.statusLogistics ?? null, o.dispatchDate ?? null, o.appt ?? null, o.apptRequested ?? null, o.transporter ?? null,
    o.orderNo1 ?? null, o.deliveryType ?? null, o.invoiceValue ?? null, o.allAppt ? JSON.stringify(o.allAppt) : null, '2026-11-01 10:00:00', o.updatedAt ?? '2026-11-01 10:00:00'],
);
const pepLine = (id: number, uid: number, o: Record<string, unknown>) => pep.query(
  'INSERT INTO sku_orders (id, srNo, skuName, skuCode, channelSkuCode, qty, gmv, poValue, updatedQty, updatedGmv, updatedPoValue, brandName, poNumber, shipmentOrderId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  [id, o.srNo ?? '1', 'Test scrub', o.skuCode, o.channelSkuCode ?? null, o.qty ?? 10, 4990, 3493, o.qty ?? 10, 4990, 3493, 'mCaffeine', o.poNumber, uid, '2026-11-01 10:00:00', o.updatedAt ?? '2026-11-01 10:00:00'],
);
const sync = (apply = true) => runPepimsSync({ apply });
const po = async (uid: number | string) => (await rows<Record<string, unknown>>('SELECT * FROM master_purchase_orders WHERE uid = ?', [uid]))[0];

beforeAll(async () => {
  const root = await connect();
  await root.query(`DROP DATABASE IF EXISTS \`${PEP}\``);
  await root.query(`CREATE DATABASE \`${PEP}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await root.end();
  pep = await connect(PEP);
  // PEPIMS's own shapes (dates as text, floats), only the columns these tests fill
  await pep.query("CREATE TABLE shipment_orders (uid int NOT NULL AUTO_INCREMENT PRIMARY KEY, entryDate varchar(255) NOT NULL, poDate varchar(255) NOT NULL, facility varchar(255), channel varchar(255), location varchar(255), poNumber varchar(255) NOT NULL UNIQUE, totalUnits int, statusActive varchar(255), statusPlanning varchar(255), statusWarehouse varchar(255), statusLogistics varchar(255), dispatchDate varchar(255), currentAppointmentDate varchar(255), appointmentRequestedDate varchar(255), firstTransporter varchar(255), orderNo1 varchar(255), deliveryType varchar(255), invoiceValue float, allAppointmentDate json, createdAt datetime NOT NULL, updatedAt datetime NOT NULL)");
  await pep.query("CREATE TABLE sku_orders (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, srNo varchar(255), skuName varchar(255), skuCode varchar(255), channelSkuCode varchar(255), qty int, gmv float, poValue float, updatedQty int, updatedGmv float, updatedPoValue float, brandName varchar(255) NOT NULL DEFAULT 'Unknown', poNumber varchar(255), shipmentOrderId int, createdAt datetime NOT NULL, updatedAt datetime NOT NULL)");
  await pep.query('CREATE TABLE logs (id int NOT NULL AUTO_INCREMENT PRIMARY KEY, messages json NOT NULL, createdBy int, shipmentOrderId int NOT NULL, createdAt datetime NOT NULL, updatedAt datetime NOT NULL)');
  await pep.query('CREATE TABLE users (id int NOT NULL PRIMARY KEY, name varchar(255), email varchar(255))');
  // every other column PEPIMS has, in PEPIMS's own types (dates as text, floats)
  const typeOf: Record<string, string> = { [PEPIMS_FIELD_KIND.DATE]: 'varchar(255)', [PEPIMS_FIELD_KIND.INT]: 'int', [PEPIMS_FIELD_KIND.DEC2]: 'float', [PEPIMS_FIELD_KIND.DEC3]: 'float', [PEPIMS_FIELD_KIND.JSON]: 'json', [PEPIMS_FIELD_KIND.TEXT]: 'text' };
  for (const [table, fields] of [['shipment_orders', PEPIMS_PO_FIELDS], ['sku_orders', PEPIMS_LINE_FIELDS]] as const) {
    const [have] = (await pep.query('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [PEP, table])) as [{ c: string }[]];
    const missing = Object.entries(fields).filter(([f]) => !have.some((h) => h.c === f));
    if (missing.length) await pep.query(`ALTER TABLE ${table} ${missing.map(([f, k]) => `ADD \`${f}\` ${typeOf[k]} NULL`).join(', ')}`);
  }
});
afterAll(async () => {
  await pep.query(`DROP DATABASE IF EXISTS \`${PEP}\``);
  await pep.end();
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
  for (const t of ['shipment_orders', 'sku_orders', 'logs', 'users']) await pep.query(`DELETE FROM ${t}`);
  m = await seedMasters();
  admin = await loginAs('admin');
  for (const [stage, value] of [['warehouse', 'Dispatched'], ['logistics', 'Delivered'], ['logistics', 'Dispatched']]) {
    await insert('master_shipment_statuses', { stage, value, sort_order: 1, is_active: 1, source: 'pepims' });
  }
  await insert('master_courier_partners', { code: 'Lets Transport- Train', partner: 'Lets Transport', mode: 'Train', is_active: 1, source: 'pepims' });
  // PEPIMS's data, as it is there (spellings and all)
  await pepPo(101, {
    channel: 'BigBasket', poNumber: 'BB-1', facility: m.facilityCode, location: m.locationCode, statusWarehouse: 'DISPATCHED', statusLogistics: 'Delivered',
    dispatchDate: '2026-11-03', appt: '2026-11-05', apptRequested: '2152-11-25', transporter: 'Lets Transport- Train ', orderNo1: 'sf_20261101001',
    deliveryType: 'Drop In', invoiceValue: 1234.5, allAppt: ['2026-11-04', '2026-11-05'],
  });
  await pepLine(9001, 101, { skuCode: m.pepCode, poNumber: 'BB-1' });
  await pepLine(9002, 101, { srNo: '2', skuCode: 'OTHER_SKU', poNumber: 'BB-1', qty: 4 });
  await pepPo(102, { channel: 'Jiya', poNumber: 'MKT-1', facility: 'Delhi Bijwasan' });
  await pepPo(103, { channel: 'IIT BOMBAY', poNumber: 'OTH-1' });
  await pepPo(104, { channel: 'Warehouse', poNumber: 'IT-1' });
  await pepPo(105, { channel: 'TestPO', poNumber: 'TEST-1' });
  const [me] = await rows<{ email: string }>('SELECT email FROM users WHERE id = ?', [admin.userId]);
  await pep.query('INSERT INTO users (id, name, email) VALUES (29, ?, ?), (56, ?, ?)', ['Admin Person', me.email, 'Warehouse Person', 'wh.person@example.com']);
  await pep.query("INSERT INTO logs (id, messages, createdBy, shipmentOrderId, createdAt, updatedAt) VALUES (1, CAST(? AS JSON), 29, 101, '2026-11-02 09:00:00', '2026-11-02 09:00:00'), (2, CAST(? AS JSON), 56, 101, '2026-11-03 09:00:00', '2026-11-03 09:00:00')",
    [JSON.stringify([{ change: 'Appointment Date changed from null to 2026-11-05' }]), JSON.stringify([{ change: 'Status (Warehouse) changed from Confirmed to Dispatched' }])]);
});

describe('PEPIMS import (first run)', () => {
  it('a dry run reads and plans everything, writes nothing', async () => {
    const r = await sync(false);
    expect(r).toMatchObject({ apply: false, read: 5, inserted: 4, linesInserted: 2, logsAdded: 2 });
    expect(r.skipped).toEqual(['TestPO / TEST-1']);
    expect(await count('master_purchase_orders')).toBe(0);
    expect(await count('pepims_sync_links')).toBe(0);
    expect(await count('app_state', 'state_key = ?', [PEPIMS_SYNC_STATE_KEY])).toBe(0);
  });

  it('--apply: PEPIMS uid + line ids, our channel / group / party name, cleaned text, links, History', async () => {
    const r = await sync();
    expect(r).toMatchObject({ inserted: 4, newUid: 0, linesInserted: 2, logsAdded: 2 });
    expect(r.byGroup).toEqual({ [PO_GROUP.CHANNEL]: 1, [PO_GROUP.MARKETING]: 1, [PO_GROUP.OTHERS]: 1, [PO_GROUP.INTERNAL_TRANSFER]: 1 });
    expect(r.unmatched.facility).toEqual({ 'Delhi Bijwasan': 1 });
    expect(r.junkDates).toEqual({ appointmentRequestedDate: 1 });

    const bb = await po(101);
    expect(bb).toMatchObject({
      channel: 'BigBasket', poNumber: 'BB-1', poGroup: 'Channel', partyName: null, importedFrom: 'pepims', facilityId: m.facilityId,
      locationId: String(m.locationId), statusWarehouse: 'Dispatched', firstTransporter: 'Lets Transport- Train', deliveryType: 'Drop in',
      orderNo1: 'sf_20261101001', appointmentRequestedDate: null,
    });
    expect(bb.firstTransporterId).not.toBeNull();
    expect(Number(bb.invoiceValue)).toBe(1234.5);
    expect(bb.allAppointmentDate).toEqual(['2026-11-04', '2026-11-05']);
    expect((await rows<{ id: string }>('SELECT id FROM details_purchase_orders WHERE shipmentOrderId = 101 ORDER BY id')).map((l) => String(l.id))).toEqual(['9001', '9002']);
    expect(await po(102)).toMatchObject({ channel: 'Bulk Marketing', poGroup: 'Marketing', partyName: 'Jiya', facility: 'Delhi Bijwasan', facilityId: null });
    expect(await po(103)).toMatchObject({ channel: OTHERS_CHANNEL.NAME, poGroup: 'Others', partyName: 'IIT BOMBAY' });
    expect(await po(104)).toMatchObject({ channel: OTHERS_CHANNEL.NAME, poGroup: 'Internal Transfer', partyName: 'Warehouse' });
    expect(await po(105)).toBeUndefined();

    expect(await count('pepims_sync_links')).toBe(4);
    expect(await count('pepims_sync_line_links')).toBe(2);
    const hist = await rows<{ action: string; remark: string; user_id: number | null }>('SELECT action, remark, user_id FROM shipment_logs WHERE shipment_uid = 101 ORDER BY id');
    expect(hist[0]).toMatchObject({ action: 'created' });
    expect(hist[0].remark).toContain('imported from PEPIMS (uid 101)');
    expect(hist[0].remark).toContain('appointmentRequestedDate "2152-11-25"');
    expect(hist.map((h) => h.remark).join(' | ')).toContain('PEPIMS: Appointment Date changed from null to 2026-11-05 (by Admin Person)');
    expect(hist.find((h) => h.remark.includes('Admin Person'))?.user_id).toBe(admin.userId); // PEPIMS user = our user by email
    expect(hist.find((h) => h.remark.includes('Warehouse Person'))?.user_id).toBeNull(); // not one of ours: name only

    // PO Overview shows them (no Uniware mark needed for imported POs)
    const list = await api().get('/api/v1/po-overview/shipments').set('Cookie', admin.cookie).expect(200);
    expect(list.body.meta.total).toBe(4);
    expect(await count('app_state', 'state_key = ?', [PEPIMS_SYNC_STATE_KEY])).toBe(1);
  });
});

describe('PEPIMS sync (later runs)', () => {
  it('a second run with nothing changed writes nothing (rows of the watermark second are read again, on purpose)', async () => {
    await sync();
    const logs = await count('shipment_logs');
    const r = await sync();
    expect(r).toMatchObject({ inserted: 0, linked: 0, updated: 0, unchanged: r.read - r.skipped.length, linesInserted: 0, logsAdded: 0, fieldChanges: 0 });
    expect(await count('shipment_logs')).toBe(logs);
  });

  it('takes what PEPIMS changed; a field ours changed later stays ours; new PEPIMS lines and log lines come too', async () => {
    await sync();
    // ours changed the dispatch date AFTER PEPIMS's change below
    await rows("UPDATE master_purchase_orders SET dispatchDate = '2026-11-09', updatedAt = '2026-11-20 10:00:00' WHERE uid = 101");
    await pep.query("UPDATE shipment_orders SET statusLogistics = 'Dispatched', dispatchDate = '2026-11-08', updatedAt = '2026-11-10 10:00:00' WHERE uid = 101");
    await pepLine(9003, 101, { srNo: '3', skuCode: 'NEW_SKU', poNumber: 'BB-1', qty: 2, updatedAt: '2026-11-10 10:00:00' });
    await pep.query("INSERT INTO logs (id, messages, createdBy, shipmentOrderId, createdAt, updatedAt) VALUES (3, CAST(? AS JSON), 56, 101, '2026-11-10 10:00:00', '2026-11-10 10:00:00')",
      [JSON.stringify([{ change: 'Status (Logistics) changed from Delivered to Dispatched' }])]);
    const r = await sync();
    expect(r).toMatchObject({ inserted: 0, updated: 1, linesInserted: 1, logsAdded: 1 });
    expect(r.conflictsKeptOurs).toEqual([{ uid: '101', field: 'dispatchDate', pepims: '2026-11-08', ours: '2026-11-09' }]);
    const bb = await po(101);
    expect(bb.statusLogistics).toBe('Dispatched');
    expect(String(bb.dispatchDate).slice(0, 10) === '2026-11-09' || (bb.dispatchDate as Date).toISOString?.().slice(0, 10) === '2026-11-09').toBe(true);
    expect(await count('details_purchase_orders', 'shipmentOrderId = 101')).toBe(3);
    expect(await count('shipment_logs', "shipment_uid = 101 AND field_name = 'statusLogistics' AND remark LIKE 'sync from PEPIMS%'")).toBe(1);
  });

  it('a PO we already have (same channel + PO number) is linked, not copied: PEPIMS values win, lines matched by SKU', async () => {
    const ours = await runPo(bigBasketPo(m, { po_number: 'BB-1' })); // our pipeline saved the same PO
    const r = await sync();
    expect(r).toMatchObject({ linked: 1, inserted: 3, linesLinked: 1, linesInserted: 1 });
    expect(await count('master_purchase_orders', "poNumber = 'BB-1'")).toBe(1);
    const row = await po(ours.po_uid!);
    expect(row).toMatchObject({ orderNo1: 'sf_20261101001', statusWarehouse: 'Dispatched', importedFrom: null });
    expect(await count('pepims_sync_links', 'po_uid = ? AND pepims_uid = 101', [ours.po_uid])).toBe(1);
    expect(await count('shipment_logs', "shipment_uid = ? AND remark = 'linked to PEPIMS uid 101'", [ours.po_uid])).toBe(1);
  });
});

describe('Sync from PEPIMS (PO Overview button, GET / POST /po-overview/pepims-sync)', () => {
  it('a page viewer sees the last run; only admin / developer may start one; a run imports and is recorded', async () => {
    const viewer = await loginAs('viewer');
    const before = await api().get('/api/v1/po-overview/pepims-sync').set('Cookie', viewer.cookie).expect(200);
    expect(before.body.data).toMatchObject({ running: false, ok: null, everyMinutes: 0, timerOn: false });
    const manager = await loginAs('operations-manager'); // editor on PO Overview, not admin / developer
    const refused = await api().post('/api/v1/po-overview/pepims-sync').set('Cookie', manager.cookie).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('NOT_A_USER_ADMIN');
    expect((await api().post('/api/v1/po-overview/pepims-sync').set('Cookie', viewer.cookie).send({})).status).toBe(403);

    const started = await api().post('/api/v1/po-overview/pepims-sync').set('Cookie', admin.cookie).send({}).expect(202);
    expect(started.body.data.state).toBe('started');
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      status = (await api().get('/api/v1/po-overview/pepims-sync').set('Cookie', admin.cookie).expect(200)).body.data as Record<string, unknown>;
      if (!status.running && status.finishedAt) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toMatchObject({ ok: true, error: null, summary: { read: 5, inserted: 4 } });
    expect(await count('master_purchase_orders', "importedFrom = 'pepims'")).toBe(4);
  });
});

describe('POST_FG -> PEPIMS (switch PEPIMS_SYNC_WRITE_BACK)', () => {
  const pepRow = async (sql: string, p: unknown[] = []) => ((await pep.query(sql, p)) as [Record<string, unknown>[]])[0];
  it('off (default): nothing is written to PEPIMS', async () => {
    await sync();
    await rows("UPDATE master_purchase_orders SET statusLogistics = 'Dispatched', updatedAt = '2030-01-01 00:00:00' WHERE uid = 101");
    const r = await sync();
    expect(r.writeBack).toBeNull();
    expect((await pepRow('SELECT statusLogistics FROM shipment_orders WHERE uid = 101'))[0].statusLogistics).toBe('Delivered');
  });

  it('on: our change goes to PEPIMS with a log line; a PO made in POST_FG is added to PEPIMS and linked; nothing twice', async () => {
    await sync();
    await rows("UPDATE master_purchase_orders SET statusLogistics = 'Dispatched', updatedAt = '2030-01-01 00:00:00' WHERE uid = 101");
    const own = await runPo(bigBasketPo(m, { po_number: 'OWN-1' }));
    env.pepimsSync.writeBack = true;
    try {
      const r = await sync();
      expect(r.writeBack).toMatchObject({ posUpdated: 1, fieldsWritten: 1, posAdded: 1, linesAdded: 1 });
      expect((await pepRow('SELECT statusLogistics FROM shipment_orders WHERE uid = 101'))[0].statusLogistics).toBe('Dispatched');
      const log = await pepRow('SELECT messages, createdBy FROM logs WHERE shipmentOrderId = 101 ORDER BY id DESC LIMIT 1');
      expect(JSON.stringify(log[0].messages)).toContain('statusLogistics changed from Delivered to Dispatched (POST_FG)');
      expect(log[0].createdBy).toBeNull();
      const [added] = await pepRow("SELECT uid, channel FROM shipment_orders WHERE poNumber = 'OWN-1'");
      expect(added.channel).toBe('BigBasket');
      expect(await count('pepims_sync_links', 'po_uid = ? AND pepims_uid = ?', [own.po_uid, added.uid])).toBe(1);
      // a second run writes nothing again
      const again = await sync();
      expect(again.writeBack).toMatchObject({ posUpdated: 0, posAdded: 0 });
      expect((await pepRow("SELECT COUNT(*) n FROM shipment_orders WHERE poNumber = 'OWN-1'"))[0].n).toBe(1);
    } finally {
      env.pepimsSync.writeBack = false;
    }
  });
});
