import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { soDetailOf } from '../sale-order';
import { fullyDispatched, planPoSync, PoSyncState, warehouseStepOf } from '../plan';

/*
 * Channel PO Uniware sync, no database (2026-11-06): real saleorder/get answers (D2C's fixtures of 2026-11-03, copied here) and
 * small hand-made ones -> what changes on the PO: statuses forward only, dates / invoice only when empty.
 */
const fixture = (name: string) =>
  soDetailOf((JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as { saleOrderDTO: Record<string, unknown> }).saleOrderDTO);
const NOW = new Date('2026-11-06T06:00:00Z');
const state = (o: Partial<PoSyncState> = {}): PoSyncState => ({
  statusPlanning: 'Confirmed', statusWarehouse: null, statusLogistics: null, rtsDate: null, dispatchDate: null, invoiceChallanNumber: null,
  invoiceDate: null, invoiceValue: null, uniwareStatus: null, syncError: null, ...o,
});
/** A sale order with one line of 10 and packages in the given statuses. */
const so = (packages: string[], completed = 0, extra: Record<string, unknown> = {}) => soDetailOf({
  code: 'erp_1', status: 'PROCESSING', ...extra,
  saleOrderItems: [{ code: 'A', itemSku: 'mcaf1', statusCode: completed >= 10 ? 'DISPATCHED' : 'FULFILLABLE', totalQuantity: 10, cancelledQuantity: 0, completedQuantity: completed, sellingPrice: 100 }],
  shippingPackages: packages.map((s, i) => ({ code: `SP/${i + 1}`, status: s, items: { mcaf1: { itemSku: 'mcaf1', quantity: 10 } } })),
});

describe('real answers', () => {
  it('dispatched + invoiced (so-get-rts): Dispatched / Dispatched, RTS + dispatch dates, invoice; done', () => {
    const p = planPoSync(state(), fixture('so-get-rts.json'), NOW);
    expect(p.set).toMatchObject({
      statusWarehouse: 'Dispatched', statusLogistics: 'Dispatched', rtsDate: '2026-11-06', dispatchDate: '2026-10-22',
      invoiceChallanNumber: 'PEP2627MH/0201', invoiceDate: '2026-10-21', invoiceValue: 1831.9, uniwareStatus: 'COMPLETE | MW/2627/SP50429 DISPATCHED',
    });
    expect(p.done).toBe(true);
    expect(p.logs.map((l) => l.field)).toEqual(['statusWarehouse', 'statusLogistics', 'rtsDate', 'dispatchDate', 'invoiceChallanNumber', 'invoiceDate', 'invoiceValue']);
  });

  it('partly cancelled in Uniware (192 ordered, 22 cancelled, 170 dispatched; the line says CANCELLED) is fully dispatched', () => {
    const s = fixture('so-get.json');
    expect(fullyDispatched(s)).toBe(true);
    expect(planPoSync(state(), s, NOW).set.statusWarehouse).toBe('Dispatched');
  });

  it('the same answer again changes nothing (nothing logged)', () => {
    const s = fixture('so-get-rts.json');
    const first = planPoSync(state(), s, NOW);
    const again = planPoSync(state(first.set), s, new Date('2026-11-07T06:00:00Z'));
    expect(again.set).toEqual({});
    expect(again.logs).toEqual([]);
  });
});

describe('the warehouse steps, forward only', () => {
  it('package steps: CREATED / PICKING = Picking, PACKED = Packed, READY_TO_SHIP / MANIFESTED = RTS; part dispatched = still RTS', () => {
    expect(warehouseStepOf(so([]))).toBeNull();
    expect(warehouseStepOf(so(['CREATED']))).toBe('Picking');
    expect(warehouseStepOf(so(['PACKED']))).toBe('Packed');
    expect(warehouseStepOf(so(['PACKED', 'MANIFESTED']))).toBe('RTS');
    expect(warehouseStepOf(so(['DISPATCHED'], 5))).toBe('RTS');
    expect(warehouseStepOf(so(['DISPATCHED'], 10))).toBe('Dispatched');
    expect(warehouseStepOf(so(['CANCELLED']))).toBeNull();
  });

  it('never backwards; never over a status that is not on the ladder; never while Planning is not Confirmed', () => {
    expect(planPoSync(state({ statusWarehouse: 'RTS' }), so(['PACKED']), NOW).set.statusWarehouse).toBeUndefined();
    expect(planPoSync(state({ statusWarehouse: 'Packed' }), so(['READY_TO_SHIP']), NOW).set.statusWarehouse).toBe('RTS');
    expect(planPoSync(state({ statusWarehouse: 'Label Pending' }), so(['MANIFESTED']), NOW).set.statusWarehouse).toBe('RTS');
    expect(planPoSync(state({ statusWarehouse: 'Cancelled Shipment - Channel' }), so(['DISPATCHED'], 10), NOW).set.statusWarehouse).toBeUndefined();
    for (const planning of ['Hold', 'Cancelled Shipment - Low Value', 'Not Confirmed']) {
      const p = planPoSync(state({ statusPlanning: planning }), so(['DISPATCHED'], 10), NOW);
      expect(p.set.statusWarehouse).toBeUndefined();
      expect(p.set.statusLogistics).toBeUndefined();
      // facts are still filled
      expect(p.set.dispatchDate).toBe('2026-11-06');
    }
  });

  it('Logistics goes to Dispatched only from Confirmed / empty (OFD / Delivered set by the team stay)', () => {
    expect(planPoSync(state({ statusLogistics: 'OFD' }), so(['DISPATCHED'], 10), NOW).set.statusLogistics).toBeUndefined();
    expect(planPoSync(state({ statusLogistics: 'Confirmed' }), so(['DISPATCHED'], 10), NOW).set.statusLogistics).toBe('Dispatched');
  });
});

describe('facts and the end', () => {
  it('a value a person typed (dates, invoice) is kept', () => {
    const p = planPoSync(state({ dispatchDate: '2026-10-01', invoiceChallanNumber: 'MANUAL/1', invoiceDate: '2026-10-01', invoiceValue: 5 }), fixture('so-get-rts.json'), NOW);
    expect(p.set).not.toHaveProperty('dispatchDate');
    expect(p.set).not.toHaveProperty('invoiceChallanNumber');
    expect(p.set).not.toHaveProperty('invoiceValue');
  });

  it('not in Uniware yet: says so, nothing else, read again next time; a sale order cancelled in Uniware: shown, statuses untouched, done', () => {
    const missing = planPoSync(state(), null, NOW);
    expect(missing).toMatchObject({ set: { uniwareStatus: 'Not in Uniware yet' }, logs: [], done: false });
    const cancelled = planPoSync(state(), so([], 0, { status: 'CANCELLED' }), NOW);
    expect(cancelled.set).toEqual({ uniwareStatus: 'CANCELLED' });
    expect(cancelled.done).toBe(true);
  });
});
