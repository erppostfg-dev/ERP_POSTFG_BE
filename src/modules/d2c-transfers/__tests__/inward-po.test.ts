import fs from 'fs';
import path from 'path';
import type { EntityManager, QueryRunner } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { D2C_STAGE, D2C_TAB, SHIPMENT_LOG_ACTION } from '../../../constants';
import { HttpError } from '../../intransit/sources/http';
import {
  decideAfterPoCreate, decideAfterPoGet, inwardCodeOf, inwardDatesOf, inwardItemsOf, inwardReconcileCheck, InwardReserveFacts, inwardReserveBlock,
  invoiceReceivingOf, nextInwardNumber, receivingOfRemark, receivingRemark, varianceBlock, varianceBodyOf, varianceRemark,
} from '../inward-po.service';
import { deriveStage, tabsOf } from '../stage';
import {
  combineSyncErrors, GrnInvoice, GrnPlan, GrnState, grnsToRead, isCancelledPo, joinInwardCodes, planGrn, RunErrors, stageInvoices,
} from '../sync-plan';
import {
  buildInwardPoPayload, classifyPo, createPurchaseOrder, getPurchaseOrder, grnCodesOf, grnDetailOf, InwardPoInput, poDetailOf, UniwarePoster,
} from '../uniware-transfers';

/*
 * Phase 7 (inward POs + GRN + variance reason), no database: reserve rules, code numbering, the create payload, what
 * a create / details answer means, the GRN mapping from real read-only answers (PO MGGN1/2627/API/0051 + GRN G8221 at
 * GGN_WAREHOUSE, our test PO erp_it_TEST-1 at TEST_FACILITY; addresses / emails / phones dropped), the variance and
 * closing rules, and that a second sync with no Uniware change plans nothing.
 */

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as Record<string, unknown>;
const refusal = (p: string, message: string, code = 40001) =>
  new Error(`${p} refused: ${JSON.stringify([{ code, fieldName: null, description: message, message, errorParams: null }])}`);
const NOW = new Date('2026-11-03T10:00:00Z');
const SKU = 'MCFMUBX0354F0050';

type Call = { path: string; body: unknown; facility?: string };
const fakeApi = (answer: (c: Call) => unknown) => {
  const calls: Call[] = [];
  const api: UniwarePoster = {
    post: <T extends Record<string, unknown>>(p: string, body: unknown, facility?: string): Promise<T> => {
      const c = { path: p, body, facility };
      calls.push(c);
      try {
        return Promise.resolve(answer(c) as T);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
  return { api, calls };
};

describe('inward PO code <SO code>-<n>', () => {
  const so = 'erp_it_20261103001';
  it('first invoice -1, next -2; codes of other SOs and junk do not count', () => {
    expect(nextInwardNumber(so, [])).toBe(1);
    expect(nextInwardNumber(so, [null, `${so}-1`])).toBe(2);
    expect(nextInwardNumber(so, [`${so}-1`, `${so}-3`, 'erp_it_20261103002-9', `${so}-x`])).toBe(4);
    expect(inwardCodeOf(so, null, [null, null])).toBe(`${so}-1`);
    expect(inwardCodeOf(so, null, [`${so}-1`, null])).toBe(`${so}-2`);
  });
  it('stable once reserved: a retry after failed keeps its own code', () => {
    expect(inwardCodeOf(so, `${so}-1`, [`${so}-1`, `${so}-2`])).toBe(`${so}-1`);
  });
});

describe('reserve rules (plan 5.5)', () => {
  const ok: InwardReserveFacts = {
    soState: 'created', soCode: 'erp_it_20261103001', reference: 'TEST_RECV|03Nov2026|1', sender: 'TEST_FACILITY', receiving: 'TEST_RECV',
    route: { vendorCode: 'Test_Vendor' },
    invoice: { dispatchedAt: NOW, packageStatus: 'DISPATCHED', inwardPoState: null, inwardPoCode: null, skuQty: { A: { dispatched: 5, inward: 0, received: 0 } } },
  };
  const inv = (o: Partial<InwardReserveFacts['invoice']>) => ({ ...ok, invoice: { ...ok.invoice, ...o } });
  it('a dispatched invoice with a vendor and dispatched units passes; failed may be retried', () => {
    expect(inwardReserveBlock(ok)).toBeNull();
    expect(inwardReserveBlock(inv({ inwardPoState: 'failed', inwardPoCode: 'erp_it_20261103001-1' }))).toBeNull();
  });
  it('vendor missing on the route -> fill it in Masters', () => {
    expect(inwardReserveBlock({ ...ok, route: { vendorCode: null } })).toBe('vendor code missing on route TEST_FACILITY -> TEST_RECV: fill it in Masters');
    expect(inwardReserveBlock({ ...ok, route: null })).toContain('vendor code missing on route');
  });
  it('nothing dispatched / not dispatched / cancelled package', () => {
    expect(inwardReserveBlock(inv({ skuQty: { A: { dispatched: 0, inward: 0, received: 0 } } }))).toBe('nothing was dispatched on this invoice');
    expect(inwardReserveBlock(inv({ skuQty: null }))).toBe('nothing was dispatched on this invoice');
    expect(inwardReserveBlock(inv({ dispatchedAt: null }))).toBe('the invoice is not dispatched');
    expect(inwardReserveBlock(inv({ packageStatus: 'CANCELLED' }))).toBe('the invoice is not dispatched');
  });
  it('already created / in flight / no SO / no receiving facility', () => {
    expect(inwardReserveBlock(inv({ inwardPoState: 'created', inwardPoCode: 'X-1' }))).toBe('it already has inward PO X-1');
    expect(inwardReserveBlock(inv({ inwardPoState: 'requested', inwardPoCode: 'X-1' }))).toContain('is requested: wait');
    expect(inwardReserveBlock(inv({ inwardPoState: 'unknown', inwardPoCode: 'X-1' }))).toContain('is unknown: wait');
    expect(inwardReserveBlock({ ...ok, soState: 'failed' })).toBe('its transfer has no sale order in Uniware');
    expect(inwardReserveBlock({ ...ok, receiving: null })).toContain('no receiving facility');
  });
});

describe('create payload (contract proven on TEST_FACILITY)', () => {
  const input: InwardPoInput = {
    code: 'erp_it_20261103001-2', vendorCode: 'Test_Vendor', facility: 'TEST_RECV', soCode: 'erp_it_20261103001', reference: 'TEST_RECV|03Nov2026|1',
    receiveBy: '2026-11-10', expiry: '2026-11-18', items: inwardItemsOf({ B: { dispatched: 3, inward: 0, received: 0 }, A: { dispatched: 7, inward: 0, received: 0 }, C: { dispatched: 0, inward: 0, received: 0 } }),
  };
  it('qty per SKU = dispatched on that invoice (0 left out), unit price 1, custom fields, deliveryDate = receive by, expiryDate = PO date + 15', () => {
    expect(buildInwardPoPayload(input)).toEqual({
      purchaseOrderCode: 'erp_it_20261103001-2', vendorCode: 'Test_Vendor', expiryDate: '2026-11-18', deliveryDate: '2026-11-10',
      purchaseOrderItems: [{ itemSKU: 'A', quantity: 7, unitPrice: 1 }, { itemSKU: 'B', quantity: 3, unitPrice: 1 }],
      customFieldValues: [{ name: 'ReferenceNo', value: 'erp_it_20261103001' }, { name: 'ReferenceOrder', value: 'TEST_RECV|03Nov2026|1' }],
    });
  });
  it('is sent with Facility = the RECEIVING facility', async () => {
    const { api, calls } = fakeApi(() => ({ successful: true, purchaseOrderCode: input.code }));
    await createPurchaseOrder(api, input);
    expect(calls).toEqual([{ path: '/services/rest/v1/purchase/purchaseOrder/create', body: buildInwardPoPayload(input), facility: 'TEST_RECV' }]);
  });
  it('dates: PO date = today, receive by from the dialog (today .. expiry), expiry = PO date + 15 (user, 2026-11-12)', () => {
    expect(inwardDatesOf('2026-11-10', '2026-11-03')).toEqual({ receiveBy: '2026-11-10', expiry: '2026-11-18' });
    expect(inwardDatesOf('10-11-2026', '2026-11-03')).toEqual({ receiveBy: '2026-11-10', expiry: '2026-11-18' });
    expect(inwardDatesOf('2026-11-03', '2026-11-03')).toEqual({ receiveBy: '2026-11-03', expiry: '2026-11-18' });
    expect(inwardDatesOf('2026-11-18', '2026-11-03')).toEqual({ receiveBy: '2026-11-18', expiry: '2026-11-18' });
    expect(inwardDatesOf('2026-11-19', '2026-11-03')).toHaveProperty('error');
    expect(inwardDatesOf('2026-11-02', '2026-11-03')).toHaveProperty('error');
    expect(inwardDatesOf('', '2026-11-03')).toHaveProperty('error');
    expect(inwardDatesOf(undefined, '2026-11-03')).toHaveProperty('error');
    expect(inwardDatesOf('next week', '2026-11-03')).toHaveProperty('error');
  });
});

describe('what an answer means', () => {
  const P = '/services/rest/v1/purchase/purchaseOrder/create';
  it('create: success = created; refusal = failed; DUPLICATE_CODE (30002) or HTTP error = look it up', () => {
    expect(decideAfterPoCreate({ ok: true, response: {} })).toEqual({ state: 'created', error: null });
    expect(decideAfterPoCreate({ ok: false, error: refusal(P, 'INVALID_VENDOR') })).toMatchObject({ state: 'failed', error: expect.stringContaining('INVALID_VENDOR') });
    expect(classifyPo(refusal(P, 'DUPLICATE_CODE', 30002))).toBe('duplicate');
    expect(classifyPo(refusal(P, 'something', 30002))).toBe('duplicate');
    expect(decideAfterPoCreate({ ok: false, error: refusal(P, 'DUPLICATE_CODE', 30002) })).toMatchObject({ state: 'reconcile' });
    expect(decideAfterPoCreate({ ok: false, error: new HttpError(502, 'bad gateway') })).toMatchObject({ state: 'reconcile', error: expect.stringContaining('no answer') });
    expect(decideAfterPoCreate({ ok: false, error: new Error('timeout') })).toMatchObject({ state: 'reconcile' });
  });
  it('details get: found with our SO code = created; other SO code = unknown; invalid code = failed; get error = unknown (never failed)', () => {
    const po = poDetailOf(fixture('po-details-created.json'));
    expect(decideAfterPoGet({ kind: 'found', po }, 'erp_it_TEST')).toEqual({ state: 'created', error: null });
    expect(decideAfterPoGet({ kind: 'found', po }, 'erp_it_OTHER')).toMatchObject({ state: 'unknown', error: expect.stringContaining('check it in Uniware') });
    expect(decideAfterPoGet({ kind: 'not_found' }, 'erp_it_TEST')).toMatchObject({ state: 'failed' });
    expect(decideAfterPoGet({ kind: 'error', error: new HttpError(500, 'boom') }, 'erp_it_TEST')).toMatchObject({ state: 'unknown', error: expect.stringContaining('could not check') });
  });
  it('reconcile check: grace, invalid code (80060) -> failed, HTTP error -> unknown, found -> created; asked at the receiving facility', async () => {
    const inv = { inwardPoState: 'unknown', inwardPoRequestedAt: new Date(NOW.getTime() - 60_000), inwardPoCode: 'erp_it_TEST-1' };
    const ctx = { soCode: 'erp_it_TEST', receiving: 'TEST_FACILITY' };
    const none = fakeApi(() => ({}));
    expect(await inwardReconcileCheck(inv, ctx, none.api, 15 * 60_000, NOW.getTime())).toEqual({ checked: false, why: 'still within the grace period' });
    expect(none.calls).toHaveLength(0);
    const invalid = fakeApi(() => { throw refusal('/x', 'INVALID_PURCHASE_ORDER_CODE', 80060); });
    expect(await inwardReconcileCheck(inv, ctx, invalid.api, 0)).toMatchObject({ checked: true, state: 'failed' });
    const down = fakeApi(() => { throw new HttpError(503, 'down'); });
    expect(await inwardReconcileCheck(inv, ctx, down.api, 0)).toMatchObject({ checked: true, state: 'unknown' });
    const found = fakeApi(() => fixture('po-details-created.json'));
    expect(await inwardReconcileCheck(inv, ctx, found.api, 0)).toMatchObject({ checked: true, state: 'created', poStatus: 'CREATED' });
    expect(found.calls[0]).toMatchObject({ path: '/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails', body: { purchaseOrderCode: 'erp_it_TEST-1' }, facility: 'TEST_FACILITY' });
    expect(await inwardReconcileCheck({ ...inv, inwardPoState: 'created' }, ctx, found.api, 0)).toMatchObject({ checked: false });
  });
  it('getPurchaseOrder: unknown code = null, other refusals thrown', async () => {
    expect((await getPurchaseOrder(fakeApi(() => { throw refusal('/x', 'INVALID_PURCHASE_ORDER_CODE', 80060); }).api, 'X', 'F')).po).toBeNull();
    await expect(getPurchaseOrder(fakeApi(() => { throw refusal('/x', 'SOMETHING_ELSE'); }).api, 'X', 'F')).rejects.toThrow('SOMETHING_ELSE');
  });
});

describe('real PO / GRN answers', () => {
  it('PO details: code, status, vendor, custom fields, items', () => {
    const po = poDetailOf(fixture('po-details.json'));
    expect(po).toEqual({
      code: 'MGGN1/2627/API/0051', status: 'COMPLETE', vendorCode: 'Mcaff_Gurgaon3_',
      fields: { ReferenceNo: '20270902460', ReferenceOrder: 'GGN_WAREHOUSE|21Oct2026|Int15' },
      items: [{ sku: SKU, qty: 170, pending: 0, rejected: 0, received: 170 }],
    });
    expect(poDetailOf(fixture('po-details-created.json'))).toMatchObject({ code: 'erp_it_TEST-1', status: 'CREATED', vendorCode: 'Test_Vendor', items: [{ sku: 'TEST_UNICOM1', qty: 1, pending: 1, received: 0 }] });
  });
  it('GRN list + detail: accepted = quantity - rejected, done time = qcCompletedOn', async () => {
    expect(await grnCodesOf(fakeApi(() => fixture('grn-list.json')).api, 'MGGN1/2627/API/0051', 'GGN_WAREHOUSE')).toEqual(['G8221']);
    const g = grnDetailOf((fixture('grn-get.json').inflowReceipt) as Record<string, unknown>);
    expect(g).toMatchObject({ code: 'G8221', status: 'COMPLETE', poCode: 'MGGN1/2627/API/0051', vendorInvoiceNumber: '20270902460', accepted: 170, rejected: 0 });
    expect(g.items).toEqual([{ sku: SKU, qty: 170, rejected: 0, accepted: 170 }]);
    expect(g.doneAt?.toISOString()).toBe(new Date(1792581245000).toISOString());
    const rej = grnDetailOf({ code: 'G1', statusCode: 'complete', inflowReceiptItems: [{ itemSKU: 'A', quantity: 10, rejectedQuantity: 3 }] });
    expect(rej).toMatchObject({ status: 'COMPLETE', accepted: 7, rejected: 3, doneAt: null });
  });
});

// ---- GRN plan ------------------------------------------------------------------------------------------------------

const invoice = (o: Partial<GrnInvoice> = {}): GrnInvoice => ({
  id: '1', shippingPackageCode: 'SP/1', invoiceCode: 'SI/1', invoiceDisplayCode: 'SI/1', packageStatus: 'DISPATCHED', dispatchedAt: NOW, units: 170,
  skuQty: { [SKU]: { dispatched: 170, inward: 170, received: 0 } }, inwardPoCode: 'erp_it_20261103001-1', inwardPoState: 'created', inwardPoStatus: 'CREATED',
  grnCodes: null, receivedUnits: 0, grnCompletedAt: null, varianceReason: null, ...o,
});
const state = (invoices: GrnInvoice[], dispatched = 170, updated = 170): GrnState => ({
  header: { uid: '900', transferStage: D2C_STAGE.INWARD_PO_CREATED, soState: 'created', deliveryDate: null, poNumberInwardCWH: 'erp_it_20261103001-1' },
  lines: [{ id: '11', skuCode: SKU, qty: 192, updatedQty: updated, dispatchedQty: dispatched, channelInwardingQuantity: null }],
  invoices,
});
const grn = (code: string, qty: number, status = 'COMPLETE', rejected = 0, at = 1792581245000) => grnDetailOf({
  code, statusCode: status, qcCompletedOn: at, inflowReceiptItems: [{ itemSKU: SKU, quantity: qty, rejectedQuantity: rejected }],
});
const po = (status: string) => ({ ...poDetailOf(fixture('po-details.json')), status });
/** The stored rows after a plan is written (what syncGrnOne does in SQL). */
const apply = (s: GrnState, id: string, p: GrnPlan): GrnState => ({
  header: { ...s.header, ...(p.header as Partial<GrnState['header']>) },
  lines: s.lines.map((l) => ({ ...l, ...(p.lines.find((x) => x.id === l.id)?.set ?? {}) })),
  invoices: s.invoices.map((i) => (i.id === id ? { ...i, ...p.invoice } : i)),
});
const actions = (p: GrnPlan) => p.logs.map((l) => `${l.action}:${l.field ?? ''}`).sort();

describe('planGrn (plan 6 step 3)', () => {
  it('the real PO + GRN: complete, received 170 = dispatched -> closed; deliveryDate = GRN day; a second run plans nothing', () => {
    const s = state([invoice()]);
    const g = grnDetailOf((fixture('grn-get.json').inflowReceipt) as Record<string, unknown>);
    const p = planGrn(s, { invoiceId: '1', po: poDetailOf(fixture('po-details.json')), codes: ['G8221'], grns: [g] }, NOW);
    expect(p.complete).toBe(true);
    expect(p.invoice).toMatchObject({ receivedUnits: 170, inwardPoStatus: 'COMPLETE', skuQty: { [SKU]: { dispatched: 170, inward: 170, received: 170 } } });
    expect(p.invoice.grnCompletedAt?.toISOString()).toBe(new Date(1792581245000).toISOString());
    expect(p.invoice.grnCodes).toEqual([{ code: 'G8221', date: new Date(1792581245000).toISOString(), units: 170, status: 'COMPLETE', rejected: 0, skus: { [SKU]: 170 } }]);
    expect(p.lines).toEqual([{ id: '11', set: { channelInwardingQuantity: 170 } }]);
    expect(p.header).toMatchObject({ deliveryDate: '2026-10-21', transferStage: D2C_STAGE.CLOSED, statusLogistics: 'Inward Done' });
    expect(p.stage).toBe(D2C_STAGE.CLOSED);
    expect(actions(p)).toEqual([
      'field_changed:channelInwardingQuantity', 'field_changed:deliveryDate', 'field_changed:inwardPoStatus', 'grn_received:grnCodes', 'grn_received:grnCompletedAt', 'stage_changed:transferStage',
    ]);
    const after = apply(s, '1', p);
    // the next read: the COMPLETE GRN is not read again
    expect(grnsToRead(after.invoices[0].grnCodes, ['G8221'])).toEqual([]);
    const again = planGrn(after, { invoiceId: '1', po: poDetailOf(fixture('po-details.json')), codes: ['G8221'], grns: [] }, NOW);
    expect(again).toMatchObject({ changed: false, logs: [], invoice: {}, lines: [], header: {} });
  });

  it('PO approved, one GRN so far: received counted, not complete, stage stays inward_po_created', () => {
    const s = state([invoice()]);
    const p = planGrn(s, { invoiceId: '1', po: po('APPROVED'), codes: ['G1'], grns: [grn('G1', 100)] }, NOW);
    expect(p.complete).toBe(false);
    expect(p.invoice).toMatchObject({ receivedUnits: 100, inwardPoStatus: 'APPROVED' });
    expect(p.invoice.grnCompletedAt).toBeUndefined();
    expect(p.stage).toBe(D2C_STAGE.INWARD_PO_CREATED);
    expect(p.lines[0].set).toEqual({ channelInwardingQuantity: 100 });
  });

  it('two GRNs: the sum counts; short by 10 -> grn (variance open); the variance reason closes it', () => {
    let s = state([invoice()]);
    s = apply(s, '1', planGrn(s, { invoiceId: '1', po: po('APPROVED'), codes: ['G1'], grns: [grn('G1', 100, 'COMPLETE', 0, 1792581245000)] }, NOW));
    const toRead = grnsToRead(s.invoices[0].grnCodes, ['G1', 'G2']);
    expect(toRead).toEqual(['G2']);
    const p = planGrn(s, { invoiceId: '1', po: po('COMPLETE'), codes: ['G1', 'G2'], grns: [grn('G2', 60, 'COMPLETE', 0, 1792667645000)] }, NOW);
    expect(p.complete).toBe(true);
    expect(p.invoice.receivedUnits).toBe(160);
    expect(p.invoice.grnCompletedAt?.toISOString()).toBe(new Date(1792667645000).toISOString());
    expect(p.stage).toBe(D2C_STAGE.GRN);
    const grnLogs = p.logs.filter((l) => l.action === SHIPMENT_LOG_ACTION.GRN_RECEIVED);
    expect(grnLogs.map((l) => l.field)).toEqual(['grnCodes', 'grnCompletedAt']);
    expect(grnLogs[1].remark).toContain('received 160 of 170 dispatched (variance -10)');
    s = apply(s, '1', p);
    const inv = s.invoices[0];
    expect(varianceBlock(inv)).toBeNull();
    const withReason = { ...inv, varianceReason: 'short_received' };
    // a saved reason may be changed by an editor (user, 2026-11-03)
    expect(varianceBlock(withReason)).toBeNull();
    const stage = deriveStage({ stage: D2C_STAGE.GRN, soState: 'created', lines: [{ updatedQty: 170, dispatched: 170 }], invoices: stageInvoices([withReason]) });
    expect(stage).toBe(D2C_STAGE.CLOSED);
  });

  it('a GRN not COMPLETE yet keeps the invoice open even when the PO says COMPLETE, and is read again', () => {
    const s = state([invoice()]);
    const p = planGrn(s, { invoiceId: '1', po: po('COMPLETE'), codes: ['G1'], grns: [grn('G1', 170, 'QC_PENDING')] }, NOW);
    expect(p.complete).toBe(false);
    expect(p.invoice.receivedUnits).toBe(170);
    const after = apply(s, '1', p);
    expect(grnsToRead(after.invoices[0].grnCodes, ['G1'])).toEqual(['G1']);
    const p2 = planGrn(after, { invoiceId: '1', po: po('COMPLETE'), codes: ['G1'], grns: [grn('G1', 170, 'COMPLETE')] }, NOW);
    expect(p2.complete).toBe(true);
    expect(p2.logs.find((l) => l.field === 'grnCodes')?.remark).toContain('GRN G1 updated');
  });

  it('rejected units are not received (variance -3 -> grn); excess shows as + variance', () => {
    const s = state([invoice()]);
    const p = planGrn(s, { invoiceId: '1', po: po('COMPLETE'), codes: ['G1'], grns: [grn('G1', 170, 'COMPLETE', 3)] }, NOW);
    expect(p.invoice.receivedUnits).toBe(167);
    expect(p.stage).toBe(D2C_STAGE.GRN);
    const ex = planGrn(s, { invoiceId: '1', po: po('COMPLETE'), codes: ['G1'], grns: [grn('G1', 172)] }, NOW);
    expect(ex.invoice.receivedUnits).toBe(172);
    expect(ex.logs.find((l) => l.field === 'grnCompletedAt')?.remark).toContain('variance +2');
  });

  it('two invoices of one SKU: line received = sum over invoices; partly dispatched stays partly_dispatched', () => {
    const a = invoice({ id: '1', units: 100, skuQty: { [SKU]: { dispatched: 100, inward: 100, received: 100 } }, receivedUnits: 100, grnCompletedAt: NOW, grnCodes: [{ code: 'G0', date: null, units: 100, status: 'COMPLETE', skus: { [SKU]: 100 } }] });
    const b = invoice({ id: '2', shippingPackageCode: 'SP/2', units: 50, skuQty: { [SKU]: { dispatched: 50, inward: 50, received: 0 } } });
    const s = { ...state([a, b], 150, 192), header: { ...state([]).header, transferStage: D2C_STAGE.PARTLY_DISPATCHED } };
    const p = planGrn(s, { invoiceId: '2', po: po('COMPLETE'), codes: ['G9'], grns: [grn('G9', 50)] }, NOW);
    expect(p.lines[0].set).toEqual({ channelInwardingQuantity: 150 });
    expect(p.stage).toBe(D2C_STAGE.PARTLY_DISPATCHED);
  });
});

describe('closing rules + tabs (plan 1.1 / 1.3)', () => {
  const base = { packageStatus: 'DISPATCHED', invoiced: true, dispatched: true, inwardPoState: 'created' as string | null, grnCompleted: true, variance: 0, varianceReason: null as string | null };
  const st = (invoices: (typeof base)[], balance = 0) => deriveStage({ stage: D2C_STAGE.DISPATCHED, soState: 'created', lines: [{ updatedQty: 10 + balance, dispatched: 10 }], invoices });
  it('dispatched -> inward_po_created -> grn -> closed', () => {
    expect(st([{ ...base, inwardPoState: null }])).toBe(D2C_STAGE.DISPATCHED);
    expect(st([{ ...base, inwardPoState: 'requested' }])).toBe(D2C_STAGE.DISPATCHED);
    expect(st([{ ...base, grnCompleted: false }])).toBe(D2C_STAGE.INWARD_PO_CREATED);
    expect(st([base, { ...base, variance: -2 }])).toBe(D2C_STAGE.GRN);
    expect(st([base, { ...base, variance: -2, varianceReason: 'damaged' }])).toBe(D2C_STAGE.CLOSED);
    expect(st([base], 5)).toBe(D2C_STAGE.PARTLY_DISPATCHED);
  });
  it('tabs: Create inward PO while an invoice has none / failed; Inward POs while in flight or created and not closed', () => {
    const f = (inv: { dispatched: boolean; inwardPoState: string | null }[], stage: string = D2C_STAGE.DISPATCHED) => tabsOf({ stage, soState: 'created', openBalance: 0, invoices: inv });
    expect(f([{ dispatched: true, inwardPoState: null }])).toContain(D2C_TAB.CREATE_INWARD_PO);
    expect(f([{ dispatched: true, inwardPoState: 'failed' }])).toContain(D2C_TAB.CREATE_INWARD_PO);
    expect(f([{ dispatched: true, inwardPoState: 'created' }], D2C_STAGE.GRN)).toEqual([D2C_TAB.INWARD_POS, D2C_TAB.OVERVIEW]);
    expect(f([{ dispatched: true, inwardPoState: 'created' }], D2C_STAGE.CLOSED)).toEqual([D2C_TAB.OVERVIEW]);
  });
});

describe('variance reason + header codes', () => {
  it('only once GRN-complete, with variance != 0, no reason yet', () => {
    expect(varianceBlock({ grnCompletedAt: null, receivedUnits: 5, units: 10, varianceReason: null })).toBe('its GRN is not complete yet');
    expect(varianceBlock({ grnCompletedAt: NOW, receivedUnits: 10, units: 10, varianceReason: null })).toContain('no variance');
    expect(varianceBlock({ grnCompletedAt: NOW, receivedUnits: 12, units: 10, varianceReason: null })).toBeNull();
  });
  it('body: reason from the list, note required for other, note length', () => {
    expect(varianceBodyOf({ reason: 'damaged', note: '  2 broken ' })).toEqual({ reason: 'damaged', note: '2 broken' });
    expect(varianceBodyOf({ reason: 'excess' })).toEqual({ reason: 'excess', note: null });
    expect(() => varianceBodyOf({ reason: 'lost' })).toThrow();
    expect(() => varianceBodyOf({ reason: 'other' })).toThrow();
    expect(() => varianceBodyOf({ reason: 'damaged', note: 'x'.repeat(1001) })).toThrow();
  });
  it('poNumberInwardCWH = created codes in invoice order', () => {
    expect(joinInwardCodes([
      { id: '3', inwardPoState: 'created', inwardPoCode: 'S-2' }, { id: '1', inwardPoState: 'created', inwardPoCode: 'S-1' }, { id: '2', inwardPoState: 'failed', inwardPoCode: 'S-3' },
    ])).toBe('S-1, S-2');
    expect(joinInwardCodes([{ id: '1', inwardPoState: 'requested', inwardPoCode: 'S-1' }])).toBeNull();
  });
});

describe('fixes of 2026-11-03', () => {
  describe('receiving facility column (migration D2cInvoiceReceiving1794100000000)', () => {
    const fakeM = (remark: string | null) => {
      const calls: unknown[][] = [];
      const m = { query: async (sql: string, params: unknown[]) => { calls.push([sql, params]); return remark === null ? [] : [{ remark }]; } } as unknown as EntityManager;
      return { m, calls };
    };
    it('the column wins: no log read', async () => {
      const { m, calls } = fakeM('receiving=OLD | x');
      expect(await invoiceReceivingOf(m, { poUid: '7', inwardPoCode: 'S-1', receivingFacilityCode: 'NEW_FAC' })).toBe('NEW_FAC');
      expect(calls).toHaveLength(0);
    });
    it('column NULL (row made before the migration): the inward_po_requested log remark of that code', async () => {
      const { m, calls } = fakeM('receiving=LOG_FAC | SI/1 | {}');
      expect(await invoiceReceivingOf(m, { poUid: '7', inwardPoCode: 'S-1', receivingFacilityCode: null })).toBe('LOG_FAC');
      expect(calls[0][1]).toEqual(['7', SHIPMENT_LOG_ACTION.INWARD_PO_REQUESTED, 'S-1']);
    });
    it('nothing recorded / no code: null', async () => {
      expect(await invoiceReceivingOf(fakeM(null).m, { poUid: '7', inwardPoCode: 'S-1', receivingFacilityCode: null })).toBeNull();
      const { m, calls } = fakeM('receiving=X');
      expect(await invoiceReceivingOf(m, { poUid: '7', inwardPoCode: null, receivingFacilityCode: null })).toBeNull();
      expect(calls).toHaveLength(0);
    });
    it('migration: adds the column, backfills from the latest log remark, down drops it', async () => {
      const { D2cInvoiceReceiving1794100000000 } = await import('../../../migrations/1794100000000-D2cInvoiceReceiving');
      const sql: string[] = [];
      const qr = { query: async (q: string) => { sql.push(q); return []; } } as unknown as QueryRunner;
      const mig = new D2cInvoiceReceiving1794100000000();
      await mig.up(qr);
      expect(sql[0]).toMatch(/ALTER TABLE `po_invoices` ADD `receiving_facility_code` varchar\(100\) NULL/);
      expect(sql[1]).toMatch(/UPDATE `po_invoices`/);
      expect(sql[1]).toMatch(/MAX\(x\.id\)/);
      expect(sql[1]).toMatch(/inward_po_requested/);
      expect(sql[1]).toMatch(/LIKE 'receiving=%'/);
      await mig.down(qr);
      expect(sql[2]).toMatch(/DROP COLUMN `receiving_facility_code`/);
    });
  });

  it('receiving facility: stored in the inward_po_requested remark and read back', () => {
    const remark = receivingRemark('TEST_RECV', 'SI/1 | {"facility":"TEST_RECV"}');
    expect(remark.startsWith('receiving=TEST_RECV | SI/1')).toBe(true);
    expect(receivingOfRemark(remark)).toBe('TEST_RECV');
    expect(receivingOfRemark('receiving=DS_NCR_PD_OKHLAHUB_939')).toBe('DS_NCR_PD_OKHLAHUB_939');
    expect(receivingOfRemark('SI/1 | {"facility":"X"}')).toBeNull();
    expect(receivingOfRemark(null)).toBeNull();
  });

  it('one combined syncError per run: SO fine + GRN failing gives the same text every run (no flip)', () => {
    const run = (grnErrors: string[], so: string | null = null) => {
      const e = new RunErrors();
      e.so('1', so);
      for (const g of grnErrors) e.grn('1', g);
      e.grn('2', null);
      return Object.fromEntries(e.results());
    };
    const first = run(['GRN b failed', 'GRN a failed']);
    expect(first).toEqual({ 1: 'GRN a failed | GRN b failed', 2: null });
    expect(run(['GRN a failed', 'GRN b failed'])).toEqual(first);
    expect(run(['GRN a failed'], 'SO read failed')[1]).toBe('SO read failed | GRN a failed');
    expect(combineSyncErrors({ so: null, grn: [] })).toBeNull();
    expect(combineSyncErrors({ so: null, grn: ['x', 'x'] })).toBe('x');
  });

  it('PO cancelled in Uniware (no GRN): back to Create inward PO, code cleared, logged, header + stage follow', () => {
    const s = state([invoice({ inwardPoStatus: 'APPROVED' })]);
    const read = { invoiceId: '1', po: po('CANCELLED'), codes: [], grns: [] };
    expect(isCancelledPo(read)).toBe(true);
    const p = planGrn(s, read, NOW);
    expect(p.invoice).toMatchObject({
      inwardPoState: 'failed', inwardPoCode: null, inwardPoStatus: 'CANCELLED', inwardPoError: 'Inward PO erp_it_20261103001-1 cancelled in Uniware (status CANCELLED)',
      grnCodes: null, grnCompletedAt: null, skuQty: { [SKU]: { dispatched: 170, inward: 0, received: 0 } },
    });
    expect(p.header).toMatchObject({ poNumberInwardCWH: null, transferStage: D2C_STAGE.DISPATCHED });
    expect(p.stage).toBe(D2C_STAGE.DISPATCHED);
    const failed = p.logs.find((l) => l.action === SHIPMENT_LOG_ACTION.INWARD_PO_FAILED);
    expect(failed).toMatchObject({ oldValue: 'created', newValue: 'failed', uniwareStatus: 'PO CANCELLED' });
    // the invoice is in the Create inward PO tab again
    expect(tabsOf({ stage: p.stage, soState: 'created', openBalance: 0, invoices: [{ dispatched: true, inwardPoState: 'failed' }] })).toContain(D2C_TAB.CREATE_INWARD_PO);
    // with a GRN it is not treated as cancelled (a person must look)
    expect(isCancelledPo({ po: po('CANCELLED'), codes: ['G1'] })).toBe(false);
  });

  it('after a cancel the next create takes the next code (the cancelled code is kept in the requested log)', () => {
    const so = 'erp_it_20261103001';
    // invoice codes (the cancelled one cleared) + every code of the inward_po_requested log rows
    expect(inwardCodeOf(so, null, [null, `${so}-1`])).toBe(`${so}-2`);
    expect(inwardCodeOf(so, null, [null, null, `${so}-1`, `${so}-2`])).toBe(`${so}-3`);
  });

  it('variance reason: editable after saving; the log keeps old -> new note', () => {
    expect(varianceBlock({ grnCompletedAt: NOW, receivedUnits: 8, units: 10, varianceReason: 'damaged' })).toBeNull();
    expect(varianceRemark('SI/1 | variance -2', null, '2 torn')).toBe('SI/1 | variance -2 | 2 torn');
    expect(varianceRemark('SI/1 | variance -2', '2 torn', '2 missing')).toBe('SI/1 | variance -2 | note: 2 torn -> 2 missing');
    expect(varianceRemark('SI/1 | variance -2', '2 torn', '2 torn')).toBe('SI/1 | variance -2 | 2 torn');
  });
});
