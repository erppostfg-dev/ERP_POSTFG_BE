import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { D2C_STAGE, SHIPMENT_LOG_ACTION } from '../../../constants';
import { HttpError } from '../../intransit/sources/http';
import {
  isThrottled, nextDelayOf, planSync, runGentle, SoDetail, soDetailOf, SyncInvoice, SyncLine, SyncPlan, SyncState,
} from '../sync-plan';

/*
 * Phase 6 (Uniware SO status sync), no database: a saleOrderDTO (real read-only answers of 2026-11-03, addresses and
 * GSTINs dropped) mapped to invoices / lines / header / stage; partial dispatch; Uniware-cancelled items; a second run
 * with no Uniware change plans nothing; the 429 stop and the back-off.
 */

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as { saleOrderDTO: Record<string, unknown> };
const NOW = new Date('2026-11-03T10:00:00Z');

const header = (o: Partial<SyncState['header']> = {}): SyncState['header'] => ({
  uid: '900', transferStage: D2C_STAGE.SALE_ORDER, soState: 'created', rtsDate: null, dispatchDate: null, invoiceChallanNumber: null, invoiceDate: null,
  invoiceValue: null, balanceClosedReason: null, syncError: null, ...o,
});
const line = (id: string, skuCode: string, qty: number, o: Partial<SyncLine> = {}): SyncLine => ({
  id, skuCode, qty, updatedQty: qty, dispatchedQty: 0, allocatedQty: 0, gmv: qty * 100, poValue: qty * 15, ...o,
});

/** The stored rows after a plan is written (what syncOne does in SQL). */
const applyPlan = (s: SyncState, p: SyncPlan): SyncState => {
  const invoices = s.invoices.map((i) => ({ ...i }));
  for (const inv of p.invoices) {
    const old = invoices.find((i) => i.shippingPackageCode === inv.code);
    if (old) Object.assign(old, inv.set);
    else {
      invoices.push({
        shippingPackageCode: inv.code, saleOrderCode: null, invoiceCode: null, invoiceDisplayCode: null, invoiceDate: null, packageStatus: null, dispatchedAt: null,
        units: 0, skuQty: null, inwardPoState: null, grnCompletedAt: null, receivedUnits: 0, varianceReason: null, ...(inv.set),
      });
    }
  }
  return {
    header: { ...s.header, ...(p.header as Partial<SyncState['header']>) },
    lines: s.lines.map((l) => ({ ...l, ...(p.lines.find((x) => x.id === l.id)?.set ?? {}) })),
    invoices: JSON.parse(JSON.stringify(invoices), (k, v: unknown) => (['invoiceDate', 'dispatchedAt', 'grnCompletedAt'].includes(k) && typeof v === 'string' ? new Date(v) : v)) as SyncInvoice[],
  };
};
const actions = (p: SyncPlan) => p.logs.map((l) => `${l.action}${l.field ? `:${l.field}` : ''}`).sort();

describe('soDetailOf (real saleorder/get answers)', () => {
  it('reads items with their quantities and packages with invoice, dispatch time and value', () => {
    const so = soDetailOf(fixture('so-get.json').saleOrderDTO);
    expect(so).toMatchObject({ code: '20270902460', status: 'COMPLETE', displayOrderCode: 'GGN_WAREHOUSE|21Oct2026|Int15' });
    expect(so.items).toEqual([{
      code: 'MCFMUBX0354F0050', itemSku: 'MCFMUBX0354F0050', statusCode: 'CANCELLED', counted: true, total: 192, cancelled: 22, completed: 170, allocated: 0, inProcess: 0, sellingPrice: 97.35,
    }]);
    expect(so.packages).toHaveLength(1);
    expect(so.packages[0]).toMatchObject({
      code: 'SP/G3/2627/1425526', status: 'DISPATCHED', invoiceCode: 'SI/G3/2627/1364008', invoiceDisplayCode: 'SI/G3/2627/1364008', value: 16549.5,
      items: [{ sku: 'MCFMUBX0354F0050', qty: 170 }],
    });
    expect(so.packages[0].dispatchedAt?.toISOString()).toBe('2026-10-21T11:16:30.000Z');
  });
});

describe('planSync: a real dispatched SO', () => {
  it('so-get.json: 192 ordered, 22 cancelled in Uniware, 170 dispatched -> invoice row, line cut to 170, dispatched', () => {
    const so = soDetailOf(fixture('so-get.json').saleOrderDTO);
    const state: SyncState = { header: header(), lines: [line('10', 'MCFMUBX0354F0050', 192)], invoices: [] };
    const p = planSync(state, so, NOW);
    expect(p.invoices).toEqual([{
      code: 'SP/G3/2627/1425526', isNew: true,
      set: expect.objectContaining({
        saleOrderCode: '20270902460', invoiceCode: 'SI/G3/2627/1364008', invoiceDisplayCode: 'SI/G3/2627/1364008', packageStatus: 'DISPATCHED', units: 170,
        skuQty: { MCFMUBX0354F0050: { dispatched: 170, inward: 0, received: 0 } },
      }),
    }]);
    expect(p.lines).toEqual([{ id: '10', set: { dispatchedQty: 170, updatedQty: 170, updatedGmv: 17000, updatedPoValue: 2550 } }]);
    expect(p.stage).toBe(D2C_STAGE.DISPATCHED);
    expect(p.header).toMatchObject({
      dispatchDate: '2026-10-21', rtsDate: '2026-10-21', invoiceChallanNumber: 'SI/G3/2627/1364008', invoiceDate: '2026-10-21', invoiceValue: 16549.5,
      balanceClosedReason: 'uniware_cancelled', transferStage: 'dispatched', statusWarehouse: 'Dispatched', statusLogistics: 'Internal Transfer',
    });
    expect(actions(p)).toEqual([
      'balance_closed:balanceClosedReason', 'balance_closed:updatedQty', 'field_changed:dispatchDate', 'field_changed:dispatchedQty', 'field_changed:invoiceChallanNumber',
      'field_changed:rtsDate', 'invoice_seen:packageStatus', 'stage_changed:transferStage',
    ]);
    expect(p.logs.find((l) => l.action === SHIPMENT_LOG_ACTION.STAGE_CHANGED)?.uniwareStatus).toBe('COMPLETE | SP/G3/2627/1425526 DISPATCHED');
    expect(p.logs.every((l) => l.source === 'uniware' && l.uid === '900')).toBe(true);
  });

  it('so-get-rts.json: SKU matched case-insensitively (mcaf278 = MCaf278), sku_qty keyed by our SKU, no cut', () => {
    const so = soDetailOf(fixture('so-get-rts.json').saleOrderDTO);
    const state: SyncState = { header: header({ transferStage: D2C_STAGE.READY_TO_SHIP }), lines: [line('20', 'MCaf278', 35)], invoices: [] };
    const p = planSync(state, so, NOW);
    expect(p.invoices[0].set.skuQty).toEqual({ MCaf278: { dispatched: 35, inward: 0, received: 0 } });
    expect(p.lines).toEqual([{ id: '20', set: { dispatchedQty: 35 } }]);
    expect(p.header).toMatchObject({ dispatchDate: '2026-10-22', rtsDate: '2026-10-21', invoiceChallanNumber: 'PEP2627MH/0201', invoiceValue: 1831.9, transferStage: 'dispatched' });
    expect(p.header.balanceClosedReason).toBeUndefined();
  });

  it('a second run with no Uniware change plans nothing (idempotent)', () => {
    for (const [name, sku, qty] of [['so-get.json', 'MCFMUBX0354F0050', 192], ['so-get-rts.json', 'MCaf278', 35]] as const) {
      const so = soDetailOf(fixture(name).saleOrderDTO);
      const s0: SyncState = { header: header(), lines: [line('1', sku, qty)], invoices: [] };
      const s1 = applyPlan(s0, planSync(s0, so, NOW));
      const again = planSync(s1, so, new Date(NOW.getTime() + 3_600_000));
      expect(again).toMatchObject({ changed: false, logs: [], lines: [], invoices: [], header: {} });
    }
  });
});

// ---- synthetic SOs ---------------------------------------------------------------------------------------------------

const T = (iso: string) => Date.parse(iso);
const item = (code: string, sku: string, total: number, o: Record<string, unknown> = {}) => ({
  code, itemSku: sku, statusCode: 'CREATED', totalQuantity: total, cancelledQuantity: 0, completedQuantity: 0, allocatedQuantity: total, inProcessQuantity: 0,
  unallocatedQuantity: 0, sellingPrice: 10, ...o,
});
const pkg = (code: string, status: string, items: Record<string, number>, o: Record<string, unknown> = {}) => ({
  code, status, saleOrderCode: 'erp_it_20261103005', dispatched: null, invoiceCode: null, invoiceDisplayCode: null, invoiceDate: null,
  items: Object.fromEntries(Object.entries(items).map(([sku, quantity]) => [sku, { itemSku: sku, quantity }])), ...o,
});
const dto = (items: unknown[], packages: unknown[], status = 'PROCESSING'): SoDetail =>
  soDetailOf({ code: 'erp_it_20261103005', displayOrderCode: 'X|03Nov2026|5', status, saleOrderItems: items, shippingPackages: packages });

describe('planSync: partial dispatch (2 packages, one dispatched)', () => {
  const lines = [line('1', 'SKU_A', 10), line('2', 'SKU_B', 5)];
  const first = dto(
    [item('L1', 'SKU_A', 10, { completedQuantity: 6, allocatedQuantity: 0, inProcessQuantity: 4 }), item('L2', 'SKU_B', 5, { allocatedQuantity: 0, inProcessQuantity: 5 })],
    [
      pkg('SP1', 'DISPATCHED', { SKU_A: 6 }, { dispatched: T('2026-11-03T06:00:00Z'), invoiceCode: 'INV1', invoiceDisplayCode: 'INV1', invoiceDate: T('2026-11-03T05:00:00Z') }),
      pkg('SP2', 'PACKED', { SKU_A: 4, SKU_B: 5 }),
    ],
  );

  it('partly dispatched: one invoice dispatched, the other package waiting; dispatched / allocated per line', () => {
    const s0: SyncState = { header: header(), lines, invoices: [] };
    const p = planSync(s0, first, NOW);
    expect(p.stage).toBe(D2C_STAGE.PARTLY_DISPATCHED);
    expect(p.invoices.map((i) => [i.code, i.isNew, i.set.dispatchedAt ? 'dispatched' : 'not', i.set.units])).toEqual([['SP1', true, 'dispatched', 6], ['SP2', true, 'not', 9]]);
    expect(p.lines).toEqual([{ id: '1', set: { dispatchedQty: 6, allocatedQty: 4 } }, { id: '2', set: { allocatedQty: 5 } }]);
    expect(p.header).toMatchObject({ dispatchDate: '2026-11-03', rtsDate: '2026-11-03', invoiceChallanNumber: 'INV1', invoiceValue: 60, transferStage: 'partly_dispatched' });
    expect(p.header.balanceClosedReason).toBeUndefined();

    // the second package is invoiced and dispatched later: only it is logged, the stage moves on
    const s1 = applyPlan(s0, p);
    const second = dto(
      [item('L1', 'SKU_A', 10, { completedQuantity: 10, allocatedQuantity: 0 }), item('L2', 'SKU_B', 5, { completedQuantity: 5, allocatedQuantity: 0 })],
      [
        pkg('SP1', 'DISPATCHED', { SKU_A: 6 }, { dispatched: T('2026-11-03T06:00:00Z'), invoiceCode: 'INV1', invoiceDisplayCode: 'INV1', invoiceDate: T('2026-11-03T05:00:00Z') }),
        pkg('SP2', 'DISPATCHED', { SKU_A: 4, SKU_B: 5 }, { dispatched: T('2026-11-04T06:00:00Z'), invoiceCode: 'INV2', invoiceDisplayCode: 'INV2', invoiceDate: T('2026-11-04T05:00:00Z') }),
      ],
      'COMPLETE',
    );
    const p2 = planSync(s1, second, NOW);
    expect(p2.stage).toBe(D2C_STAGE.DISPATCHED);
    expect(p2.invoices.map((i) => i.code)).toEqual(['SP2']);
    expect(p2.logs.filter((l) => l.action === SHIPMENT_LOG_ACTION.INVOICE_SEEN).map((l) => l.remark)).toEqual(['INV2 | package SP2 | 9 unit(s) | status PACKED -> DISPATCHED, invoice created, dispatched']);
    expect(p2.header).toMatchObject({ invoiceChallanNumber: 'INV1, INV2', invoiceValue: 150 });
    expect(p2.header.dispatchDate).toBeUndefined(); // the first dispatch day stays
    expect(p2.lines).toEqual([{ id: '1', set: { dispatchedQty: 10, allocatedQty: 0 } }, { id: '2', set: { dispatchedQty: 5, allocatedQty: 0 } }]);
    expect(planSync(applyPlan(s1, p2), second, NOW).changed).toBe(false);
  });

  it('a dispatched package without a dispatched time keeps the time it was first seen', () => {
    const so = dto([item('L1', 'SKU_A', 10)], [pkg('SP1', 'SHIPPED', { SKU_A: 10 }, { invoiceCode: 'INV1' })]);
    const s0: SyncState = { header: header(), lines: [line('1', 'SKU_A', 10)], invoices: [] };
    const s1 = applyPlan(s0, planSync(s0, so, NOW));
    expect(s1.invoices[0].dispatchedAt?.toISOString()).toBe(NOW.toISOString());
    expect(planSync(s1, so, new Date(NOW.getTime() + 86_400_000)).changed).toBe(false);
  });
});

describe('planSync: items cancelled in Uniware', () => {
  it('one line cancelled in Uniware, the other open: that line cut to 0, no balance reason (something is still open)', () => {
    const so = dto([item('L1', 'SKU_A', 10), item('L2', 'SKU_B', 5, { statusCode: 'CANCELLED', cancelledQuantity: 5, allocatedQuantity: 0 })], []);
    const p = planSync({ header: header(), lines: [line('1', 'SKU_A', 10), line('2', 'SKU_B', 5)], invoices: [] }, so, NOW);
    expect(p.lines).toEqual([{ id: '1', set: { allocatedQty: 10 } }, { id: '2', set: { updatedQty: 0, updatedGmv: 0, updatedPoValue: 0 } }]);
    expect(p.header.balanceClosedReason).toBeUndefined();
    expect(p.stage).toBe(D2C_STAGE.SALE_ORDER);
    expect(actions(p)).toEqual(['balance_closed:updatedQty']);
  });

  it('whole SO cancelled in Uniware before any dispatch -> cancelled, reason uniware_cancelled, texts Cancelled', () => {
    const so = dto([item('L1', 'SKU_A', 10, { statusCode: 'CANCELLED', cancelledQuantity: 10, allocatedQuantity: 0 })], [], 'CANCELLED');
    const s0: SyncState = { header: header({ transferStage: D2C_STAGE.PACKED }), lines: [line('1', 'SKU_A', 10)], invoices: [] };
    const p = planSync(s0, so, NOW);
    expect(p.stage).toBe(D2C_STAGE.CANCELLED);
    expect(p.header).toMatchObject({ transferStage: 'cancelled', balanceClosedReason: 'uniware_cancelled', statusPlanning: 'Cancelled', statusWarehouse: null });
    expect(p.logs.find((l) => l.field === 'balanceClosedReason')?.remark).toBe('sale order cancelled in Uniware');
    expect(planSync(applyPlan(s0, p), so, NOW).changed).toBe(false);
  });

  it('our own cancel / close short is not seen as a Uniware cancel (updatedQty already = total - cancelled)', () => {
    const so = dto([item('L1', 'SKU_A', 10, { statusCode: 'CANCELLED', cancelledQuantity: 4, completedQuantity: 6, allocatedQuantity: 0 })],
      [pkg('SP1', 'DISPATCHED', { SKU_A: 6 }, { dispatched: T('2026-11-03T06:00:00Z'), invoiceCode: 'INV1' })]);
    const s0: SyncState = {
      header: header({ transferStage: D2C_STAGE.PARTLY_DISPATCHED, balanceClosedReason: 'close_short' }), lines: [line('1', 'SKU_A', 10, { updatedQty: 6 })], invoices: [],
    };
    const p = planSync(s0, so, NOW);
    expect(p.lines).toEqual([{ id: '1', set: { dispatchedQty: 6 } }]);
    expect(p.header.balanceClosedReason).toBeUndefined();
    expect(p.logs.some((l) => l.action === SHIPMENT_LOG_ACTION.BALANCE_CLOSED)).toBe(false);
    expect(p.stage).toBe(D2C_STAGE.DISPATCHED);
  });

  it('an IT-2627-11-004-like SO (cancelled by the tool, transfer already cancelled) changes nothing', () => {
    const so = dto([item('L5840', 'TEST_UNICOM1', 2, { statusCode: 'CANCELLED', cancelledQuantity: 2, allocatedQuantity: 0 })], [], 'CANCELLED');
    const p = planSync({ header: header({ transferStage: D2C_STAGE.CANCELLED }), lines: [line('5840', 'TEST_UNICOM1', 2, { updatedQty: 0 })], invoices: [] }, so, NOW);
    expect(p).toMatchObject({ changed: false, logs: [], stage: 'cancelled' });
  });

  // the live read of erp_it_20261103001 (IT-2627-11-004, 2026-11-03): a cancelled SO whose item has NO quantities
  const liveCancelled = () => dto([{ code: 'L5840', itemSku: 'TEST_UNICOM1', statusCode: 'CANCELLED', totalQuantity: null, cancelledQuantity: null, completedQuantity: null, allocatedQuantity: null, inProcessQuantity: null }], [], 'CANCELLED');

  it('item without quantities, CANCELLED, transfer already cancelled by the tool: nothing (as read live)', () => {
    const p = planSync({ header: header({ transferStage: D2C_STAGE.CANCELLED }), lines: [line('5840', 'TEST_UNICOM1', 2, { updatedQty: 0 })], invoices: [] }, liveCancelled(), NOW);
    expect(p).toMatchObject({ changed: false, logs: [] });
  });

  it('item without quantities, CANCELLED, transfer still open here: the line is cut to what was dispatched -> cancelled', () => {
    const p = planSync({ header: header(), lines: [line('5840', 'TEST_UNICOM1', 2)], invoices: [] }, liveCancelled(), NOW);
    expect(p.lines).toEqual([{ id: '5840', set: { updatedQty: 0, updatedGmv: 0, updatedPoValue: 0 } }]);
    expect(p.header).toMatchObject({ transferStage: 'cancelled', balanceClosedReason: 'uniware_cancelled' });
  });

  it('item without quantities and not cancelled: never cut; its open units count as allocated', () => {
    const so = dto([{ code: 'L1', itemSku: 'SKU_A', statusCode: 'FULFILLABLE', totalQuantity: null }], []);
    const p = planSync({ header: header(), lines: [line('1', 'SKU_A', 10)], invoices: [] }, so, NOW);
    expect(p.lines).toEqual([{ id: '1', set: { allocatedQty: 10 } }]);
    expect(p.stage).toBe(D2C_STAGE.SALE_ORDER);
  });

  it('a stored sync error is left to the run (combined SO + GRN errors are written once at its end)', () => {
    const so = dto([item('L1', 'SKU_A', 10)], []);
    const p = planSync({ header: header({ syncError: 'Uniware read failed' }), lines: [line('1', 'SKU_A', 10, { allocatedQty: 10 })], invoices: [] }, so, NOW);
    expect(p).toMatchObject({ changed: false, logs: [] });
    expect(p.header.syncError).toBeUndefined();
  });
});

describe('pacing: 429 stop and back-off', () => {
  it('nextDelayOf: interval after a good run; x2 per failed run, at most 120 min', () => {
    expect(nextDelayOf(30, false, 120)).toBe(30);
    expect(nextDelayOf(30, true, null)).toBe(60);
    expect(nextDelayOf(30, true, 60)).toBe(120);
    expect(nextDelayOf(30, true, 120)).toBe(120);
    expect(nextDelayOf(90, true, null)).toBe(120);
  });

  it('runGentle: at most 2 at a time, a pause after each call, a final 429 stops the run (the rest is left)', async () => {
    let inFlight = 0;
    let most = 0;
    const seen: number[] = [];
    const pauses: number[] = [];
    const r = await runGentle([1, 2, 3, 4, 5, 6, 7], { concurrency: 2, gapMs: 500, wait: async (ms) => { pauses.push(ms); } }, async (n) => {
      inFlight++;
      most = Math.max(most, inFlight);
      seen.push(n);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      if (n === 3) throw new HttpError(429, '429 from /services/rest/v1/oms/saleorder/get: too many requests');
    });
    expect(most).toBe(2);
    expect(r.throttled).toBe(true);
    expect(seen).not.toContain(7);
    expect(r.notStarted).toBeGreaterThan(0);
    expect(r.done + r.notStarted + 1).toBe(7);
    expect(pauses.every((ms) => ms === 500)).toBe(true);
  });

  it('runGentle: other errors are counted, the run goes on', async () => {
    const r = await runGentle([1, 2, 3], { concurrency: 2, gapMs: 0 }, async (n) => { if (n === 2) throw new Error('db down'); });
    expect(r).toMatchObject({ done: 2, throttled: false, notStarted: 0 });
    expect(r.errors).toHaveLength(1);
  });

  it('isThrottled: only an HTTP 429', () => {
    expect(isThrottled(new HttpError(429, 'x'))).toBe(true);
    expect(isThrottled(new HttpError(500, 'x'))).toBe(false);
    expect(isThrottled(new Error('/x refused: []'))).toBe(false);
  });
});
