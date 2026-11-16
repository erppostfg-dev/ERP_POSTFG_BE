import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDevCopy } from '../../src/modules/pepims-sync/dev-copy.service';
import { loginAs } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { bigBasketPo, seedMasters, type Masters } from '../helpers/fixtures';
import { runPo } from '../helpers/po-flow';

/*
 * Dev -> prod copy (2026-11-16, step 2b). "Dev" here = postfg_test_dev (env DEV_COPY_SOURCE_DB), made from the test
 * database itself after a PO went through the real chain; then the test database plays prod: its PO work is removed
 * and the same PO comes back as PEPIMS's import (other uid, PEPIMS's sale order code). The copy must put dev's work on
 * prod's PO, add dev's missing user, keep the sale order counter ahead, write the code note once, and run again safely.
 */

const DEV = 'postfg_test_dev';
const T = 'mcaff_postfg_test';
type Conn = { query: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]>; end: () => Promise<void> };
let c: Conn;
let m: Masters;

const connect = async (): Promise<Conn> => {
  const mysql = (await import('mysql2/promise')).default;
  return mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD });
};
const PO_WORK = ['shipment_logs', 'po_issue_actions', 'po_issues', 'po_verifications', 'po_review_submissions', 'po_price_differences', 'po_uploads', 'details_purchase_orders', 'master_purchase_orders', 'sale_order_code_counter'];

beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.query(`DROP DATABASE IF EXISTS \`${DEV}\``);
  await c.end();
  await closeDb();
});

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  await loginAs('admin');
  // 1. dev's work: a PO through the real chain (PO, line, upload, History, sale order code)
  await runPo(bigBasketPo(m, { po_number: 'BB-DEV-1' }));
  // 2. dev = a copy of everything now + one person only dev has
  await c.query(`DROP DATABASE IF EXISTS \`${DEV}\``);
  await c.query(`CREATE DATABASE \`${DEV}\``);
  const [tables] = await c.query(`SELECT table_name t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`, [T]);
  for (const { t } of tables as { t: string }[]) {
    await c.query(`CREATE TABLE \`${DEV}\`.\`${t}\` LIKE \`${T}\`.\`${t}\``);
    await c.query(`INSERT INTO \`${DEV}\`.\`${t}\` SELECT * FROM \`${T}\`.\`${t}\``);
  }
  await c.query(`INSERT INTO \`${DEV}\`.users (id, email, name) VALUES (9901, 'only.dev@example.com', 'Only Dev')`);
  await c.query(`INSERT INTO \`${DEV}\`.user_roles (user_id, role) VALUES (9901, 'viewer')`);
  // 3. the test database plays prod: its PO work removed, the PO back as PEPIMS's import (other uid + code)
  await c.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of PO_WORK) await c.query(`DELETE FROM \`${T}\`.\`${t}\``);
  await c.query('SET FOREIGN_KEY_CHECKS = 1');
  await insert('master_purchase_orders', {
    uid: 7001, channel: 'BigBasket', poNumber: 'BB-DEV-1', poGroup: 'Channel', importedFrom: 'pepims', orderNo1: 'sf_20261101009',
    poDate: '2026-11-01', statusActive: 'Active', statusPlanning: 'Confirmed', createdAt: new Date(), updatedAt: new Date(),
  });
  await insert('details_purchase_orders', { id: 88001, shipmentOrderId: 7001, srNo: '1', skuCode: m.pepCode, qty: 10, poNumber: 'BB-DEV-1', createdAt: new Date(), updatedAt: new Date() });
});

describe('dev -> prod copy', () => {
  it('a dry run does the whole copy and keeps nothing', async () => {
    const r = await runDevCopy({ apply: false });
    expect(r).toMatchObject({ apply: false, posLinked: 1, posAdded: 0, saleCodeNotes: 1 });
    expect(r.usersAdded).toEqual(['only.dev@example.com']);
    expect(await count('po_uploads')).toBe(0);
    expect(await count('users', "email = 'only.dev@example.com'")).toBe(0);
  });

  it('--apply: dev work on prod\'s PO, the missing user + role, counter ahead, the code note; a second run adds nothing', async () => {
    const devCode = (await rows<{ c: string }>(`SELECT orderNo1 c FROM \`${DEV}\`.master_purchase_orders`))[0].c;
    const r = await runDevCopy({ apply: true });
    expect(r).toMatchObject({ posLinked: 1, posAdded: 0, saleCodeNotes: 1 });
    // the upload now points at prod's PO (the PEPIMS import), not at dev's uid
    const [u] = await rows<{ po_uid: string; status: string }>('SELECT po_uid, status FROM po_uploads');
    expect(u).toEqual({ po_uid: '7001', status: 'completed' });
    // dev's History moved onto it, plus the sale order code note
    expect(await count('shipment_logs', 'shipment_uid = 7001')).toBeGreaterThan(1);
    const notes = await rows<{ remark: string }>("SELECT remark FROM shipment_logs WHERE shipment_uid = 7001 AND remark LIKE 'dev (POST_FG) gave sale order code%'");
    expect(notes).toHaveLength(1);
    expect(notes[0].remark).toContain(devCode);
    expect(notes[0].remark).toContain('sf_20261101009');
    // the person only dev had, with their role
    const [added] = await rows<{ id: number }>("SELECT id FROM users WHERE email = 'only.dev@example.com'");
    expect(await count('user_roles', 'user_id = ? AND role = ?', [added.id, 'viewer'])).toBe(1);
    // the counter: prod never gives a code dev already gave
    const [dev] = await rows<{ s: number }>(`SELECT MAX(last_serial) s FROM \`${DEV}\`.sale_order_code_counter`);
    const [prod] = await rows<{ s: number }>('SELECT MAX(last_serial) s FROM sale_order_code_counter');
    expect(Number(prod.s)).toBeGreaterThanOrEqual(Number(dev.s));

    const logs = await count('shipment_logs');
    const again = await runDevCopy({ apply: true });
    expect(again.usersAdded).toEqual([]);
    expect(await count('po_uploads')).toBe(1);
    expect(await count('shipment_logs')).toBe(logs);
  });
});
