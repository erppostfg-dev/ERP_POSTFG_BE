import {
  IST_OFFSET_MS, UNIWARE_DISPATCHED, UNIWARE_LOGISTICS_OPEN, UNIWARE_NOT_FOUND, UNIWARE_PACKAGE_STEP, UNIWARE_PLANNING_OPEN, UNIWARE_SO_DONE,
  UNIWARE_WAREHOUSE_LADDER,
} from '../../constants';
import type { SoDetail, SoDetailPackage } from './sale-order';

/*
 * The pure part of the channel PO Uniware sync (2026-11-06, constants/po-uniware-sync.ts): one saleorder/get answer
 * (soDetailOf, shared with D2C) + the PO as stored -> the fields to change and their History lines. No database here.
 */

export interface PoSyncState {
  statusPlanning: string | null;
  statusWarehouse: string | null;
  statusLogistics: string | null;
  rtsDate: string | null;
  dispatchDate: string | null;
  invoiceChallanNumber: string | null;
  invoiceDate: string | null;
  invoiceValue: number | null;
  uniwareStatus: string | null;
  syncError: string | null;
}

export interface PoSyncPlan {
  /** Changed fields only (lastSyncedAt is the caller's). */
  set: Partial<PoSyncState>;
  /** One History line per changed field that people see (not uniwareStatus / syncError). */
  logs: { field: keyof PoSyncState; oldValue: unknown; newValue: unknown }[];
  /** Nothing more will happen in Uniware: not read again. */
  done: boolean;
  /** Short text for shipment_logs.uniware_status. */
  uniwareText: string;
}

const istDay = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const empty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && !v.trim());
const rank = (s: string | null): number => (UNIWARE_WAREHOUSE_LADDER as readonly string[]).indexOf((s ?? '').trim());

/** "COMPLETE | SP/1 DISPATCHED, SP/2 PACKED" (100 characters at most). */
const uniwareTextOf = (so: SoDetail): string =>
  [so.status, so.packages.map((p) => `${p.code} ${p.status}`).join(', ')].filter(Boolean).join(' | ').slice(0, 100);

/**
 * Every unit not cancelled has left the warehouse. By the item's counts (a partly cancelled line is labelled CANCELLED
 * by Uniware although its other units shipped: 192 ordered, 22 cancelled, 170 dispatched); an item without counts by its
 * status. A line with nothing left to send does not count; nothing left at all = not dispatched (cancelled).
 */
export const fullyDispatched = (so: SoDetail): boolean => {
  const open = so.items.filter((i) => (i.counted ? i.total - i.cancelled > 0 : i.statusCode !== 'CANCELLED'));
  if (!open.length) return false;
  return open.every((i) => (i.counted ? i.completed >= i.total - i.cancelled : i.statusCode === 'DISPATCHED' || i.statusCode === 'DELIVERED'));
};

/** The warehouse step Uniware shows (null = nothing started yet). Dispatched only when everything is dispatched. */
export const warehouseStepOf = (so: SoDetail): string | null => {
  if (fullyDispatched(so)) return UNIWARE_DISPATCHED;
  const steps = so.packages.filter((p) => p.status !== 'CANCELLED').map((p) => UNIWARE_PACKAGE_STEP[p.status]).filter(Boolean)
    // part of it dispatched, the rest not yet: the PO is still at RTS for the team
    .map((s) => (s === UNIWARE_DISPATCHED ? 'RTS' : s));
  if (!steps.length) return null;
  return steps.reduce((a, b) => (rank(b) > rank(a) ? b : a));
};

const live = (so: SoDetail): SoDetailPackage[] => so.packages.filter((p) => p.status !== 'CANCELLED');
const isDispatched = (p: SoDetailPackage) => UNIWARE_PACKAGE_STEP[p.status] === UNIWARE_DISPATCHED;
const atLeastRts = (p: SoDetailPackage) => rank(UNIWARE_PACKAGE_STEP[p.status] ?? null) >= rank('RTS');

export const planPoSync = (s: PoSyncState, so: SoDetail | null, now: Date): PoSyncPlan => {
  const set: Partial<PoSyncState> = {};
  const logs: PoSyncPlan['logs'] = [];
  const change = <K extends keyof PoSyncState>(k: K, v: PoSyncState[K], logged = true) => {
    if (s[k] === v) return;
    set[k] = v;
    if (logged) logs.push({ field: k, oldValue: s[k], newValue: v });
  };

  if (!so) {
    change('uniwareStatus', UNIWARE_NOT_FOUND, false);
    change('syncError', null, false);
    return { set, logs, done: false, uniwareText: UNIWARE_NOT_FOUND };
  }
  const text = uniwareTextOf(so);
  change('uniwareStatus', text, false);
  change('syncError', null, false);

  // Statuses: forward only, and only while Planning is Confirmed and the current status is on Uniware's ladder
  const step = warehouseStepOf(so);
  const planningOpen = UNIWARE_PLANNING_OPEN.includes((s.statusPlanning ?? 'Confirmed').trim()) && so.status !== 'CANCELLED';
  const current = empty(s.statusWarehouse) ? 'Confirmed' : (s.statusWarehouse as string).trim();
  if (planningOpen && step && rank(current) >= 0 && rank(step) > rank(current)) change('statusWarehouse', step);
  const warehouseNow = set.statusWarehouse ?? s.statusWarehouse;
  const logistics = empty(s.statusLogistics) ? 'Confirmed' : (s.statusLogistics as string).trim();
  if (planningOpen && warehouseNow === UNIWARE_DISPATCHED && fullyDispatched(so) && UNIWARE_LOGISTICS_OPEN.includes(logistics)) change('statusLogistics', UNIWARE_DISPATCHED);

  // Dates and invoice: filled only when empty (a person's value stays)
  const packages = live(so);
  if (empty(s.rtsDate) && packages.some(atLeastRts)) change('rtsDate', istDay(now));
  const dispatched = packages.filter(isDispatched);
  if (empty(s.dispatchDate) && dispatched.length) {
    const first = dispatched.map((p) => p.dispatchedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
    change('dispatchDate', istDay(first ?? now));
  }
  const invoiced = packages.filter((p) => p.invoiceDisplayCode || p.invoiceCode);
  if (invoiced.length) {
    if (empty(s.invoiceChallanNumber)) change('invoiceChallanNumber', invoiced.map((p) => p.invoiceDisplayCode ?? p.invoiceCode).join(', '));
    const firstDate = invoiced.map((p) => p.invoiceDate).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
    if (empty(s.invoiceDate) && firstDate) change('invoiceDate', istDay(firstDate));
    const values = invoiced.map((p) => p.value);
    if (s.invoiceValue === null && values.every((v): v is number => v !== null)) change('invoiceValue', Math.round(values.reduce((a, v) => a + v, 0) * 100) / 100);
  }

  return { set, logs, done: UNIWARE_SO_DONE.includes(so.status) || fullyDispatched(so), uniwareText: text };
};
