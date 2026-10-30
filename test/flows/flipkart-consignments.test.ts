import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flipkartConnector } from '../../src/modules/channel-api/flipkart/flipkart.connector';
import { consignmentToProcessed, parseBulkConsignments, parseConsignmentCsv } from '../../src/modules/channel-api/flipkart/consignments.parse';
import { storeRobotResult } from '../../src/modules/channel-api/flipkart/consignments.service';
import { runConnector } from '../../src/modules/channel-api/runner';
import { loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { clearS3, s3Objects } from '../helpers/fake-s3';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { BULK_HEAD, FSN, WAREHOUSE, fkBulk, fkCsv, fkRobot, fkSwitchOn, seedFlipkart } from '../helpers/flipkart';

/*
 * Flipkart scheduled consignments (2026-10-30): what the Seller Hub robot returns (fed in here: no browser) -> stored
 * in channel_pull_items -> the connector + the shared runner -> the same PO chain as every channel (S3 channel-api/...
 * /flipkart/<id>/ with the consignment CSV, sale order, review). Files as Flipkart gives them (columns by name).
 */

let m: Masters;
let admin: TestLogin;

const upload = async (id: string) => (await rows<{ status: string; source_system: string; po_number: string }>('SELECT status, source_system, po_number FROM po_uploads WHERE external_id = ?', [id]))[0];

beforeEach(async () => {
  await resetDb();
  clearS3();
  m = await seedMasters();
  admin = await loginAs('admin');
  await seedFlipkart(m);
});
afterAll(closeDb);

describe('reading Flipkart files (by column name)', () => {
  it('the Bulk Consignment File: one header per consignment (its category rows summed)', () => {
    const h = parseBulkConsignments(`${BULK_HEAD}\n205151813,2026-10-24 19:54:51,43,ulub_bts,776,,0,PICK_UP_SELLER_MARKED_RTD,PICK_UP,2026-10-31 10:00:00,2026-11-07 10:00:00,Grooming,BGM\n205151813,2026-10-24 19:54:51,43,ulub_bts,12,,0,PICK_UP_SELLER_MARKED_RTD,PICK_UP,2026-10-31 10:00:00,2026-11-07 10:00:00,MakeupFragrances,BGM\n`);
    expect(h.get('205151813')).toMatchObject({ warehouse: 'ulub_bts', createdOn: '2026-10-24', status: 'PICK_UP_SELLER_MARKED_RTD', promisedQty: 788 });
  });

  it('a consignment CSV: lines by FSN, qty sent, cost; a missing column is named, never guessed', () => {
    const { lines, missingColumns } = parseConsignmentCsv(fkCsv([{ qty: 749, cost: 74.85 }]));
    expect(lines).toEqual([expect.objectContaining({ fsn: FSN, skuId: 'Mcaf408_WB', qtySent: 749, cost: 74.85 })]);
    expect(missingColumns).toEqual([]);
    expect(parseConsignmentCsv('"Product Name","SKU Id"\n"x","y"\n').missingColumns).toEqual(['FSN', 'Quantity Sent', 'Cost Price']);
  });

  it('-> processed.json: PO number = consignment id, warehouse, PO date, lines priced at the cost', () => {
    const header = parseBulkConsignments(fkBulk([{ id: '205149516', qty: 749 }])).get('205149516')!;
    const po = consignmentToProcessed('205149516', { row: 'ID: 205149516', header, csv: fkCsv([{ qty: 749, cost: 74.85 }]) }, '2026-10-30');
    expect(po).toMatchObject({ channel_name: 'flipkart', po_number: '205149516', po_date: '2026-10-24', delivery_facility_code: WAREHOUSE, total_qty: 749, po_value: 56062.65 });
    expect(po.line_items[0]).toMatchObject({ channel_sku_code: FSN, qty: 749, landing_rate: 74.85, channel_mrp: '' });
  });
});

describe('storing what the robot read', () => {
  it('new consignments with their header; a failed CSV is not stored (fetched again next run); never stored twice', async () => {
    const r = await storeRobotResult(fkRobot([
      { id: '205149516', row: 'ID: 205149516', csv: fkCsv([{ qty: 10, cost: 74.85 }]) },
      { id: '205149999', row: 'ID: 205149999', csv: fkCsv([{ qty: 5, cost: 74.85 }]) },
      { id: '205150000', row: 'ID: 205150000', csv: null, error: 'download timed out' },
    ], fkBulk([{ id: '205149516', qty: 10 }])));
    expect(r).toMatchObject({ stored: 2, completed: 0, failed: [{ id: '205150000', error: 'download timed out' }] });
    const saved = await rows<{ external_id: string; status: string | null; warehouse: string | null }>('SELECT external_id, status, warehouse FROM channel_pull_items ORDER BY external_id');
    expect(saved).toEqual([
      { external_id: '205149516', status: 'PICK_UP_ORDER_REGISTERED', warehouse: WAREHOUSE },
      { external_id: '205149999', status: null, warehouse: null },
    ]);
    // the same consignment again: skipped; a later bulk file completes the one it did not list
    const again = await storeRobotResult(fkRobot([{ id: '205149516', row: 'x', csv: fkCsv([{ qty: 1, cost: 1 }]) }], fkBulk([{ id: '205149999', qty: 5 }])));
    expect(again).toMatchObject({ stored: 0, completed: 1 });
    expect(await count('channel_pull_items')).toBe(2);
    expect((await rows<{ warehouse: string }>("SELECT warehouse FROM channel_pull_items WHERE external_id = '205149999'"))[0].warehouse).toBe(WAREHOUSE);
  });
});

describe('the connector: the same chain as every channel', () => {
  it('a scheduled consignment -> PO + sale order, S3 channel-api/.../flipkart/<id>/ with its CSV; taken once', async () => {
    await fkSwitchOn(admin.userId);
    await storeRobotResult(fkRobot([{ id: '205149516', row: 'ID: 205149516', csv: fkCsv([{ qty: 10, cost: 74.85 }]) }], fkBulk([{ id: '205149516', qty: 10 }])));
    const { items } = await runConnector(flipkartConnector, { apply: true });
    expect(items).toEqual([expect.objectContaining({ externalId: '205149516', decision: 'ready', result: 'completed' })]);
    expect(await upload('205149516')).toMatchObject({ status: 'completed', source_system: 'flipkart_seller_hub', po_number: '205149516' });
    // the bucket's own prefix (test/ here) then the same layout as Amazon's: channel-api/FY<yy><yy>/<month>/<channel>/<id>/
    const keys = [...s3Objects('').keys()];
    expect(keys).toEqual(expect.arrayContaining([expect.stringMatching(/(^|\/)channel-api\/FY2627\/october\/flipkart\/205149516\/205149516\.csv$/)]));
    expect(keys.some((k) => k.endsWith('/flipkart/205149516/processed.json'))).toBe(true);
    // the original file on Processed / In Review = Flipkart's consignment CSV (it has the lines; api-raw.json has none)
    const file = (await rows<{ file_name: string; file_url: string; file_type: string }>("SELECT file_name, file_url, file_type FROM po_uploads WHERE external_id = '205149516'"))[0];
    expect(file).toMatchObject({ file_name: '205149516.csv', file_type: 'csv' });
    expect(file.file_url).toMatch(/\/flipkart\/205149516\/205149516\.csv$/);
    expect((await rows<{ taken_at: Date | null }>("SELECT taken_at FROM channel_pull_items WHERE external_id = '205149516'"))[0].taken_at).not.toBeNull();
    // the next run: not taken again
    const next = await runConnector(flipkartConnector, { apply: true });
    expect(next.items.filter((i) => i.result)).toEqual([]);
    expect(await count('po_uploads', 'external_id = ?', ['205149516'])).toBe(1);
  });

  it('checks like any channel: a price above our rate (+-Rs 1) goes to review', async () => {
    await fkSwitchOn(admin.userId);
    await storeRobotResult(fkRobot([{ id: '205114349', row: 'ID: 205114349', csv: fkCsv([{ qty: 6, cost: 79.85 }]) }], fkBulk([{ id: '205114349', qty: 6 }])));
    await runConnector(flipkartConnector, { apply: true });
    expect(await upload('205114349')).toMatchObject({ status: 'needs_review' });
    expect(await rows("SELECT issue_type FROM po_issues WHERE issue_type = 'PRICE_MISMATCH'")).toHaveLength(1);
  });

  it('waits without a status (not in the bulk file yet); a cancelled one is never taken; OFF = nothing taken', async () => {
    await storeRobotResult(fkRobot([
      { id: '205100001', row: 'ID: 205100001', csv: fkCsv([{ qty: 1, cost: 74.85 }]) },
      { id: '205100002', row: 'ID: 205100002', csv: fkCsv([{ qty: 1, cost: 74.85 }]) },
    ], fkBulk([{ id: '205100002', qty: 1, status: 'CANCELLED' }])));
    // OFF: the PO intake switch (never switched on)
    let run = await runConnector(flipkartConnector, { apply: true });
    expect(await count('po_uploads')).toBe(0);
    expect(run.items.map((i) => [i.externalId, i.decision])).toEqual([['205100001', 'waiting'], ['205100002', 'skipped']]);
    // ON, and the next robot run's bulk file lists it: taken
    await fkSwitchOn(admin.userId);
    await storeRobotResult(fkRobot([], fkBulk([{ id: '205100001', qty: 1 }])));
    run = await runConnector(flipkartConnector, { apply: true });
    expect(run.items.find((i) => i.externalId === '205100001')).toMatchObject({ decision: 'ready', result: 'completed' });
    expect(await upload('205100002')).toBeUndefined();
  });
});
