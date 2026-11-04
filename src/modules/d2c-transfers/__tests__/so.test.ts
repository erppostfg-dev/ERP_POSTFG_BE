import { describe, expect, it } from 'vitest';
import { D2C_STAGE, d2cSoUnitPrice } from '../../../constants';
import { HttpError } from '../../intransit/sources/http';
import {
  cancelBlock, closedQty, closeShortPlan, decideAfterCreate, decideAfterGet, lineMrp, lineOfItem, markShort, reconcileCheck, reserveBlock, ReserveFacts,
  gateError, isGateCode, runPool, uniwareWritesAllowed,
} from '../so.service';
import { deriveStage, StageFacts } from '../stage';
import {
  availableOf, buildSaleOrderPayload, classify, getSaleOrder, refusalOf, SoItem, soViewOf, statusLine, stockAt, trim, UniwarePoster,
} from '../uniware-transfers';

/*
 * Phase 5 (Uniware sale orders), no database: the gate, the reserve checks, what a create / get answer means, the
 * close-short item choice, the stock formula and the create payload.
 */

/** Uniware's refusal as UniwareApi.post throws it (successful:false). */
const refusal = (path: string, message: string, code = 40001) =>
  new Error(`${path} refused: ${JSON.stringify([{ code, fieldName: null, description: message, message, errorParams: null }])}`);

const item = (o: Partial<SoItem> & { code: string }): SoItem => ({
  itemSku: 'SKU1', statusCode: 'CREATED', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: 0, cancellable: true, ...o,
});
const so = (items: SoItem[], displayOrderCode = 'REF|03Nov2026|1') => ({ code: 'erp_it_20261103001', displayOrderCode, status: 'PROCESSING', items, packages: [] });

describe('production gate (plan 2.11 + local test mode)', () => {
  const s = { live: false, testFacilities: ['TEST_FACILITY', 'TEST_RECV'] };
  const lane = (sender: string | null, receiving: string | null) => ({ sender, receiving });
  it('closed: sender AND receiving facility must both be test facilities (exact code), for every write', () => {
    for (const at of ['sender', 'receiving'] as const) {
      expect(uniwareWritesAllowed(s, false, lane('TEST_FACILITY', 'TEST_RECV'), at, false)).toBe(true);
      expect(uniwareWritesAllowed(s, false, lane('TEST_FACILITY', 'TEST_FACILITY'), at, false)).toBe(true);
      expect(uniwareWritesAllowed(s, false, lane('TEST_FACILITY', 'Mcaff_Nagpur'), at, false)).toBe(false);
      expect(uniwareWritesAllowed(s, false, lane('MUM_WAREHOUSE2', 'TEST_RECV'), at, false)).toBe(false);
      expect(uniwareWritesAllowed(s, false, lane('test_facility', 'TEST_RECV'), at, false)).toBe(false);
      expect(uniwareWritesAllowed(s, false, lane('TEST_FACILITY', null), at, false)).toBe(false);
    }
  });
  it('TEST_FACILITY counts as a test facility even when the settings list is empty', () => {
    expect(uniwareWritesAllowed({ live: false, testFacilities: [] }, false, lane('TEST_FACILITY', 'TEST_FACILITY'), 'sender', false)).toBe(true);
  });
  it('needs BOTH settings.live and env D2C_UNIWARE_WRITES to open for every facility', () => {
    expect(uniwareWritesAllowed({ ...s, live: true }, false, lane('MUM_WAREHOUSE2', 'mCaff_Kolkata3'), 'sender', false)).toBe(false);
    expect(uniwareWritesAllowed(s, true, lane('MUM_WAREHOUSE2', 'mCaff_Kolkata3'), 'sender', false)).toBe(false);
    expect(uniwareWritesAllowed({ ...s, live: true }, true, lane('MUM_WAREHOUSE2', 'mCaff_Kolkata3'), 'sender', false)).toBe(true);
  });
  it('open: an SO / cancel / close short needs the sender, an inward PO the receiving facility', () => {
    const open = { ...s, live: true };
    expect(uniwareWritesAllowed(open, true, lane('MUM_WAREHOUSE2', null), 'sender', false)).toBe(true);
    expect(uniwareWritesAllowed(open, true, lane('MUM_WAREHOUSE2', null), 'receiving', false)).toBe(false);
    expect(uniwareWritesAllowed(open, true, lane(null, 'mCaff_Kolkata3'), 'receiving', false)).toBe(true);
    expect(uniwareWritesAllowed(open, true, lane(null, 'mCaff_Kolkata3'), 'sender', false)).toBe(false);
  });
  it('local test mode: only test lanes, even with live + D2C_UNIWARE_WRITES on', () => {
    const open = { ...s, live: true };
    expect(uniwareWritesAllowed(open, true, lane('MUM_WAREHOUSE2', 'mCaff_Kolkata3'), 'sender', true)).toBe(false);
    expect(uniwareWritesAllowed(open, true, lane('TEST_FACILITY', 'mCaff_Kolkata3'), 'sender', true)).toBe(false);
    expect(uniwareWritesAllowed(open, true, lane('MUM_WAREHOUSE2', 'TEST_FACILITY'), 'receiving', true)).toBe(false);
    expect(uniwareWritesAllowed(open, true, lane('TEST_FACILITY', 'TEST_FACILITY'), 'receiving', true)).toBe(true);
  });
  it('the refusal names the lane: D2C_TEST_ONLY in test mode, else D2C_NOT_LIVE', () => {
    const t = gateError(lane('TEST_FACILITY', 'Mcaff_Nagpur'), true);
    expect(t.code).toBe('D2C_TEST_ONLY');
    expect(t.message).toMatch(/^local test mode: only TEST_FACILITY transfers can reach Uniware \(TEST_FACILITY -> Mcaff_Nagpur/);
    expect(gateError(lane('MUM_WAREHOUSE2', null), false).code).toBe('D2C_NOT_LIVE');
    expect(isGateCode('D2C_TEST_ONLY') && isGateCode('D2C_NOT_LIVE') && !isGateCode('D2C_NOT_FOUND')).toBe(true);
  });
});

describe('reserve checks (plan 5.4)', () => {
  const ok: ReserveFacts = {
    stage: D2C_STAGE.DRAFT, soState: null, sender: 'TEST_FACILITY', reference: 'X|03Nov2026|1',
    route: { id: 1, uniwareChannelCode: 'mCaff_Test', customerCode: 'Test_Channel' }, lines: [{ skuCode: 'A', qty: 2, mrp: 100 }],
  };
  it('a draft with route codes and MRPs may go; a failed one may be retried', () => {
    expect(reserveBlock(ok)).toBeNull();
    expect(reserveBlock({ ...ok, soState: 'failed' })).toBeNull();
  });
  it('blocks in flight, created, not a draft, missing codes, missing MRP, no qty', () => {
    expect(reserveBlock({ ...ok, soState: 'requested' })).toMatch(/requested/);
    expect(reserveBlock({ ...ok, soState: 'unknown' })).toMatch(/unknown/);
    expect(reserveBlock({ ...ok, soState: 'created' })).toMatch(/already/);
    expect(reserveBlock({ ...ok, stage: D2C_STAGE.CANCELLED })).toMatch(/not a draft/);
    expect(reserveBlock({ ...ok, route: null })).toMatch(/no route/);
    expect(reserveBlock({ ...ok, route: { id: 1, uniwareChannelCode: null, customerCode: 'C' } })).toMatch(/Uniware channel/);
    expect(reserveBlock({ ...ok, route: { id: 1, uniwareChannelCode: 'C', customerCode: null } })).toMatch(/customer/);
    expect(reserveBlock({ ...ok, lines: [{ skuCode: 'A', qty: 2, mrp: null }, { skuCode: 'B', qty: 0, mrp: null }] })).toBe('no MRP for A (the SO price is 15% of MRP)');
    expect(reserveBlock({ ...ok, lines: [{ skuCode: 'A', qty: 0, mrp: 5 }] })).toMatch(/no line/);
  });
  it('line MRP = gmv / qty, frozen at save', () => {
    expect(lineMrp({ gmv: '499.00' as unknown as number, qty: 2 })).toBe(249.5);
    expect(lineMrp({ gmv: 0, qty: 2 })).toBeNull();
    expect(lineMrp({ gmv: 10, qty: 0 })).toBeNull();
  });
});

describe('what the create answer means', () => {
  const P = '/services/rest/v1/oms/saleOrder/create';
  it('success -> created', () => {
    expect(decideAfterCreate({ ok: true, response: { successful: true } })).toEqual({ state: 'created', error: null });
  });
  it('a refusal -> failed with Uniware\'s reason (stays an editable draft)', () => {
    const d = decideAfterCreate({ ok: false, error: refusal(P, 'INVALID_CUSTOMER_CODE', 40002) });
    expect(d.state).toBe('failed');
    expect(d.error).toContain('INVALID_CUSTOMER_CODE');
  });
  it('duplicate code -> reconcile (an earlier request got through)', () => {
    expect(decideAfterCreate({ ok: false, error: refusal(P, 'DUPLICATE_SALE_ORDER') }).state).toBe('reconcile');
  });
  it('HTTP error, timeout, network -> reconcile, never failed', () => {
    expect(decideAfterCreate({ ok: false, error: new HttpError(502, 'Bad gateway') }).state).toBe('reconcile');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(decideAfterCreate({ ok: false, error: timeout }).state).toBe('reconcile');
    expect(decideAfterCreate({ ok: false, error: new TypeError('fetch failed') }).state).toBe('reconcile');
  });
  it('classify / refusalOf read the errors JSON', () => {
    expect(classify(refusal(P, 'DUPLICATE_SALE_ORDER'))).toBe('duplicate');
    expect(classify(new HttpError(500, 'x refused: [] but HTTP'))).toBe('unknown');
    expect(refusalOf(refusal(P, 'X', 123))).toMatchObject({ codes: [123], messages: ['X: X'] });
    expect(refusalOf(new Error('/p refused: "plain text"'))?.text).toBe('plain text');
  });
});

describe('what the get answer means (reconcile)', () => {
  it('found with our reference -> created', () => {
    expect(decideAfterGet({ kind: 'found', so: so([]) }, 'REF|03Nov2026|1')).toEqual({ state: 'created', error: null });
  });
  it('found with another reference -> stays unknown (a person must look)', () => {
    expect(decideAfterGet({ kind: 'found', so: so([], 'OTHER') }, 'REF|03Nov2026|1').state).toBe('unknown');
  });
  it('a clean "unknown code" -> failed', () => {
    expect(decideAfterGet({ kind: 'not_found' }, 'REF').state).toBe('failed');
  });
  it('the get itself failed -> stays unknown, never failed', () => {
    expect(decideAfterGet({ kind: 'error', error: new HttpError(503, 'down') }, 'REF').state).toBe('unknown');
    expect(decideAfterGet({ kind: 'error', error: refusal('/get', 'SOMETHING_ELSE') }, 'REF').state).toBe('unknown');
  });
  it('getSaleOrder: INVALID_SALE_ORDER_CODE = not found; other refusals are thrown', async () => {
    const notFound: UniwarePoster = { post: () => Promise.reject(refusal('/services/rest/v1/oms/saleorder/get', 'INVALID_SALE_ORDER_CODE', 40005)) };
    expect((await getSaleOrder(notFound, 'erp_it_x', 'TEST_FACILITY')).so).toBeNull();
    const other: UniwarePoster = { post: () => Promise.reject(refusal('/get', 'ACCESS_DENIED')) };
    await expect(getSaleOrder(other, 'erp_it_x', 'TEST_FACILITY')).rejects.toThrow(/ACCESS_DENIED/);
    const found: UniwarePoster = {
      post: <T>(path: string, body: unknown, facility?: string) => {
        expect([path, body, facility]).toEqual(['/services/rest/v1/oms/saleorder/get', { code: 'erp_it_x' }, 'TEST_FACILITY']);
        return Promise.resolve({ saleOrderDTO: { code: 'erp_it_x', displayOrderCode: 'R', status: 'CREATED', saleOrderItems: [{ code: 'L1', itemSku: 'A', statusCode: 'created', totalQuantity: 3 }] } } as unknown as T);
      },
    };
    const r = await getSaleOrder(found, 'erp_it_x', 'TEST_FACILITY');
    expect(r.so?.items[0]).toMatchObject({ code: 'L1', statusCode: 'CREATED', totalQuantity: 3, cancelledQuantity: null });
  });
});

describe('reconcile helper (for the phase 6 sync)', () => {
  const NOW = Date.parse('2026-11-03T12:00:00Z');
  const po = { soState: 'unknown', soRequestedAt: new Date(NOW - 20 * 60_000), orderNo1: 'erp_it_20261103001', facility: 'TEST_FACILITY', poNumber: 'REF|03Nov2026|1' };
  const dto = (displayOrderCode: string) => ({ saleOrderDTO: { code: 'erp_it_20261103001', displayOrderCode, status: 'CREATED', saleOrderItems: [{ code: 'L1', itemSku: 'A', statusCode: 'CREATED' }] } });
  const answering = (a: () => unknown): UniwarePoster => ({ post: <T>() => { try { return Promise.resolve(a() as T); } catch (e) { return Promise.reject(e instanceof Error ? e : new Error(String(e))); } } });
  const never: UniwarePoster = { post: () => { throw new Error('must not call Uniware'); } };

  it('skips what is not in flight, and requests younger than the grace', async () => {
    expect(await reconcileCheck({ ...po, soState: 'created' }, never, 0, NOW)).toMatchObject({ checked: false });
    expect(await reconcileCheck({ ...po, soState: null }, never, 0, NOW)).toMatchObject({ checked: false });
    expect(await reconcileCheck({ ...po, soRequestedAt: new Date(NOW - 60_000) }, never, 15 * 60_000, NOW)).toMatchObject({ checked: false, why: expect.stringMatching(/grace/) });
  });
  it('found with our reference -> created (status line for the log); another reference -> unknown', async () => {
    expect(await reconcileCheck(po, answering(() => dto(po.poNumber)), 15 * 60_000, NOW)).toMatchObject({ checked: true, state: 'created', uniwareStatus: 'CREATED: L1 CREATED' });
    expect(await reconcileCheck({ ...po, soState: 'requested' }, answering(() => dto('OTHER')), 0, NOW)).toMatchObject({ checked: true, state: 'unknown' });
  });
  it('clean "unknown code" -> failed; the get erroring -> unknown', async () => {
    expect(await reconcileCheck(po, answering(() => { throw refusal('/get', 'INVALID_SALE_ORDER_CODE', 40005); }), 0, NOW)).toMatchObject({ state: 'failed' });
    expect(await reconcileCheck(po, answering(() => { throw new HttpError(504, 'gateway timeout'); }), 0, NOW)).toMatchObject({ state: 'unknown' });
  });
});

describe('close short: which items are cancelled', () => {
  const lines = [{ id: '11', skuCode: 'A' }, { id: '12', skuCode: 'B' }, { id: '13', skuCode: 'C' }];
  it('every open item; dispatched / cancelled ones are left (and named)', () => {
    const plan = closeShortPlan(so([
      item({ code: 'L11', itemSku: 'A', statusCode: 'CREATED' }),
      item({ code: 'L12', itemSku: 'B', statusCode: 'DISPATCHED' }),
      item({ code: 'L13', itemSku: 'C', statusCode: 'CANCELLED' }),
      item({ code: 'X9', itemSku: 'c', statusCode: 'FULFILLABLE' }),
    ]), lines);
    expect(plan.cancel).toEqual([{ itemCode: 'L11', sku: 'A', lineId: '11' }, { itemCode: 'X9', sku: 'c', lineId: '13' }]);
    expect(plan.skipped).toEqual([{ itemCode: 'L12', sku: 'B', why: 'already DISPATCHED' }]);
  });
  it('item -> line by our code L<lineId>, else by SKU', () => {
    expect(lineOfItem({ code: 'L12', itemSku: 'ZZZ' }, lines)?.id).toBe('12');
    expect(lineOfItem({ code: 'MCAF1', itemSku: 'b' }, lines)?.id).toBe('12');
    expect(lineOfItem({ code: 'Q', itemSku: 'Q' }, lines)).toBeUndefined();
  });
  it('new updatedQty: total - cancelled when Uniware says both (never below dispatched), else dispatched', () => {
    expect(closedQty(3, { totalQuantity: 10, cancelledQuantity: 7 })).toBe(3);
    expect(closedQty(3, { totalQuantity: 10, cancelledQuantity: 5 })).toBe(5);
    expect(closedQty(6, { totalQuantity: 10, cancelledQuantity: 10 })).toBe(6);
    expect(closedQty(4, { totalQuantity: null, cancelledQuantity: null })).toBe(4);
    expect(closedQty(0, undefined)).toBe(0);
  });
  it('cancel allowed only before any dispatch and when no request is in flight', () => {
    expect(cancelBlock({ transferStage: D2C_STAGE.SALE_ORDER, soState: 'created' }, 0, 0)).toBeNull();
    expect(cancelBlock({ transferStage: D2C_STAGE.INVOICED, soState: 'created' }, 0, 0)).toBeNull();
    expect(cancelBlock({ transferStage: D2C_STAGE.PARTLY_DISPATCHED, soState: 'created' }, 5, 1)).toMatch(/Close short/);
    expect(cancelBlock({ transferStage: D2C_STAGE.SALE_ORDER, soState: 'created' }, 1, 0)).toMatch(/Close short/);
    expect(cancelBlock({ transferStage: D2C_STAGE.DRAFT, soState: 'unknown' }, 0, 0)).toMatch(/unknown/);
    expect(cancelBlock({ transferStage: D2C_STAGE.CANCELLED, soState: 'created' }, 0, 0)).toMatch(/already/);
  });
});

describe('stock', () => {
  it('available = inventory - openSale - inventoryBlocked, never below 0', () => {
    expect(availableOf({ inventory: 136, openSale: 0, inventoryBlocked: 116 })).toBe(20);
    expect(availableOf({ inventory: 10, openSale: 8, inventoryBlocked: 5 })).toBe(0);
    expect(availableOf({})).toBe(0);
  });
  it('INVENTORY_NOT_AVAILABLE = every SKU 0; other errors are thrown; batches of 100', async () => {
    const none: UniwarePoster = { post: () => Promise.reject(refusal('/stock', 'INVENTORY_NOT_AVAILABLE', 60004)) };
    expect((await stockAt(none, 'F', ['A'])).size).toBe(0);
    await expect(stockAt({ post: () => Promise.reject(new HttpError(500, 'x')) }, 'F', ['A'])).rejects.toThrow();
    const calls: unknown[] = [];
    const some: UniwarePoster = {
      post: <T>(_p: string, body: unknown) => {
        calls.push(body);
        return Promise.resolve({ inventorySnapshots: [{ itemTypeSKU: 'MCaf41', inventory: 50, openSale: 5, inventoryBlocked: 5 }] } as unknown as T);
      },
    };
    const skus = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const m = await stockAt(some, 'F', [...skus, 'MCaf41']);
    expect(calls).toHaveLength(2);
    expect(m.get('mcaf41')).toMatchObject({ available: 40 });
  });
  it('short per line, and together across the selected transfers', () => {
    expect(markShort([{ key: 'F|A', needed: 6, available: 10 }, { key: 'F|A', needed: 6, available: 10 }, { key: 'F|B', needed: 11, available: 10 }]))
      .toEqual([{ short: false, shortOverall: true }, { short: false, shortOverall: true }, { short: true, shortOverall: true }]);
  });
});

describe('create payload', () => {
  it('one item per line with its qty; price = round(15% x MRP, 2); total = price x qty; sender facility', () => {
    const p = buildSaleOrderPayload({
      code: 'erp_it_20261103001', displayOrderCode: 'TEST_FACILITY|03Nov2026|Int1', channel: 'mCaff_Test', customerCode: 'Test_Channel', facility: 'TEST_FACILITY',
      lines: [{ lineId: '7', skuCode: 'TEST_UNICOM1', qty: 3, mrp: 649 }, { lineId: '8', skuCode: 'B', qty: 0, mrp: 10 }, { lineId: '9', skuCode: 'C', qty: 7, mrp: 333.33 }],
    });
    expect(p).toEqual({
      saleOrder: {
        code: 'erp_it_20261103001', displayOrderCode: 'TEST_FACILITY|03Nov2026|Int1', channel: 'mCaff_Test', customerCode: 'Test_Channel', cashOnDelivery: false,
        saleOrderItems: [
          { code: 'L7', itemSku: 'TEST_UNICOM1', quantity: 3, shippingMethodCode: 'STD', sellingPrice: 97.35, totalPrice: 292.05, facilityCode: 'TEST_FACILITY' },
          { code: 'L9', itemSku: 'C', quantity: 7, shippingMethodCode: 'STD', sellingPrice: 50, totalPrice: 350, facilityCode: 'TEST_FACILITY' },
        ],
      },
    });
    expect(d2cSoUnitPrice(199)).toBe(29.85);
  });
  it('logs: trimmed, no token / password', () => {
    expect(trim({ a: 'x'.repeat(50) }, 20)).toHaveLength(20);
    expect(trim('Authorization: bearer abc.def')).toBe('Authorization: bearer ***');
    expect(trim({ password: 'secret', access_token: 'tok' })).toBe('{"password":"***","access_token":"***"}');
  });
  it('SO view + status line', () => {
    const v = soViewOf({ code: 'C', status: 'PROCESSING', saleOrderItems: [{ code: 'L1', itemSku: 'A', statusCode: 'CANCELLED' }], shippingPackages: [{ code: 'P', status: 'PACKED' }] });
    expect(statusLine(v)).toBe('PROCESSING: L1 CANCELLED');
    expect(v.packages).toEqual([{ code: 'P', status: 'PACKED' }]);
  });
});

describe('stage after an SO action', () => {
  const f = (o: Partial<StageFacts>): StageFacts => ({ stage: D2C_STAGE.DRAFT, soState: null, lines: [{ updatedQty: 10, dispatched: 0 }], invoices: [], ...o });
  it('no SO = draft; SO created = sale order', () => {
    expect(deriveStage(f({ soState: 'requested' }))).toBe(D2C_STAGE.DRAFT);
    expect(deriveStage(f({ soState: 'created' }))).toBe(D2C_STAGE.SALE_ORDER);
  });
  it('close short: nothing dispatched and nothing left = cancelled; some dispatched = dispatched', () => {
    expect(deriveStage(f({ stage: D2C_STAGE.SALE_ORDER, soState: 'created', lines: [{ updatedQty: 0, dispatched: 0 }] }))).toBe(D2C_STAGE.CANCELLED);
    const inv = { packageStatus: 'DISPATCHED', invoiced: true, dispatched: true, inwardPoState: null, grnCompleted: false, variance: 0, varianceReason: null };
    expect(deriveStage(f({ stage: D2C_STAGE.PARTLY_DISPATCHED, soState: 'created', lines: [{ updatedQty: 4, dispatched: 4 }], invoices: [inv] }))).toBe(D2C_STAGE.DISPATCHED);
    expect(deriveStage(f({ stage: D2C_STAGE.SALE_ORDER, soState: 'created', lines: [{ updatedQty: 10, dispatched: 4 }], invoices: [inv] }))).toBe(D2C_STAGE.PARTLY_DISPATCHED);
  });
  it('cancelled stays cancelled', () => {
    expect(deriveStage(f({ stage: D2C_STAGE.CANCELLED, soState: 'created' }))).toBe(D2C_STAGE.CANCELLED);
  });
});

describe('background pool', () => {
  it('runs every item, at most `limit` at a time', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      running -= 1;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
