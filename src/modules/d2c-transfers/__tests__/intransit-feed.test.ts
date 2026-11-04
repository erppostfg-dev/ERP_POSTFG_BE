import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { D2C_TRANSFERS_FILE, FACILITY_GROUPS } from '../../../constants';
import { Context } from '../../intransit/context';
import { Cell, Frame, toNum } from '../../intransit/frame';
import { toCsv } from '../../intransit/sources/files';
import * as combined from '../../intransit/stages/combined-intransit';
import type { EntityManager } from 'typeorm';
import { buildFeedRows, FEED_COLUMNS, FeedFacts, FeedHeader, FeedInvoice, FeedLine, isLeftOut, testFacilitiesOf, writeTransferFeed } from '../intransit-feed';

/*
 * Phase 8 (plan d2c-internal-transfers 7.2 Option B), no database: the feed's buckets (not dispatched = allocated,
 * dispatched = per invoice dispatched - received until the GRN completes), the test-facility / draft exclusion, and the
 * feed read by combined-intransit (KOL_WAREHOUSE for our rows only, the tool wins over PEPIMS / Export-B2B rows of the
 * same reference, our inward POs not counted again from Purchase_Order.csv, no feed = output unchanged).
 */

const ASOF = '2026-11-05';
const SETTINGS = { testFacilities: ['TEST_FACILITY'] };

const head = (o: Partial<FeedHeader> & { uid: string; transferCode: string }): FeedHeader => ({
  poNumber: `REF-${o.uid}`, facility: 'GGN_WAREHOUSE', channel: 'McaffeineB2C', location: 'Kolkata3', receiving: 'mCaff_Kolkata3', stage: 'sale_order',
  soState: 'created', entryDate: '2026-11-04', poDate: '2026-11-04', brandName: 'mCaffeine', statusPlanning: 'Confirmed', statusWarehouse: 'Confirmed',
  statusLogistics: null, dispatchDate: null, ...o,
});
const line = (o: Partial<FeedLine> & { shipmentOrderId: string; skuCode: string }): FeedLine => ({
  srNo: '1', skuName: `name ${o.skuCode}`, channelSkuCode: o.skuCode, qty: 10, updatedQty: 10, dispatchedQty: 0, allocatedQty: 0, gmv: 100,
  poValue: 15, updatedGmv: 100, updatedPoValue: 15, brandName: 'mCaffeine', ...o,
});
const invoice = (o: Partial<FeedInvoice> & { poUid: string }): FeedInvoice => ({
  inwardPoCode: null, inwardPoState: null, packageStatus: 'DISPATCHED', dispatchedAt: '2026-11-04 10:00:00', grnCompletedAt: null, skuQty: {}, ...o,
});

const objects = (rows: string[][]) => rows.slice(1).map((r) => Object.fromEntries(FEED_COLUMNS.map((c, i) => [c, r[i]])));
const counted = (rows: string[][]) => objects(rows).filter((r) => r.Source === 'D2C_Transfers');
const units = (rows: Record<string, string>[]) => rows.reduce((s, r) => s + Number(r['final Intransit units']), 0);

/** Transfer 1, partly dispatched: line A 10 (6 on invoice 1 with an inward PO, 4 still allocated), line B 5 allocated. */
const partly: FeedFacts = {
  headers: [head({ uid: '1', transferCode: 'IT-2627-11-001', poNumber: 'mCaff_Kolkata3|04Nov2026|Int13', stage: 'partly_dispatched' })],
  lines: [
    line({ shipmentOrderId: '1', skuCode: 'SKU_A', srNo: '1', qty: 10, updatedQty: 10, dispatchedQty: 6, allocatedQty: 4 }),
    line({ shipmentOrderId: '1', skuCode: 'SKU_B', srNo: '2', qty: 5, updatedQty: 5, dispatchedQty: 0, allocatedQty: 5 }),
  ],
  invoices: [invoice({
    poUid: '1', inwardPoCode: 'erp_it_20261104001-1', inwardPoState: 'created', skuQty: { SKU_A: { dispatched: 6, inward: 6, received: 0 } },
  })],
};

describe('feed buckets', () => {
  it('partly dispatched: allocated rest + the dispatched invoice, never the line twice', () => {
    const rows = buildFeedRows(partly, SETTINGS, ASOF);
    expect(rows[0]).toEqual([...FEED_COLUMNS]);
    const c = counted(rows);
    const a = c.filter((r) => r['SKU Code'] === 'SKU_A');
    expect(a.map((r) => [r['Final Status'], r['final Intransit units'], r['Final Planning Units'], r['PO Number (Inward)']])).toEqual([
      ['Working', '4', '4', ''],
      ['PO Created', '6', '6', 'erp_it_20261104001-1'],
    ]);
    expect(units(a)).toBe(10);
    expect(units(c)).toBe(15);
    expect(c.every((r) => r.Facility === 'GGN_WAREHOUSE' && r.Channel === 'McaffeineB2C' && r.Location === 'Kolkata3' && r['PO Number'] === 'mCaff_Kolkata3|04Nov2026|Int13')).toBe(true);
    // one reference row per transfer, no units
    expect(objects(rows).filter((r) => r.Source === 'D2C_Transfers_Ref').map((r) => [r['PO Number'], r['final Intransit units']])).toEqual([['mCaff_Kolkata3|04Nov2026|Int13', '0']]);
  });

  it('not dispatched = allocatedQty (not the balance); RTS by stage; balance in Final Planning Units', () => {
    const facts: FeedFacts = {
      headers: [head({ uid: '2', transferCode: 'IT-2', stage: 'ready_to_ship' })],
      lines: [line({ shipmentOrderId: '2', skuCode: 'S', qty: 10, updatedQty: 10, allocatedQty: 3 })],
      invoices: [],
    };
    const [r] = counted(buildFeedRows(facts, SETTINGS, ASOF));
    expect([r['Final Status'], r['final Intransit units'], r['Final Planning Units']]).toEqual(['RTS', '3', '10']);
  });

  it('no sale order yet: nothing counted, only the reference row', () => {
    const facts: FeedFacts = { headers: [head({ uid: '3', transferCode: 'IT-3', soState: 'failed' })], lines: [line({ shipmentOrderId: '3', skuCode: 'S', allocatedQty: 5 })], invoices: [] };
    const rows = buildFeedRows(facts, SETTINGS, ASOF);
    expect(counted(rows)).toHaveLength(0);
    expect(objects(rows)).toHaveLength(1);
  });

  it('dispatched without an inward PO = Intransit; partly received = dispatched - received; GRN-complete and cancelled packages = nothing', () => {
    const facts: FeedFacts = {
      headers: [head({ uid: '4', transferCode: 'IT-4', stage: 'dispatched' })],
      lines: [line({ shipmentOrderId: '4', skuCode: 'S', qty: 20, updatedQty: 20, dispatchedQty: 20, allocatedQty: 0 })],
      invoices: [
        invoice({ poUid: '4', skuQty: { S: { dispatched: 5, inward: 0, received: 0 } } }),
        invoice({ poUid: '4', inwardPoCode: 'P-2', inwardPoState: 'created', skuQty: { S: { dispatched: 5, inward: 5, received: 3 } } }),
        invoice({ poUid: '4', inwardPoCode: 'P-3', inwardPoState: 'created', grnCompletedAt: '2026-11-04', skuQty: { S: { dispatched: 5, inward: 5, received: 4 } } }),
        invoice({ poUid: '4', packageStatus: 'CANCELLED', skuQty: { S: { dispatched: 5, inward: 0, received: 0 } } }),
        invoice({ poUid: '4', dispatchedAt: null, packageStatus: 'PACKED', skuQty: { S: { dispatched: 0, inward: 0, received: 0 } } }),
      ],
    };
    const c = counted(buildFeedRows(facts, SETTINGS, ASOF));
    expect(c.map((r) => [r['Final Status'], r['final Intransit units'], r['PO Number (Inward)']])).toEqual([['Intransit', '5', ''], ['PO Created', '2', 'P-2']]);
  });

  it('cancelled / closed / draft transfers: no units (closed and cancelled keep their reference row; drafts nothing)', () => {
    const facts: FeedFacts = {
      headers: [
        head({ uid: '5', transferCode: 'IT-5', stage: 'closed', poNumber: 'R5' }),
        head({ uid: '6', transferCode: 'IT-6', stage: 'cancelled', poNumber: 'R6' }),
        head({ uid: '7', transferCode: 'IT-7', stage: 'draft', poNumber: 'R7', soState: null }),
      ],
      lines: ['5', '6', '7'].map((u) => line({ shipmentOrderId: u, skuCode: 'S', allocatedQty: 5 })),
      invoices: [invoice({ poUid: '5', skuQty: { S: { dispatched: 5, inward: 0, received: 0 } } })],
    };
    const rows = buildFeedRows(facts, SETTINGS, ASOF);
    expect(counted(rows)).toHaveLength(0);
    expect(objects(rows).map((r) => r['PO Number'])).toEqual(['R5', 'R6']);
  });

  it('test transfers never emitted: sender or receiver a test facility (any case), TEST_FACILITY always', () => {
    const tests = testFacilitiesOf({ testFacilities: ['Test_Recv'] });
    expect(tests.has('TEST_FACILITY')).toBe(true);
    expect(isLeftOut({ stage: 'sale_order', facility: 'test_facility', receiving: 'X' }, tests)).toBe(true);
    expect(isLeftOut({ stage: 'sale_order', facility: 'GGN_WAREHOUSE', receiving: 'TEST_RECV' }, tests)).toBe(true);
    expect(isLeftOut({ stage: 'sale_order', facility: 'GGN_WAREHOUSE', receiving: 'mCaff_Kolkata3' }, tests)).toBe(false);
    const facts: FeedFacts = {
      headers: [head({ uid: '8', transferCode: 'IT-8', facility: 'TEST_FACILITY', receiving: 'Mcaff_Nagpur', poNumber: 'Mcaff_Nagpur|03Nov2026|Int37' })],
      lines: [line({ shipmentOrderId: '8', skuCode: 'TEST_UNICOM1', allocatedQty: 1 })],
      invoices: [invoice({ poUid: '8', inwardPoCode: 'erp_it_TEST-1', inwardPoState: 'created', skuQty: { TEST_UNICOM1: { dispatched: 1, inward: 1, received: 0 } } })],
    };
    expect(buildFeedRows(facts, SETTINGS, ASOF)).toEqual([[...FEED_COLUMNS]]);
  });

  it('transfers entered after the as-of day are not in its feed', () => {
    const facts: FeedFacts = { ...partly, headers: [{ ...partly.headers[0], entryDate: '2026-11-06' }] };
    expect(buildFeedRows(facts, SETTINGS, ASOF)).toHaveLength(1);
  });
});

// ---- combined-intransit with the feed (synthetic) -------------------------------------------------------------------

const TARGET = combined.COMBINED_TARGET_COLS;
const targetRow = (o: Record<string, Cell>): Cell[] => TARGET.map((c) => o[c] ?? '');

const PO_HEADER = ['PO Code', 'Created', 'Delivery Date', 'Item Type Name', 'Item SkuCode', 'Order Quantity', 'Recieved Quantity', 'Facility', 'Total',
  'Purchase Order Status', 'Reference No', 'ReferenceOrder'];
const poRow = (code: string, sku: string, qty: number, facility: string, status = 'CREATED') =>
  [code, '2026-11-04', '2026-11-10', sku, sku, String(qty), '0', facility, String(qty), status, '', ''];

/** A context with PEPIMS rows (not found in Export-B2B), Export-B2B rows and Purchase_Order.csv; the feed optional. */
const contextWith = (feed: string[][] | null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2c-feed-'));
  fs.writeFileSync(path.join(dir, 'Purchase_Order.csv'), toCsv([
    PO_HEADER,
    poRow('erp_it_20261104001-1', 'SKU_A', 6, 'mCaff_Kolkata3'), // our inward PO: counted by the feed, not here
    poRow('erp_it_20261104009-1', 'SKU_Z', 2, 'mCaff_Kolkata3'), // any code of our SO prefix (e.g. a fully received one)
    poRow('PO-OTHER', 'SKU_C', 4, 'mCaff_Kolkata3'),
    poRow('PO-CLOSED', 'SKU_C', 9, 'mCaff_Kolkata3', 'COMPLETE'),
  ]));
  if (feed) fs.writeFileSync(path.join(dir, D2C_TRANSFERS_FILE), toCsv(feed));
  const ctx = new Context({ inputDir: dir, templateXlsx: '', outputDir: dir, asOf: ASOF, facilityGroups: FACILITY_GROUPS }, () => undefined);
  const nf = Frame.fromRows(TARGET, [
    // PEPIMS row of a reference our tool holds: the tool's rows count instead
    targetRow({ 'PO Number': 'mCaff_Kolkata3|04Nov2026|Int13', Facility: 'GGN_WAREHOUSE', Channel: 'McaffeineB2C', Location: 'Kolkata3', 'SKU Code': 'SKU_A', 'Channel SKU Code': 'SKU_A', 'Final Status': 'Intransit', 'final Intransit units': 10, 'Final Planning Units': 10 }),
    targetRow({ 'PO Number': 'PEPIMS|1', Facility: 'GGN_WAREHOUSE', Channel: 'McaffeineB2C', Location: 'Kolkata3', 'SKU Code': 'SKU_C', 'Channel SKU Code': 'SKU_C', 'Final Status': 'Intransit', 'final Intransit units': 7, 'Final Planning Units': 7 }),
    // PEPIMS transfer TO KOL_WAREHOUSE: still not counted (KOL_WAREHOUSE only for our transfers)
    targetRow({ 'PO Number': 'PEPIMS|2', Facility: 'mCaff_Kolkata3', Channel: 'KOL_WAREHOUSE', Location: 'Kolkata_MH', 'SKU Code': 'SKU_C', 'Channel SKU Code': 'SKU_C', 'Final Status': 'Intransit', 'final Intransit units': 9, 'Final Planning Units': 9 }),
  ]).drop(['Source']);
  ctx.set('df_po_not_found', nf);
  ctx.set('df_b2b_intransit', Frame.fromRows(['Display Order Code', 'Item SKU Code', 'Channel Product ID', 'Final Status', 'final Intransit units', 'Final Planning Units'], [
    ['mCaff_Kolkata3|04Nov2026|Int13', 'SKU_B', 'SKU_B', 'Working', 5, 5], // Export-B2B row of our SO (same reference): dropped
    ['PEPIMS|3', 'SKU_C', 'SKU_C', 'Working', 3, 3],
  ]));
  ctx.set('df_intransit_stock_v2', Frame.fromRows(TARGET, [
    targetRow({ 'PO Number': 'mCaff_Kolkata3|04Nov2026|Int13', Channel: 'McaffeineB2C', Location: 'Kolkata3', 'SKU Code': 'SKU_B', 'Channel SKU Code': 'SKU_B' }),
    targetRow({ 'PO Number': 'PEPIMS|3', Channel: 'McaffeineB2C', Location: 'Kolkata3', 'SKU Code': 'SKU_C', 'Channel SKU Code': 'SKU_C' }),
  ]));
  return { ctx, dir };
};

const bySource = (f: Frame): Record<string, number> => {
  const src = f.get('Source') as string[];
  const u = toNum(f.get('final Intransit units'));
  const out: Record<string, number> = {};
  src.forEach((s, i) => (out[s] = (out[s] ?? 0) + u[i]));
  return out;
};

const runCombined = async (feed: string[][] | null): Promise<Frame> => {
  const { ctx, dir } = contextWith(feed);
  try {
    await combined.run(ctx);
    return ctx.get('df_combined_intransit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('combined-intransit reads the feed', () => {
  it('counts our rows (KOL_WAREHOUSE included), drops PEPIMS / Export-B2B rows of our references and our inward POs', async () => {
    const facts: FeedFacts = {
      headers: [...partly.headers, head({ uid: '9', transferCode: 'IT-9', facility: 'mCaff_Kolkata3', channel: 'KOL_WAREHOUSE', location: 'Kolkata_MH', receiving: 'KOL_WAREHOUSE', poNumber: 'KOLMH|04Nov2026|Int1' }),
        head({ uid: '10', transferCode: 'IT-10', facility: 'TEST_FACILITY', poNumber: 'PEPIMS|1' })],
      lines: [...partly.lines, line({ shipmentOrderId: '9', skuCode: 'SKU_K', allocatedQty: 3 }), line({ shipmentOrderId: '10', skuCode: 'SKU_T', allocatedQty: 50 })],
      invoices: partly.invoices,
    };
    const out = await runCombined(buildFeedRows(facts, SETTINGS, ASOF));
    expect([...out.columns].sort()).toEqual([...TARGET].sort());
    expect(bySource(out)).toEqual({
      PO_Not_Found_in_Export_B2B: 7, // PEPIMS|1 only (a TEST transfer's reference never wins)
      Export_B2B_InTransit_Orders: 3,
      D2C_Transfers: 4 + 6 + 5 + 3, // SKU_A allocated 4 + invoice 1 6, SKU_B 5, KOL_WAREHOUSE 3
      Purchase_Order: 4, // PO-OTHER only
    });
    const ours = out.filter((out.get('Source') as string[]).map((s) => s === 'D2C_Transfers'));
    expect([...new Set(ours.get('Channel') as string[])].sort()).toEqual(['KOL_WAREHOUSE', 'McaffeineB2C']);
    // SKU_A of our transfer counted once: 4 + 6 = the line's 10
    const a = ours.filter((ours.get('SKU Code') as string[]).map((s) => s === 'SKU_A'));
    expect(toNum(a.get('final Intransit units')).reduce((x, y) => x + y, 0)).toBe(10);
  });

  it('no feed file, or a feed with no transfers: the same rows as before (only our SO-prefix POs left out)', async () => {
    const without = await runCombined(null);
    const empty = await runCombined([[...FEED_COLUMNS]]);
    const testOnly = await runCombined(buildFeedRows({ headers: [head({ uid: '8', transferCode: 'IT-8', facility: 'TEST_FACILITY' })], lines: [], invoices: [] }, SETTINGS, ASOF));
    const rows = (f: Frame) => Array.from({ length: f.length }, (_, i) => f.row(i));
    expect(rows(empty)).toEqual(rows(without));
    expect(rows(testOnly)).toEqual(rows(without));
    expect(bySource(without)).toEqual({ PO_Not_Found_in_Export_B2B: 17, Export_B2B_InTransit_Orders: 8, Purchase_Order: 4 });
  });
});

describe('local test mode', () => {
  it('writeTransferFeed writes the header only and never reads the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2c-feed-'));
    try {
      const noDb = new Proxy({}, { get: () => { throw new Error('database read in test mode'); } }) as EntityManager;
      const r = await writeTransferFeed(dir, ASOF, noDb, true);
      expect(r).toMatchObject({ transfers: 0, rows: 0, units: 0 });
      const text = fs.readFileSync(path.join(dir, D2C_TRANSFERS_FILE), 'utf8').trim();
      expect(text.split(/\r?\n/)).toHaveLength(1);
      expect(text).toBe(toCsv([[...FEED_COLUMNS]]).trim());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
