import {
  D2C_BALANCE_CLOSED_REASON, D2C_PACKAGE_STATUS, D2C_PO_STATUS, D2C_REQUEST_STATE, D2C_SO_ITEM_DONE, D2C_SYNC, D2cStage, round2, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE,
} from '../../constants';
import type { DetailsPurchaseOrder, MasterPurchaseOrder, PoInvoice, PoInvoiceGrn, PoInvoiceSkuQty } from '../../entities';
import { HttpError, sleep } from '../intransit/sources/http';
import { todayIst } from './reference';
import { deriveStage, statusTextsOf } from './stage';
import type { LogRow } from './transfers.service';
import { GrnDetail, itemCodeOf, PoDetail } from './uniware-transfers';

/*
 * The Uniware SO status sync, pure part (phase 6; plan 6 step 2 + 5, no database): what one saleorder/get answer
 * (saleOrderDTO, read-only probe 2026-11-03) means for a transfer.
 *   shippingPackages[]  -> po_invoices rows by (po_uid, shipping_package_code): invoice codes / date, raw package
 *                          status, dispatched time, units, sku_qty.<pep_code>.dispatched = units of that SKU in the
 *                          package (inward / received kept: they belong to the inward PO phases).
 *   saleOrderItems[]    -> per line (our item code L<line id>, else the SKU): allocatedQty = allocated + inProcess
 *                          (not dispatched yet); Uniware-cancelled units (total - cancelled < updatedQty) -> updatedQty
 *                          cut to max(dispatched, total - cancelled). Our own cancel / close short already wrote that
 *                          number, so they never show up here as a Uniware cancel.
 *   lines               -> dispatchedQty = sum of sku_qty.dispatched over DISPATCHED packages.
 *   header              -> rtsDate / dispatchDate (first), invoiceChallanNumber / invoiceDate / invoiceValue, stage
 *                          (deriveStage) + status texts, balanceClosedReason uniware_cancelled when the cut leaves nothing.
 * Every value is compared with what is stored: only changes are written and logged, so a second run with no change
 * in Uniware plans nothing (plan 6 step 5, "re-running is harmless").
 */

// ---- the answer ------------------------------------------------------------------------------------------------------

export interface SoDetailItem {
  code: string; itemSku: string; statusCode: string;
  /**
   * Uniware gave the quantities. false = no counts (seen live on a cancelled SO, 2026-11-03: totalQuantity etc. null):
   * the status alone decides (CANCELLED = all of the line's open units cancelled, anything else = no cut).
   */
  counted: boolean;
  total: number; cancelled: number; completed: number; allocated: number; inProcess: number; sellingPrice: number | null;
}
export interface SoDetailPackage {
  code: string; saleOrderCode: string | null; status: string; dispatchedAt: Date | null; created: Date | null;
  invoiceCode: string | null; invoiceDisplayCode: string | null; invoiceDate: Date | null;
  /** Invoice value: collectableAmount (= qty x selling price on the probe), else qty x the item's selling price. */
  value: number | null;
  items: { sku: string; qty: number }[];
}
export interface SoDetail { code: string; displayOrderCode: string | null; status: string; items: SoDetailItem[]; packages: SoDetailPackage[] }

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strOrNull = (v: unknown): string | null => (str(v) ? str(v) : null);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v: unknown): number => Math.max(0, Math.round(numOrNull(v) ?? 0));
/** Uniware epoch milliseconds -> Date (whole seconds: the datetime columns keep seconds). */
const timeOf = (v: unknown): Date | null => {
  const n = numOrNull(v);
  return n && n > 0 ? new Date(Math.floor(n / 1000) * 1000) : null;
};

/** saleOrderDTO -> what the sync reads. Item quantities: Uniware's per-SKU counts (no per-unit items). */
export const soDetailOf = (dto: Record<string, unknown>): SoDetail => {
  const rawItems = (dto.saleOrderItems as Record<string, unknown>[] | undefined) ?? [];
  const items: SoDetailItem[] = rawItems.map((i) => {
    const statusCode = str(i.statusCode).toUpperCase();
    const counted = numOrNull(i.totalQuantity) !== null;
    const total = counted ? int(i.totalQuantity) : 0;
    return {
      code: str(i.code), itemSku: str(i.itemSku), statusCode, counted, total,
      cancelled: counted ? int(i.cancelledQuantity) : 0,
      completed: int(i.completedQuantity), allocated: int(i.allocatedQuantity), inProcess: int(i.inProcessQuantity),
      sellingPrice: numOrNull(i.sellingPrice),
    };
  });
  const priceOf = (sku: string) => items.find((i) => i.itemSku.toLowerCase() === sku.toLowerCase())?.sellingPrice ?? null;
  const packages: SoDetailPackage[] = ((dto.shippingPackages as Record<string, unknown>[] | undefined) ?? []).map((p) => {
    const pkgItems = Object.entries((p.items as Record<string, Record<string, unknown>> | undefined) ?? {}).map(([key, v]) => ({
      sku: str(v?.itemSku) || key, qty: int(v?.quantity),
    }));
    const collectable = numOrNull(p.collectableAmount);
    const priced = pkgItems.every((x) => priceOf(x.sku) !== null) && pkgItems.length
      ? round2(pkgItems.reduce((s, x) => s + x.qty * (priceOf(x.sku) as number), 0)) : null;
    return {
      code: str(p.code), saleOrderCode: strOrNull(p.saleOrderCode), status: str(p.status).toUpperCase(), dispatchedAt: timeOf(p.dispatched),
      created: timeOf(p.created), invoiceCode: strOrNull(p.invoiceCode), invoiceDisplayCode: strOrNull(p.invoiceDisplayCode),
      invoiceDate: timeOf(p.invoiceDate), value: collectable !== null && collectable > 0 ? round2(collectable) : priced, items: pkgItems,
    };
  });
  return { code: str(dto.code), displayOrderCode: strOrNull(dto.displayOrderCode), status: str(dto.status).toUpperCase(), items, packages };
};

/** "COMPLETE | SP/1 DISPATCHED, SP/2 PACKED" for shipment_logs.uniware_status (varchar 100). */
const soStatusText = (so: SoDetail): string =>
  [so.status, so.packages.map((p) => `${p.code} ${p.status}`).join(', ')].filter(Boolean).join(' | ').slice(0, 100);

// ---- what is stored --------------------------------------------------------------------------------------------------

export type SyncHeader = Pick<MasterPurchaseOrder,
  'uid' | 'transferStage' | 'soState' | 'rtsDate' | 'dispatchDate' | 'invoiceChallanNumber' | 'invoiceDate' | 'invoiceValue' | 'balanceClosedReason'
  | 'syncError'>;
export type SyncLine = Pick<DetailsPurchaseOrder, 'id' | 'skuCode' | 'qty' | 'updatedQty' | 'dispatchedQty' | 'allocatedQty' | 'gmv' | 'poValue'>;
export type SyncInvoice = Pick<PoInvoice,
  'shippingPackageCode' | 'saleOrderCode' | 'invoiceCode' | 'invoiceDisplayCode' | 'invoiceDate' | 'packageStatus' | 'dispatchedAt' | 'units' | 'skuQty'
  | 'inwardPoState' | 'grnCompletedAt' | 'receivedUnits' | 'varianceReason'>;

export interface SyncState { header: SyncHeader; lines: SyncLine[]; invoices: SyncInvoice[] }

export interface SyncPlan {
  /** Changed header fields only (lastSyncedAt is the caller's). */
  header: Partial<MasterPurchaseOrder>;
  lines: { id: string; set: Partial<DetailsPurchaseOrder> }[];
  invoices: { code: string; isNew: boolean; set: Partial<PoInvoice> }[];
  logs: LogRow[];
  stage: D2cStage;
  /** SO items that match no line (shown in the log, nothing else). */
  unmatched: string[];
  changed: boolean;
}

/** A date / datetime column as stored ('YYYY-MM-DD', a Date at UTC midnight, or null) -> 'YYYY-MM-DD' | null. */
const dayOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.slice(0, 10) : null;
};
const timeEq = (a: Date | null | undefined, b: Date | null | undefined) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
/** JSON with sorted keys (sku_qty comparisons do not depend on key order). */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
const live = (l: Pick<SyncLine, 'updatedQty' | 'qty'>) => l.updatedQty ?? l.qty ?? 0;
const isDispatched = (status: string) => D2C_PACKAGE_STATUS.DISPATCHED.includes(status);
const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** Units of a total spread over lines of the same SKU in order (each up to its qty, the rest to the last). */
const spread = (total: number, caps: number[]): number[] => {
  let left = total;
  return caps.map((c, i) => {
    const take = i === caps.length - 1 ? left : Math.min(left, Math.max(0, c));
    left -= take;
    return take;
  });
};

/**
 * Plan of one transfer from its stored rows and the SO (plan 6 step 2 + 5). `now`: when a dispatched package carries
 * no dispatched time and was not seen before. Pure: the caller writes the plan under the row lock.
 */
export const planSync = (state: SyncState, so: SoDetail, now: Date = new Date()): SyncPlan => {
  const { header: h, lines } = state;
  const uid = h.uid;
  const logs: LogRow[] = [];
  const src = SHIPMENT_LOG_SOURCE.UNIWARE;
  const uniwareStatus = soStatusText(so);

  // -- SO items per line (our code L<id>, else the SKU)
  // counted: every item of the line has quantities; allCancelled: every item without counts says CANCELLED
  const agg = new Map<string, { total: number; cancelled: number; open: number; counted: boolean; allCancelled: boolean; openUncounted: boolean }>();
  const unmatched: string[] = [];
  for (const i of so.items) {
    const line = lines.find((l) => itemCodeOf(l.id) === i.code) ?? lines.find((l) => lower(l.skuCode) === lower(i.itemSku));
    if (!line) {
      unmatched.push(i.code || i.itemSku);
      continue;
    }
    const a = agg.get(line.id) ?? { total: 0, cancelled: 0, open: 0, counted: true, allCancelled: true, openUncounted: false };
    a.total += i.total;
    a.cancelled += i.cancelled;
    a.open += i.allocated + i.inProcess;
    a.counted &&= i.counted;
    const itemCancelled = i.statusCode === D2C_PACKAGE_STATUS.CANCELLED;
    a.allCancelled &&= itemCancelled;
    if (!i.counted && !itemCancelled && !D2C_SO_ITEM_DONE.includes(i.statusCode)) a.openUncounted = true;
    agg.set(line.id, a);
  }
  /** Uniware SKU -> our line SKU (pep_code) for sku_qty keys. */
  const lineSku = (sku: string) => lines.find((l) => lower(l.skuCode) === lower(sku))?.skuCode ?? sku;

  // -- packages -> invoices
  const merged = new Map<string, SyncInvoice>(state.invoices.map((i) => [i.shippingPackageCode, { ...i }]));
  const invoices: SyncPlan['invoices'] = [];
  for (const p of so.packages) {
    if (!p.code) continue;
    const old = merged.get(p.code);
    const cancelled = p.status === D2C_PACKAGE_STATUS.CANCELLED;
    if (!old && cancelled) continue;
    const dispatchedAt = cancelled ? null : p.dispatchedAt ?? (isDispatched(p.status) ? old?.dispatchedAt ?? now : null);
    const skuQty: PoInvoiceSkuQty = {};
    for (const x of p.items) {
      const key = lineSku(x.sku);
      const prev = Object.entries(old?.skuQty ?? {}).find(([k]) => lower(k) === lower(key))?.[1];
      const cur = skuQty[key] ?? { dispatched: 0, inward: prev?.inward ?? 0, received: prev?.received ?? 0 };
      cur.dispatched += x.qty;
      skuQty[key] = cur;
    }
    // inward / received of SKUs no longer in the package are kept (they belong to the inward PO)
    for (const [k, v] of Object.entries(old?.skuQty ?? {})) if (!(k in skuQty) && (v.inward || v.received)) skuQty[k] = { ...v, dispatched: 0 };
    const next: Partial<PoInvoice> = {
      saleOrderCode: p.saleOrderCode ?? so.code, invoiceCode: p.invoiceCode, invoiceDisplayCode: p.invoiceDisplayCode, invoiceDate: p.invoiceDate,
      packageStatus: p.status.slice(0, 50), dispatchedAt, units: p.items.reduce((s, x) => s + x.qty, 0), skuQty,
    };
    const set: Partial<PoInvoice> = {};
    if (!old) Object.assign(set, next);
    else {
      if ((old.saleOrderCode ?? null) !== next.saleOrderCode) set.saleOrderCode = next.saleOrderCode;
      if ((old.invoiceCode ?? null) !== next.invoiceCode && next.invoiceCode !== null) set.invoiceCode = next.invoiceCode;
      if ((old.invoiceDisplayCode ?? null) !== next.invoiceDisplayCode && next.invoiceDisplayCode !== null) set.invoiceDisplayCode = next.invoiceDisplayCode;
      if (!timeEq(old.invoiceDate, next.invoiceDate) && next.invoiceDate) set.invoiceDate = next.invoiceDate;
      if ((old.packageStatus ?? null) !== next.packageStatus) set.packageStatus = next.packageStatus;
      if (!timeEq(old.dispatchedAt, next.dispatchedAt)) set.dispatchedAt = next.dispatchedAt;
      if ((old.units ?? 0) !== next.units) set.units = next.units;
      if (stable(old.skuQty ?? {}) !== stable(skuQty)) set.skuQty = skuQty;
    }
    if (!Object.keys(set).length) continue;
    invoices.push({ code: p.code, isNew: !old, set });
    merged.set(p.code, { ...(old ?? {
      shippingPackageCode: p.code, inwardPoState: null, grnCompletedAt: null, receivedUnits: 0, varianceReason: null,
    } as SyncInvoice), ...(set as Partial<SyncInvoice>) });
    const invNo = next.invoiceDisplayCode ?? next.invoiceCode;
    const what = !old ? 'new package' : [
      set.packageStatus !== undefined ? `status ${old.packageStatus ?? '-'} -> ${set.packageStatus}` : '',
      set.invoiceCode !== undefined ? 'invoice created' : '',
      set.dispatchedAt !== undefined ? (set.dispatchedAt ? 'dispatched' : 'dispatch undone') : '',
      set.units !== undefined || set.skuQty !== undefined ? `units ${old.units} -> ${next.units}` : '',
    ].filter(Boolean).join(', ');
    logs.push({
      uid, action: SHIPMENT_LOG_ACTION.INVOICE_SEEN, source: src, field: 'packageStatus', oldValue: old?.packageStatus ?? null, newValue: next.packageStatus,
      remark: `${invNo ?? 'no invoice yet'} | package ${p.code} | ${next.units} unit(s) | ${what}`.slice(0, 4000), uniwareStatus: p.status.slice(0, 100),
    });
  }
  const allInvoices = [...merged.values()];
  const shipped = allInvoices.filter((i) => i.dispatchedAt && i.packageStatus !== D2C_PACKAGE_STATUS.CANCELLED);

  // -- lines: dispatched, allocated, Uniware-cancelled units
  const dispatchedBySku = new Map<string, number>();
  for (const i of shipped) for (const [k, v] of Object.entries(i.skuQty ?? {})) dispatchedBySku.set(lower(k), (dispatchedBySku.get(lower(k)) ?? 0) + (v.dispatched ?? 0));
  const dispatchedOf = new Map<string, number>();
  for (const [sku, total] of dispatchedBySku) {
    const same = lines.filter((l) => lower(l.skuCode) === sku);
    spread(total, same.map(live)).forEach((n, k) => dispatchedOf.set(same[k].id, n));
  }
  const linePlans: SyncPlan['lines'] = [];
  const after: { updatedQty: number; dispatched: number }[] = [];
  let cut = false;
  for (const l of lines) {
    const a = agg.get(l.id);
    const dispatched = dispatchedOf.get(l.id) ?? 0;
    const cur = live(l);
    // no counts and still open: the undispatched part counts as allocated
    const allocated = !a ? 0 : a.counted ? a.open : a.openUncounted ? Math.max(0, cur - dispatched) : 0;
    let updated = cur;
    if (a?.counted && a.total > 0 && a.total - a.cancelled < cur) updated = Math.max(dispatched, a.total - a.cancelled);
    else if (a && !a.counted && a.allCancelled && dispatched < cur) updated = dispatched;
    const set: Partial<DetailsPurchaseOrder> = {};
    if ((l.dispatchedQty ?? 0) !== dispatched || l.dispatchedQty === null) set.dispatchedQty = dispatched;
    if ((l.allocatedQty ?? 0) !== allocated || l.allocatedQty === null) set.allocatedQty = allocated;
    if (updated !== cur) {
      const qty = l.qty ?? 0;
      set.updatedQty = updated;
      set.updatedGmv = qty ? round2((Number(l.gmv ?? 0) / qty) * updated) : 0;
      set.updatedPoValue = qty ? round2((Number(l.poValue ?? 0) / qty) * updated) : 0;
      cut = true;
      logs.push({
        uid, action: SHIPMENT_LOG_ACTION.BALANCE_CLOSED, source: src, field: 'updatedQty', lineId: l.id, oldValue: cur, newValue: updated,
        remark: `${l.skuCode ?? '?'}: ${cur - updated} unit(s) cancelled in Uniware`, uniwareStatus,
      });
    }
    if ((l.dispatchedQty ?? 0) !== dispatched) {
      logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: src, field: 'dispatchedQty', lineId: l.id, oldValue: l.dispatchedQty ?? 0, newValue: dispatched, remark: l.skuCode, uniwareStatus });
    }
    if (Object.keys(set).length) linePlans.push({ id: l.id, set });
    after.push({ updatedQty: updated, dispatched });
  }
  const balance = after.reduce((s, l) => s + Math.max(0, l.updatedQty - l.dispatched), 0);

  // -- header
  const header: Partial<MasterPurchaseOrder> = {};
  const fieldLog = (field: keyof MasterPurchaseOrder, oldValue: unknown, newValue: unknown) =>
    logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: src, field, oldValue, newValue, uniwareStatus });
  const live2 = allInvoices.filter((i) => i.packageStatus !== D2C_PACKAGE_STATUS.CANCELLED);
  const minTime = (ds: (Date | null)[]) => ds.filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const firstDispatch = minTime(shipped.map((i) => i.dispatchedAt));
  if (firstDispatch && dayOf(h.dispatchDate) !== todayIst(firstDispatch)) {
    header.dispatchDate = todayIst(firstDispatch);
    fieldLog('dispatchDate', dayOf(h.dispatchDate), header.dispatchDate);
  }
  const rtsLike = live2.filter((i) => i.dispatchedAt || D2C_PACKAGE_STATUS.RTS.includes(i.packageStatus ?? ''));
  if (!dayOf(h.rtsDate) && rtsLike.length) {
    header.rtsDate = todayIst(minTime(rtsLike.map((i) => i.invoiceDate ?? i.dispatchedAt)) ?? now);
    fieldLog('rtsDate', null, header.rtsDate);
  }
  const invoiced = live2.filter((i) => i.invoiceCode || i.invoiceDisplayCode)
    .sort((a, b) => (a.invoiceDate ? new Date(a.invoiceDate).getTime() : 0) - (b.invoiceDate ? new Date(b.invoiceDate).getTime() : 0) || a.shippingPackageCode.localeCompare(b.shippingPackageCode));
  if (invoiced.length) {
    const numbers = [...new Set(invoiced.map((i) => (i.invoiceDisplayCode ?? i.invoiceCode) as string))].join(', ').slice(0, 255);
    if ((h.invoiceChallanNumber ?? null) !== numbers) {
      header.invoiceChallanNumber = numbers;
      fieldLog('invoiceChallanNumber', h.invoiceChallanNumber, numbers);
    }
    const first = minTime(invoiced.map((i) => i.invoiceDate));
    if (first && dayOf(h.invoiceDate) !== todayIst(first)) header.invoiceDate = todayIst(first);
    const values = so.packages.filter((p) => p.status !== D2C_PACKAGE_STATUS.CANCELLED && (p.invoiceCode || p.invoiceDisplayCode));
    if (values.length && values.every((p) => p.value !== null)) {
      const value = round2(values.reduce((s, p) => s + (p.value as number), 0));
      if (h.invoiceValue === null || h.invoiceValue === undefined || round2(Number(h.invoiceValue)) !== value) header.invoiceValue = value;
    }
  }
  if (cut && balance === 0 && !h.balanceClosedReason) {
    header.balanceClosedReason = D2C_BALANCE_CLOSED_REASON.UNIWARE_CANCELLED;
    logs.push({
      uid, action: SHIPMENT_LOG_ACTION.BALANCE_CLOSED, source: src, field: 'balanceClosedReason', oldValue: null, newValue: header.balanceClosedReason,
      remark: so.status === D2C_PACKAGE_STATUS.CANCELLED ? 'sale order cancelled in Uniware' : 'the rest of the sale order was cancelled in Uniware', uniwareStatus,
    });
  }
  const stage = deriveStage({
    stage: h.transferStage, soState: h.soState, lines: after,
    invoices: allInvoices.map((i) => ({
      packageStatus: i.packageStatus, invoiced: !!(i.invoiceCode || i.invoiceDisplayCode), dispatched: !!i.dispatchedAt && i.packageStatus !== D2C_PACKAGE_STATUS.CANCELLED,
      inwardPoState: i.inwardPoState, grnCompleted: !!i.grnCompletedAt, variance: (i.receivedUnits ?? 0) - (i.units ?? 0), varianceReason: i.varianceReason,
    })),
  });
  if (stage !== h.transferStage) {
    Object.assign(header, { transferStage: stage, transferStageAt: now, ...statusTextsOf(stage) });
    logs.push({ uid, action: SHIPMENT_LOG_ACTION.STAGE_CHANGED, source: src, field: 'transferStage', oldValue: h.transferStage, newValue: stage, uniwareStatus });
  }
  // syncError is set / cleared once per run by the caller (combineSyncErrors), never here
  return { header, lines: linePlans, invoices, logs, stage, unmatched, changed: Object.keys(header).length > 0 || linePlans.length > 0 || invoices.length > 0 };
};

// ---- GRN of inward POs (phase 7; plan 6 step 3) ---------------------------------------------------------------------
/*
 * One invoice whose inward PO is created and not GRN-complete: PO details + GRN list + the detail of each GRN not yet
 * stored as COMPLETE (a COMPLETE GRN is never read again) at the receiving facility, then:
 *   grn_codes        [{ code, date (done time), units (accepted = quantity - rejectedQuantity), status, rejected, skus }]
 *   received_units   = sum of the GRNs' accepted units; sku_qty.<sku>.received = sum over the GRNs
 *   inward_po_status = the PO's raw statusCode
 *   grn_completed_at = when the PO is COMPLETE / CLOSED and every GRN is COMPLETE: the last GRN's done time
 *   lines            channelInwardingQuantity = sum of received over the transfer's invoices (spread over same-SKU lines)
 *   header           deliveryDate = day of the last GRN completion; stage (deriveStage) + status texts
 * Only changes are written / logged: a second run with no change in Uniware plans nothing.
 */

export type GrnInvoice = Pick<PoInvoice,
  'id' | 'shippingPackageCode' | 'invoiceCode' | 'invoiceDisplayCode' | 'packageStatus' | 'dispatchedAt' | 'units' | 'skuQty' | 'inwardPoCode'
  | 'inwardPoState' | 'inwardPoStatus' | 'grnCodes' | 'receivedUnits' | 'grnCompletedAt' | 'varianceReason'>;
export type GrnLine = Pick<DetailsPurchaseOrder, 'id' | 'skuCode' | 'qty' | 'updatedQty' | 'dispatchedQty' | 'channelInwardingQuantity'>;
export interface GrnState {
  header: Pick<MasterPurchaseOrder, 'uid' | 'transferStage' | 'soState' | 'deliveryDate' | 'poNumberInwardCWH'>;
  lines: GrnLine[];
  invoices: GrnInvoice[];
}
export interface GrnRead {
  invoiceId: string;
  po: PoDetail;
  /** inflowReceiptCodes of the PO. */
  codes: string[];
  /** Details read now (grnsToRead of the stored list). */
  grns: GrnDetail[];
}
export interface GrnPlan {
  invoice: Partial<PoInvoice>;
  lines: { id: string; set: Partial<DetailsPurchaseOrder> }[];
  header: Partial<MasterPurchaseOrder>;
  logs: LogRow[];
  stage: D2cStage;
  complete: boolean;
  changed: boolean;
}

/** poNumberInwardCWH: the created inward PO codes of a transfer, in invoice order, comma-joined (varchar 255). */
export const joinInwardCodes = (invoices: Pick<PoInvoice, 'id' | 'inwardPoState' | 'inwardPoCode'>[]): string | null => {
  const codes = [...invoices].sort((a, b) => Number(a.id) - Number(b.id))
    .filter((i) => i.inwardPoState === D2C_REQUEST_STATE.CREATED && i.inwardPoCode).map((i) => i.inwardPoCode as string);
  return codes.length ? codes.join(', ').slice(0, 255) : null;
};

/**
 * The PO was cancelled in Uniware with no GRN (user, 2026-11-03): the invoice goes back to the Create inward PO tab
 * (state failed, "Inward PO <code> cancelled in Uniware", code cleared: the next create takes the next <SO>-<n>, the
 * cancelled code stays in the inward_po_requested log). A cancelled PO WITH GRNs is not touched (a person must look).
 */
export const isCancelledPo = (read: Pick<GrnRead, 'po' | 'codes'>): boolean => read.po.status === D2C_PO_STATUS.CANCELLED && read.codes.length === 0;

/** GRN codes whose detail must be read: every code not stored as COMPLETE. */
export const grnsToRead = (stored: PoInvoiceGrn[] | null | undefined, codes: string[]): string[] =>
  codes.filter((c) => !(stored ?? []).some((e) => e.code === c && (e.status ?? '').toUpperCase() === D2C_PO_STATUS.GRN_DONE));

/** Variance of an invoice: received - dispatched (units). */
export const varianceOf = (i: Pick<PoInvoice, 'receivedUnits' | 'units'>): number => (i.receivedUnits ?? 0) - (i.units ?? 0);

type StageInvoice = Pick<PoInvoice,
  'packageStatus' | 'invoiceCode' | 'invoiceDisplayCode' | 'dispatchedAt' | 'inwardPoState' | 'grnCompletedAt' | 'receivedUnits' | 'units' | 'varianceReason'>;

/** The stage facts of invoices (deriveStage's invoices). */
export const stageInvoices = (invoices: StageInvoice[]) =>
  invoices.map((i) => ({
    packageStatus: i.packageStatus, invoiced: !!(i.invoiceCode || i.invoiceDisplayCode), dispatched: !!i.dispatchedAt && i.packageStatus !== D2C_PACKAGE_STATUS.CANCELLED,
    inwardPoState: i.inwardPoState, grnCompleted: !!i.grnCompletedAt, variance: varianceOf(i), varianceReason: i.varianceReason,
  }));

const grnEntryOf = (g: GrnDetail, keyOf: (sku: string) => string): PoInvoiceGrn => {
  const skus: Record<string, number> = {};
  for (const i of g.items) skus[keyOf(i.sku)] = (skus[keyOf(i.sku)] ?? 0) + i.accepted;
  return { code: g.code, date: g.doneAt ? g.doneAt.toISOString() : null, units: g.accepted, status: g.status || null, rejected: g.rejected, skus };
};

const latest = (ds: (Date | string | null | undefined)[]): Date | null =>
  ds.filter((d): d is Date | string => !!d).map((d) => new Date(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

/** Plan of one invoice's GRN read (pure; the caller writes it under the row lock). */
export const planGrn = (state: GrnState, read: GrnRead, now: Date = new Date()): GrnPlan => {
  const { header: h } = state;
  const uid = h.uid;
  const inv = state.invoices.find((i) => String(i.id) === String(read.invoiceId));
  if (!inv) throw new Error(`invoice ${read.invoiceId} is not part of transfer ${uid}`);
  const src = SHIPMENT_LOG_SOURCE.UNIWARE;
  const invNo = inv.invoiceDisplayCode ?? inv.invoiceCode ?? inv.shippingPackageCode;
  const ipo = inv.inwardPoCode ?? '-';
  const uniwareStatus = `PO ${read.po.status}${read.codes.length ? ` | ${read.codes.join(', ')}` : ''}`.slice(0, 100);
  const logs: LogRow[] = [];
  const lineSku = (sku: string) => state.lines.find((l) => lower(l.skuCode) === lower(sku))?.skuCode
    ?? Object.keys(inv.skuQty ?? {}).find((k) => lower(k) === lower(sku)) ?? sku;
  const cancelled = isCancelledPo(read);

  // -- GRN entries: the PO's list is the truth; stored COMPLETE ones are kept, the rest come from this read
  const stored = inv.grnCodes ?? [];
  const entries: PoInvoiceGrn[] = [];
  let unread = false;
  for (const code of read.codes) {
    const fresh = read.grns.find((g) => g.code === code);
    const old = stored.find((e) => e.code === code);
    if (!fresh) {
      if (old) entries.push(old);
      else unread = true;
      continue;
    }
    const e = grnEntryOf(fresh, lineSku);
    entries.push(e);
    if (!old) {
      logs.push({
        uid, action: SHIPMENT_LOG_ACTION.GRN_RECEIVED, source: src, field: 'grnCodes', newValue: code, uniwareStatus,
        remark: `${invNo} | inward PO ${ipo} | GRN ${code} ${e.status ?? '-'} | ${e.units} unit(s)${e.rejected ? `, ${e.rejected} rejected` : ''}`,
      });
    } else if (old.status !== e.status || old.units !== e.units || (old.rejected ?? 0) !== (e.rejected ?? 0)) {
      logs.push({
        uid, action: SHIPMENT_LOG_ACTION.GRN_RECEIVED, source: src, field: 'grnCodes', oldValue: `${code} ${old.status ?? '-'} ${old.units}`,
        newValue: `${code} ${e.status ?? '-'} ${e.units}`, remark: `${invNo} | inward PO ${ipo} | GRN ${code} updated`, uniwareStatus,
      });
    }
  }

  // -- invoice totals
  const skuQty: PoInvoiceSkuQty = Object.fromEntries(Object.entries(inv.skuQty ?? {}).map(([k, v]) => [k, { ...v, received: 0, ...(cancelled ? { inward: 0 } : {}) }]));
  for (const e of entries) {
    for (const [sku, n] of Object.entries(e.skus ?? {})) {
      const key = Object.keys(skuQty).find((k) => lower(k) === lower(sku)) ?? sku;
      const cur = skuQty[key] ?? { dispatched: 0, inward: 0, received: 0 };
      skuQty[key] = { ...cur, received: cur.received + n };
    }
  }
  const received = entries.reduce((s, e) => s + (e.units ?? 0), 0);
  const complete = !unread && D2C_PO_STATUS.DONE.includes(read.po.status)
    && entries.every((e) => (e.status ?? '').toUpperCase() === D2C_PO_STATUS.GRN_DONE);
  const completedAt = complete ? latest(entries.map((e) => e.date)) ?? now : null;

  const set: Partial<PoInvoice> = {};
  if (stable(stored) !== stable(entries)) set.grnCodes = entries;
  if ((inv.receivedUnits ?? 0) !== received) set.receivedUnits = received;
  if (stable(inv.skuQty ?? {}) !== stable(skuQty)) set.skuQty = skuQty;
  const poStatus = read.po.status.slice(0, 50) || null;
  if ((inv.inwardPoStatus ?? null) !== poStatus) {
    set.inwardPoStatus = poStatus;
    logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: src, field: 'inwardPoStatus', oldValue: inv.inwardPoStatus, newValue: poStatus, remark: `${invNo} | inward PO ${ipo}`, uniwareStatus });
  }
  if (!timeEq(inv.grnCompletedAt, completedAt)) {
    set.grnCompletedAt = completedAt;
    const variance = received - (inv.units ?? 0);
    logs.push({
      uid, action: SHIPMENT_LOG_ACTION.GRN_RECEIVED, source: src, field: 'grnCompletedAt', oldValue: inv.grnCompletedAt, newValue: completedAt, uniwareStatus,
      remark: completedAt
        ? `${invNo} | inward PO ${ipo} GRN complete: received ${received} of ${inv.units ?? 0} dispatched${variance ? ` (variance ${variance > 0 ? '+' : ''}${variance})` : ''}`
        : `${invNo} | inward PO ${ipo} no longer GRN-complete`,
    });
  }
  if (cancelled) {
    const error = `Inward PO ${ipo} cancelled in Uniware (status ${read.po.status})`;
    Object.assign(set, { inwardPoState: D2C_REQUEST_STATE.FAILED, inwardPoCode: null, inwardPoError: error, grnCodes: null, grnCompletedAt: null });
    logs.push({
      uid, action: SHIPMENT_LOG_ACTION.INWARD_PO_FAILED, source: src, field: 'inwardPoState', oldValue: inv.inwardPoState, newValue: D2C_REQUEST_STATE.FAILED,
      remark: `${invNo} | ${error}: back in Create inward PO (the next create takes a new code)`, uniwareStatus,
    });
  }
  const after = state.invoices.map((i) => (String(i.id) === String(read.invoiceId) ? ({ ...i, ...set }) : i));

  // -- lines: received per SKU over every invoice of the transfer
  const receivedBySku = new Map<string, number>();
  for (const i of after) for (const [k, v] of Object.entries(i.skuQty ?? {})) receivedBySku.set(lower(k), (receivedBySku.get(lower(k)) ?? 0) + (v.received ?? 0));
  const receivedOf = new Map<string, number>();
  for (const [sku, total] of receivedBySku) {
    const same = state.lines.filter((l) => lower(l.skuCode) === sku);
    if (same.length) spread(total, same.map((l) => l.dispatchedQty ?? 0)).forEach((n, k) => receivedOf.set(same[k].id, n));
  }
  const lines: GrnPlan['lines'] = [];
  for (const l of state.lines) {
    const r = receivedOf.get(l.id) ?? 0;
    if ((l.channelInwardingQuantity ?? 0) === r) continue;
    lines.push({ id: l.id, set: { channelInwardingQuantity: r } });
    logs.push({
      uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: src, field: 'channelInwardingQuantity', lineId: l.id, oldValue: l.channelInwardingQuantity ?? 0, newValue: r,
      remark: l.skuCode, uniwareStatus,
    });
  }

  // -- header: deliveryDate = the last GRN completion; stage
  const header: Partial<MasterPurchaseOrder> = {};
  if (cancelled) {
    const joined = joinInwardCodes(after);
    if ((h.poNumberInwardCWH ?? null) !== joined) {
      header.poNumberInwardCWH = joined;
      logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: src, field: 'poNumberInwardCWH', oldValue: h.poNumberInwardCWH, newValue: joined, uniwareStatus });
    }
  }
  const lastDone = latest(after.map((i) => i.grnCompletedAt));
  if (lastDone && dayOf(h.deliveryDate) !== todayIst(lastDone)) {
    header.deliveryDate = todayIst(lastDone);
    logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: src, field: 'deliveryDate', oldValue: dayOf(h.deliveryDate), newValue: header.deliveryDate, uniwareStatus });
  }
  const stage = deriveStage({
    stage: h.transferStage, soState: h.soState,
    lines: state.lines.map((l) => ({ updatedQty: l.updatedQty ?? l.qty ?? 0, dispatched: l.dispatchedQty ?? 0 })),
    invoices: stageInvoices(after),
  });
  if (stage !== h.transferStage) {
    Object.assign(header, { transferStage: stage, transferStageAt: now, ...statusTextsOf(stage) });
    logs.push({ uid, action: SHIPMENT_LOG_ACTION.STAGE_CHANGED, source: src, field: 'transferStage', oldValue: h.transferStage, newValue: stage, uniwareStatus });
  }
  return { invoice: set, lines, header, logs, stage, complete, changed: Object.keys(set).length > 0 || lines.length > 0 || Object.keys(header).length > 0 };
};

// ---- sync errors of one run ---------------------------------------------------------------------------------------
/*
 * One stable syncError per transfer per run (fix 2026-11-03): the SO read and each inward PO GRN read note their result
 * (null = read fine); at the end of the run each touched transfer gets the combined text (SO first, then the GRN
 * errors sorted) or null, written and logged only when it differs from what is stored. Before, a good SO read cleared
 * the error and a failing GRN read set it again: one sync_error log every run.
 */
export interface TransferErrors { so: string | null; grn: string[] }

export const combineSyncErrors = (e: TransferErrors): string | null => {
  const parts = [e.so, ...[...new Set(e.grn)].sort()].filter((x): x is string => !!x)
  return parts.length ? parts.join(' | ').slice(0, 4000) : null
}

export class RunErrors {
  private readonly by = new Map<string, TransferErrors>()
  private of(uid: string): TransferErrors {
    let e = this.by.get(uid)
    if (!e) {
      e = { so: null, grn: [] }
      this.by.set(uid, e)
    }
    return e
  }
  /** The SO read of a transfer: its error, or null when it was read fine. */
  so(uid: string, error: string | null): void {
    this.of(uid).so = error
  }
  /** One GRN read of a transfer's invoice: its error, or null when it was read fine. */
  grn(uid: string, error: string | null): void {
    const e = this.of(uid)
    if (error) e.grn.push(error)
  }
  /** [uid, combined syncError | null] of every transfer read this run. */
  results(): [string, string | null][] {
    return [...this.by].map(([uid, e]) => [uid, combineSyncErrors(e)])
  }
}

// ---- run pacing ------------------------------------------------------------------------------------------------------

/** Uniware answered 429 even after sendRetry's own retries (the API user is busy: in-transit fetch etc.). */
export const isThrottled = (err: unknown): boolean => err instanceof HttpError && err.status === 429;

/** Minutes until the next run: the interval after a good run; after a failed one twice the last wait, at most 2 h. */
export const nextDelayOf = (interval: number, failed: boolean, previous: number | null | undefined): number => {
  const base = Math.max(1, interval);
  if (!failed) return base;
  return Math.min(D2C_SYNC.MAX_DELAY_MIN, Math.max(base, previous ?? base) * 2);
};

export interface GentleOptions { concurrency: number; gapMs: number; wait?: (ms: number) => Promise<void> }

/**
 * Runs `work` over items, `concurrency` at a time, each lane pausing `gapMs` after every item. A work that throws a
 * 429 (isThrottled) stops the run: no new item starts (those in flight finish); the rest is `notStarted`.
 * Any other throw is the work's own business (it should catch); it is counted in `errors`.
 */
export const runGentle = async <T>(items: T[], o: GentleOptions, work: (t: T) => Promise<void>) => {
  const pause = o.wait ?? sleep;
  let next = 0;
  let throttled = false;
  let done = 0;
  const errors: unknown[] = [];
  const lane = async () => {
    while (!throttled && next < items.length) {
      const t = items[next++];
      try {
        await work(t);
        done++;
      } catch (err) {
        if (isThrottled(err)) throttled = true;
        else errors.push(err);
      }
      if (!throttled && next < items.length && o.gapMs > 0) await pause(o.gapMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, o.concurrency), items.length) }, lane));
  return { done, throttled, errors, notStarted: items.length - next };
};
