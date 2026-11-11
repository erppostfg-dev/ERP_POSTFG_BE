import { AppDataSource } from '../../config/data-source';
import {
  D2C_EXPORT_LEVEL, D2C_FINAL_STAGES, D2C_LIMITS, D2C_PRICE, D2C_PRIORITIES, D2C_REQUEST_STATE, D2C_SOURCE, D2C_STAGE, D2C_TAB, D2cTab,
  ERROR_CODES, SHIPMENT_LOG_ACTION, TABLES,
} from '../../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder } from '../../entities';
import { appError } from '../../utils/AppError';
import { csvCell } from '../../utils/csv';
import { draftBlock, editableState } from './transfers.service';
import { parseDay, peekReferences, todayIst } from './reference';
import { readSettings } from './settings';
import { varianceBlock } from './inward-po.service';
import { cancelBlock, gateError, gateOf, uniwareWritesAllowed } from './so.service';
import { editToken, groupOfRemark, safeCell, sourceTag } from './stage';
import { mrpOf } from './validate';

/*
 * Reads of D2C internal transfers (plan 1.3 / 8): the list per sub-tab with search + filters (sorted by priority, PO
 * date, uid), the tab counts, one transfer with its lines, invoices, route codes and timeline, the export (one row
 * per transfer or per SKU line) and the form's options. Always `transferCode IS NOT NULL` (channel POs never show).
 * The tab rules are the SQL twin of stage.ts tabsOf().
 */

export interface D2cFilters {
  tab: D2cTab;
  q?: string;
  stage: string[];
  priority: string[];
  sender: string[];
  receiving: string[];
  dateFrom?: string;
  dateTo?: string;
  source: string[];
  channel: string[];
  type: string[];
  /** true = expiry before today with an open balance; false = not that. */
  expired?: boolean;
}
export interface Paging { page: number; pageSize: number }

const P = TABLES.MASTER_PURCHASE_ORDERS;
const L = TABLES.DETAILS_PURCHASE_ORDERS;
const I = TABLES.PO_INVOICES;
const LOGS = TABLES.SHIPMENT_LOGS;

/** Σ(updatedQty − dispatched) of a transfer's lines. */
const BALANCE = `(SELECT COALESCE(SUM(COALESCE(bl.updatedQty, bl.qty, 0) - COALESCE(bl.dispatchedQty, 0)), 0) FROM ${L} bl WHERE bl.shipmentOrderId = p.uid)`;
const R = D2C_REQUEST_STATE;
const TAB_SQL: Record<D2cTab, string> = {
  [D2C_TAB.DRAFT]: `p.transferStage = '${D2C_STAGE.DRAFT}'`,
  [D2C_TAB.SALE_ORDERS]: `p.soState = '${R.CREATED}' AND p.transferStage <> '${D2C_STAGE.CANCELLED}' AND ${BALANCE} > 0`,
  [D2C_TAB.CREATE_INWARD_PO]: `EXISTS (SELECT 1 FROM ${I} ti WHERE ti.po_uid = p.uid AND ti.dispatched_at IS NOT NULL AND (ti.inward_po_state IS NULL OR ti.inward_po_state = '${R.FAILED}'))`,
  [D2C_TAB.INWARD_POS]: `p.transferStage <> '${D2C_STAGE.CLOSED}' AND EXISTS (SELECT 1 FROM ${I} ti WHERE ti.po_uid = p.uid AND ti.inward_po_state IN ('${R.REQUESTED}', '${R.CREATED}', '${R.UNKNOWN}'))`,
  [D2C_TAB.OVERVIEW]: '1 = 1',
};
const EXPIRED_SQL = `(COALESCE(p.labelsLink < ?, 0) AND p.transferStage NOT IN (${D2C_FINAL_STAGES.map((s) => `'${s}'`).join(', ')}) AND ${BALANCE} > 0)`;
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const FROM = `FROM ${P} p
  LEFT JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = p.locationId
  LEFT JOIN ${TABLES.MASTER_FACILITIES} rf ON rf.id = d.transfer_facility_id
  LEFT JOIN ${TABLES.D2C_TRANSFER_ROUTES} tr ON tr.id = p.transferRouteId`;
/** The transfer's Uniware channel: its chosen route, else the only active route of its sender + location. */
const ROUTE_CHANNEL = `COALESCE(tr.uniware_channel_code, (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(r1.uniware_channel_code) END FROM ${TABLES.D2C_TRANSFER_ROUTES} r1
  WHERE r1.dispatch_facility_id = p.facilityId AND r1.location_id = p.locationId AND r1.is_active = 1))`;

/** WHERE clause + params of the filters (tab included unless `withTab` is false). */
const where = (f: D2cFilters, withTab = true): { sql: string; params: unknown[] } => {
  const parts: string[] = ['p.transferCode IS NOT NULL'];
  const params: unknown[] = [];
  if (withTab) parts.push(TAB_SQL[f.tab]);
  const inList = (col: string, values: string[]) => {
    if (!values.length) return;
    parts.push(`${col} IN (?)`);
    params.push(values);
  };
  inList('p.transferStage', f.stage);
  inList('p.transferPriority', f.priority);
  inList('p.facility', f.sender);
  inList('rf.code', f.receiving);
  inList('p.channel', f.channel);
  inList('p.transferType', f.type);
  if (f.source.length) {
    parts.push(`EXISTS (SELECT 1 FROM ${LOGS} sl WHERE sl.shipment_uid = p.uid AND sl.action = ? AND sl.source IN (?))`);
    params.push(SHIPMENT_LOG_ACTION.CREATED, f.source);
  }
  if (f.dateFrom) { parts.push('p.poDate >= ?'); params.push(f.dateFrom); }
  if (f.dateTo) { parts.push('p.poDate <= ?'); params.push(f.dateTo); }
  if (f.expired !== undefined) {
    parts.push(f.expired ? EXPIRED_SQL : `NOT ${EXPIRED_SQL}`);
    params.push(todayIst());
  }
  if (f.q) {
    const q = like(f.q);
    parts.push(`(p.transferCode LIKE ? OR p.poNumber LIKE ? OR p.orderNo1 LIKE ? OR p.invoiceChallanNumber LIKE ? OR p.poNumberInwardCWH LIKE ?
      OR EXISTS (SELECT 1 FROM ${I} qi WHERE qi.po_uid = p.uid AND (qi.invoice_code LIKE ? OR qi.invoice_display_code LIKE ? OR qi.inward_po_code LIKE ?))
      OR EXISTS (SELECT 1 FROM ${L} ql WHERE ql.shipmentOrderId = p.uid AND (ql.skuCode LIKE ? OR ql.skuName LIKE ?)))`);
    params.push(q, q, q, q, q, q, q, q, q, q);
  }
  return { sql: parts.join(' AND '), params };
};

const ORDER = 'ORDER BY p.transferPriority IS NULL, p.transferPriority ASC, p.poDate ASC, p.uid ASC';

type HeadRow = {
  uid: string | number; transferCode: string; poNumber: string | null; poDate: string | null; entryDate: string | null; labelsLink: string | null;
  facility: string | null; facilityId: number | null; channel: string | null; location: string | null; locationId: string | number | null;
  rid: number | null; rcode: string | null; transferPriority: string | null; transferType: string | null; transferStage: string | null;
  transferStageAt: Date | null; soState: string | null; soError: string | null; soRequestedAt: Date | null; orderNo1: string | null; invoiceChallanNumber: string | null;
  poNumberInwardCWH: string | null; totalUnits: number | null; specialRemarksCOPT: string | null; createdAt: Date | null; updatedAt: Date | null;
  lastSyncedAt: Date | null; syncError: string | null; dispatchDate: string | null; rtsDate: string | null; deliveryDate: string | null;
  balanceClosedReason: string | null; transferRouteId: number | null; routeChannel: string | null;
};
const HEAD_COLS = `p.uid, p.transferCode, p.poNumber, DATE_FORMAT(p.poDate, '%Y-%m-%d') poDate, DATE_FORMAT(p.entryDate, '%Y-%m-%d') entryDate,
  p.labelsLink, p.facility, p.facilityId, p.channel, p.location, p.locationId, rf.id rid, rf.code rcode, p.transferPriority, p.transferType,
  p.transferStage, p.transferStageAt, p.soState, p.soError, p.soRequestedAt, p.orderNo1, p.invoiceChallanNumber, p.poNumberInwardCWH, p.totalUnits,
  p.specialRemarksCOPT, p.createdAt, p.updatedAt, p.lastSyncedAt, p.syncError, DATE_FORMAT(p.dispatchDate, '%Y-%m-%d') dispatchDate, DATE_FORMAT(p.rtsDate, '%Y-%m-%d') rtsDate,
  DATE_FORMAT(p.deliveryDate, '%Y-%m-%d') deliveryDate, p.balanceClosedReason, p.transferRouteId, ${ROUTE_CHANNEL} routeChannel`;

type Totals = { lines: number; skus: number; qty: number; updatedQty: number; dispatched: number; received: number; gmv: number; poValue: number; updatedGmv: number; updatedPoValue: number };
type InvoiceTotals = { invoices: number; dispatched: number; awaitingInwardPo: number; inwardPos: number; varianceOpen: number };

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const n = (v: unknown) => Number(v ?? 0);

export interface D2cListItem {
  uid: string; transferCode: string; reference: string | null; poDate: string | null; entryDate: string | null; expiryDate: string | null;
  sender: { id: number | null; code: string | null }; receiving: { id: number | null; code: string | null };
  channel: string | null; location: string | null; locationId: string | null; priority: string | null; type: string | null;
  /** The route's Uniware channel (2026-11-03: a route may have 2+, the transfer keeps the chosen one). */
  uniwareChannel: string | null; routeId: number | null;
  stage: string | null; stageAt: string | null; soState: string | null; soError: string | null; soCode: string | null;
  /** When the SO was (last) requested; soNotFound: still requested / unknown after d2c:settings.soNotFoundHours (plan 1.2). */
  soRequestedAt: string | null; soNotFound: boolean;
  invoiceNo: string | null; inwardPo: string | null; dispatchDate: string | null; grnDate: string | null; balanceClosedReason: string | null;
  /** First day a package was ready to ship (Uniware sync, phase 6). */
  rtsDate: string | null;
  remarks: string | null; source: string | null; group: string | null;
  totals: Totals & { openBalance: number; cancelled: number };
  invoices: InvoiceTotals;
  expired: boolean; partly: boolean; syncError: string | null; lastSyncedAt: string | null; createdAt: string | null; updatedAt: string | null;
}

/** Line totals, invoice totals and the `created` log (source + group) of some transfers. */
const enrich = async (heads: HeadRow[]): Promise<D2cListItem[]> => {
  if (!heads.length) return [];
  const uids = heads.map((h) => String(h.uid));
  const [totals, invoices, created] = await Promise.all([
    AppDataSource.query<Record<string, unknown>[]>(
      `SELECT shipmentOrderId uid, COUNT(*) line_count, SUM(COALESCE(updatedQty, qty, 0) > 0) skus, SUM(COALESCE(qty, 0)) qty,
              SUM(COALESCE(updatedQty, qty, 0)) updated_qty, SUM(COALESCE(dispatchedQty, 0)) dispatched, SUM(COALESCE(channelInwardingQuantity, 0)) received,
              SUM(COALESCE(gmv, 0)) gmv, SUM(COALESCE(poValue, 0)) po_value, SUM(COALESCE(updatedGmv, gmv, 0)) updated_gmv, SUM(COALESCE(updatedPoValue, poValue, 0)) updated_po_value
         FROM ${L} WHERE shipmentOrderId IN (?) GROUP BY shipmentOrderId`,
      [uids],
    ),
    AppDataSource.query<Record<string, unknown>[]>(
      `SELECT po_uid uid, COUNT(*) invoices, SUM(dispatched_at IS NOT NULL) dispatched,
              SUM(dispatched_at IS NOT NULL AND (inward_po_state IS NULL OR inward_po_state = ?)) awaiting,
              SUM(inward_po_state IN (?, ?, ?)) inward_pos,
              SUM(grn_completed_at IS NOT NULL AND received_units <> units AND variance_reason IS NULL) variance_open
         FROM ${I} WHERE po_uid IN (?) GROUP BY po_uid`,
      [R.FAILED, R.REQUESTED, R.CREATED, R.UNKNOWN, uids],
    ),
    AppDataSource.query<{ uid: string | number; source: string; remark: string | null }[]>(
      `SELECT shipment_uid uid, source, remark FROM ${LOGS} WHERE action = ? AND shipment_uid IN (?) ORDER BY id`,
      [SHIPMENT_LOG_ACTION.CREATED, uids],
    ),
  ]);
  const tBy = new Map(totals.map((t) => [String(t.uid), t]));
  const iBy = new Map(invoices.map((t) => [String(t.uid), t]));
  const cBy = new Map<string, { source: string; remark: string | null }>();
  for (const c of created) if (!cBy.has(String(c.uid))) cBy.set(String(c.uid), c);
  const today = todayIst();
  const notFoundMs = (await readSettings()).soNotFoundHours * 3_600_000;
  return heads.map((h) => {
    const uid = String(h.uid);
    const t = tBy.get(uid) ?? {};
    const inv = iBy.get(uid) ?? {};
    const c = cBy.get(uid);
    const tot: Totals = {
      lines: n(t.line_count), skus: n(t.skus), qty: n(t.qty), updatedQty: n(t.updated_qty), dispatched: n(t.dispatched), received: n(t.received),
      gmv: n(t.gmv), poValue: n(t.po_value), updatedGmv: n(t.updated_gmv), updatedPoValue: n(t.updated_po_value),
    };
    const openBalance = tot.updatedQty - tot.dispatched;
    const final = D2C_FINAL_STAGES.includes(h.transferStage ?? '');
    return {
      uid, transferCode: h.transferCode, reference: h.poNumber, poDate: h.poDate, entryDate: h.entryDate, expiryDate: h.labelsLink,
      sender: { id: h.facilityId === null ? null : Number(h.facilityId), code: h.facility }, receiving: { id: h.rid === null ? null : Number(h.rid), code: h.rcode },
      channel: h.channel, location: h.location, locationId: h.locationId === null ? null : String(h.locationId), priority: h.transferPriority,
      type: h.transferType, uniwareChannel: h.routeChannel, routeId: h.transferRouteId === null ? null : Number(h.transferRouteId), stage: h.transferStage, stageAt: iso(h.transferStageAt), soState: h.soState, soError: h.soError, soCode: h.orderNo1,
      soRequestedAt: iso(h.soRequestedAt),
      soNotFound: (h.soState === R.REQUESTED || h.soState === R.UNKNOWN) && !!h.soRequestedAt && Date.now() - new Date(h.soRequestedAt).getTime() > notFoundMs,
      invoiceNo: h.invoiceChallanNumber, inwardPo: h.poNumberInwardCWH, dispatchDate: h.dispatchDate, rtsDate: h.rtsDate, grnDate: h.deliveryDate,
      balanceClosedReason: h.balanceClosedReason, remarks: h.specialRemarksCOPT, source: c?.source ?? null, group: groupOfRemark(c?.remark ?? null),
      totals: { ...tot, openBalance, cancelled: tot.qty - tot.updatedQty },
      invoices: { invoices: n(inv.invoices), dispatched: n(inv.dispatched), awaitingInwardPo: n(inv.awaiting), inwardPos: n(inv.inward_pos), varianceOpen: n(inv.variance_open) },
      expired: !final && !!h.labelsLink && h.labelsLink < today && openBalance > 0,
      partly: tot.dispatched > 0 && openBalance > 0,
      syncError: h.syncError, lastSyncedAt: iso(h.lastSyncedAt), createdAt: iso(h.createdAt), updatedAt: iso(h.updatedAt),
    };
  });
};

/** GET /d2c-transfers: one page of a tab. */
export const listTransfers = async (f: D2cFilters, p: Paging): Promise<{ items: D2cListItem[]; total: number }> => {
  const w = where(f);
  const [[{ total }], heads] = await Promise.all([
    AppDataSource.query<{ total: string | number }[]>(`SELECT COUNT(*) total ${FROM} WHERE ${w.sql}`, w.params),
    AppDataSource.query<HeadRow[]>(`SELECT ${HEAD_COLS} ${FROM} WHERE ${w.sql} ${ORDER} LIMIT ? OFFSET ?`, [...w.params, p.pageSize, (p.page - 1) * p.pageSize]),
  ]);
  return { items: await enrich(heads), total: Number(total) };
};

/**
 * GET /d2c-transfers/counts: per tab with the same filters (the tab itself ignored): transfers, except the two invoice
 * tabs (Create inward PO / Inward POs), which count invoices = the rows they show (fix 2026-11-03).
 */
export const tabCounts = async (f: D2cFilters): Promise<Record<D2cTab, number>> => {
  const w = where(f, false);
  const tabs = Object.values(D2C_TAB);
  const [[row], [inv]] = await Promise.all([
    AppDataSource.query<Record<string, string | number>[]>(
      `SELECT ${tabs.map((t) => `SUM(CASE WHEN ${TAB_SQL[t]} THEN 1 ELSE 0 END) \`${t}\``).join(', ')} ${FROM} WHERE ${w.sql}`,
      w.params,
    ),
    AppDataSource.query<Record<string, string | number>[]>(
      `SELECT ${INVOICE_TABS.map((t) => `SUM(CASE WHEN ${INVOICE_TAB_SQL[t] as string} THEN 1 ELSE 0 END) \`${t}\``).join(', ')} ${INVOICE_FROM} WHERE ${w.sql}`,
      w.params,
    ),
  ]);
  return Object.fromEntries(tabs.map((t) => [t, Number((INVOICE_TABS.includes(t) ? inv : row)?.[t] ?? 0)])) as Record<D2cTab, number>;
};

export interface TimelineItem {
  id: string; at: string; by: string | null; byEmail: string | null; action: string; source: string; tag: string; field: string | null;
  lineId: string | null; oldValue: string | null; newValue: string | null; remark: string | null; uniwareStatus: string | null; batchId: string | null;
}

/** GET /d2c-transfers/:id/events: every log row of a transfer, oldest first (at most HISTORY_MAX, the newest kept). */
export const transferEvents = async (uid: string): Promise<TimelineItem[]> => {
  await findHead(uid);
  const rows = await AppDataSource.query<Record<string, unknown>[]>(
    `SELECT * FROM (SELECT l.id, l.created_at at, u.name, u.email, l.action, l.source, l.field_name field, l.line_id, l.old_value, l.new_value,
                           l.remark, l.uniware_status, l.batch_id
                      FROM ${LOGS} l LEFT JOIN ${TABLES.USERS} u ON u.id = l.user_id
                     WHERE l.shipment_uid = ? ORDER BY l.id DESC LIMIT ?) x ORDER BY id ASC`,
    [uid, D2C_LIMITS.HISTORY_MAX],
  );
  return rows.map((r) => ({
    id: String(r.id), at: new Date(r.at as Date).toISOString(), by: (r.name as string | null) ?? null, byEmail: (r.email as string | null) ?? null,
    action: String(r.action), source: String(r.source), tag: sourceTag(String(r.source)), field: (r.field as string | null) ?? null,
    lineId: r.line_id === null ? null : String(r.line_id as string | number), oldValue: (r.old_value as string | null) ?? null, newValue: (r.new_value as string | null) ?? null,
    remark: (r.remark as string | null) ?? null, uniwareStatus: (r.uniware_status as string | null) ?? null, batchId: (r.batch_id as string | null) ?? null,
  }));
};

const findHead = async (uid: string): Promise<HeadRow> => {
  const [h] = await AppDataSource.query<HeadRow[]>(`SELECT ${HEAD_COLS} ${FROM} WHERE p.uid = ? AND p.transferCode IS NOT NULL`, [uid]);
  if (!h) throw appError(ERROR_CODES.D2C_NOT_FOUND, uid);
  return h;
};

/** GET /d2c-transfers/:id: header, lines, invoices, route codes, timeline, edit token and what may be done now. */
export const getTransfer = async (uid: string) => {
  const head = await findHead(uid);
  const [item] = await enrich([head]);
  const [po, lines, invoices, routes, events] = await Promise.all([
    AppDataSource.getRepository(MasterPurchaseOrder).findOneByOrFail({ uid }),
    AppDataSource.getRepository(DetailsPurchaseOrder).find({ where: { shipmentOrderId: uid }, order: { id: 'ASC' } }),
    AppDataSource.query<Record<string, unknown>[]>(`SELECT * FROM ${I} WHERE po_uid = ? ORDER BY id`, [uid]),
    AppDataSource.query<Record<string, unknown>[]>(
      `SELECT id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active FROM ${TABLES.D2C_TRANSFER_ROUTES}
        WHERE (dispatch_facility_id = ? AND location_id = ?) OR id = ? ORDER BY id`,
      [head.facilityId ?? 0, head.locationId ?? 0, head.transferRouteId ?? 0],
    ),
    transferEvents(uid),
  ]);
  // the chosen route; a transfer saved before routes had channels: the only active route of its sender + location
  const activeRoutes = routes.filter((r) => Number(r.is_active) === 1);
  const route = head.transferRouteId !== null
    ? routes.find((r) => Number(r.id) === Number(head.transferRouteId))
    : activeRoutes.length === 1 ? activeRoutes[0] : undefined;
  const block = draftBlock(po);
  const settings = await readSettings();
  return {
    ...item,
    lines: lines.map((l) => {
      const qty = l.qty ?? 0;
      const updated = l.updatedQty ?? qty;
      return {
        id: l.id, srNo: l.srNo, skuCode: l.skuCode, skuName: l.skuName, brand: l.brandName, qty, updatedQty: updated, cancelled: qty - updated,
        dispatched: l.dispatchedQty ?? 0, received: l.channelInwardingQuantity ?? 0, allocated: l.allocatedQty ?? 0,
        variance: (l.channelInwardingQuantity ?? 0) - (l.dispatchedQty ?? 0), mrp: qty ? Number(l.gmv ?? 0) / qty : null,
        gmv: l.gmv, poValue: l.poValue, updatedGmv: l.updatedGmv, updatedPoValue: l.updatedPoValue, removed: updated === 0 && qty > 0,
      };
    }),
    invoices: invoices.map((i) => ({
      id: String(i.id), saleOrderCode: i.sale_order_code, shippingPackageCode: i.shipping_package_code, invoiceCode: i.invoice_code,
      invoiceDisplayCode: i.invoice_display_code, invoiceDate: iso(i.invoice_date as Date | null), packageStatus: i.package_status,
      dispatchedAt: iso(i.dispatched_at as Date | null), units: n(i.units), inwardPoCode: i.inward_po_code, inwardPoState: i.inward_po_state,
      inwardPoError: i.inward_po_error, inwardPoStatus: i.inward_po_status, grnCodes: i.grn_codes, receivedUnits: n(i.received_units),
      grnCompletedAt: iso(i.grn_completed_at as Date | null), variance: n(i.received_units) - n(i.units), varianceReason: i.variance_reason,
      varianceNote: i.variance_note, skuQty: i.sku_qty, inwardPoRequestedAt: iso(i.inward_po_requested_at as Date | null),
      varianceOpen: !!i.grn_completed_at && n(i.received_units) !== n(i.units) && !i.variance_reason,
      canVarianceReason: varianceBlock({
        grnCompletedAt: i.grn_completed_at as Date | null, receivedUnits: n(i.received_units), units: n(i.units), varianceReason: i.variance_reason as string | null,
      }) === null,
    })),
    route: route
      ? {
        id: Number(route.id), uniwareChannelCode: route.uniware_channel_code, customerCode: route.customer_code, customerName: route.customer_name,
        vendorCode: route.vendor_code, isActive: Number(route.is_active) === 1, missingVendor: !route.vendor_code, missingCustomer: !route.customer_code,
        missingChannel: !route.uniware_channel_code,
      }
      : null,
    /** Active Uniware channels of the sender + location (2+ = the edit form asks which). */
    routeChannels: activeRoutes.map((r) => ({ routeId: Number(r.id), uniwareChannelCode: r.uniware_channel_code as string | null })),
    fileUrl: po.transferFileUrl,
    batchId: po.transferBatchId,
    editToken: editToken(editableState(po, lines)),
    can: {
      edit: block === null,
      cancel: block === null
        || (po.soState === D2C_REQUEST_STATE.CREATED && cancelBlock(po, item.totals.dispatched, item.invoices.dispatched) === null),
      changeExpiry: !D2C_FINAL_STAGES.includes(po.transferStage ?? ''),
      createSo: block === null,
      closeShort: po.soState === D2C_REQUEST_STATE.CREATED && !D2C_FINAL_STAGES.includes(po.transferStage ?? '') && item.totals.openBalance > 0,
      /** Uniware writes (SO / cancel / close short at the sender) allowed for this transfer now (plan 2.11 gate + test mode). */
      uniwareWrite: uniwareWritesAllowed(settings, gateOf(settings).envWrites, { sender: po.facility, receiving: item.receiving.code }, 'sender'),
    },
    editBlockedBecause: block,
    timeline: events,
  };
};

// ---- export ------------------------------------------------------------------------------------------------------

const PO_COLUMNS: [string, (t: D2cListItem) => unknown][] = [
  ['Transfer ID', (t) => t.transferCode], ['Reference ID', (t) => t.reference], ['PO Date', (t) => t.poDate], ['PO Expiry Date', (t) => t.expiryDate],
  ['Dispatch WH', (t) => t.sender.code], ['Receiving WH', (t) => t.receiving.code], ['Channel', (t) => t.channel], ['Location', (t) => t.location],
  ['Type', (t) => t.type], ['Priority', (t) => t.priority], ['Stage', (t) => t.stage], ['SO status', (t) => t.soState], ['Uniware SO', (t) => t.soCode],
  ['Uniware channel', (t) => t.uniwareChannel],
  ['Invoice no', (t) => t.invoiceNo], ['Inward PO', (t) => t.inwardPo], ['SKUs', (t) => t.totals.skus], ['Total qty', (t) => t.totals.qty],
  ['Updated qty', (t) => t.totals.updatedQty], ['Dispatched', (t) => t.totals.dispatched], ['Received', (t) => t.totals.received],
  ['Open balance', (t) => t.totals.openBalance], ['GMV', (t) => t.totals.updatedGmv], ['PO Value', (t) => t.totals.updatedPoValue],
  ['Expired', (t) => (t.expired ? 'Yes' : 'No')], ['Source', (t) => t.source], ['Group', (t) => t.group], ['Remarks', (t) => t.remarks],
  ['Created at', (t) => t.createdAt], ['Updated at', (t) => t.updatedAt],
];
const SKU_HEAD = PO_COLUMNS.slice(0, 11);
const SKU_COLUMNS: [string, (l: DetailsPurchaseOrder) => unknown][] = [
  ['Sr No', (l) => l.srNo], ['SKU Code', (l) => l.skuCode], ['SKU Name', (l) => l.skuName], ['Brand', (l) => l.brandName], ['Qty', (l) => l.qty],
  ['Updated qty', (l) => l.updatedQty], ['Cancelled', (l) => (l.qty ?? 0) - (l.updatedQty ?? l.qty ?? 0)], ['Dispatched', (l) => l.dispatchedQty ?? 0],
  ['Received', (l) => l.channelInwardingQuantity ?? 0], ['GMV', (l) => l.updatedGmv ?? l.gmv], ['PO Value', (l) => l.updatedPoValue ?? l.poValue],
];
const row = (cells: unknown[]) => cells.map((c) => csvCell(safeCell(c))).join(',');

/** GET /d2c-transfers/export?level=po|sku&<filters>: CSV, at most EXPORT_MAX_ROWS rows. */
export const exportTransfers = async (f: D2cFilters, level: string): Promise<{ csv: string; rows: number; truncated: boolean }> => {
  const w = where(f);
  const heads = await AppDataSource.query<HeadRow[]>(`SELECT ${HEAD_COLS} ${FROM} WHERE ${w.sql} ${ORDER} LIMIT ?`, [...w.params, D2C_LIMITS.EXPORT_MAX_ROWS + 1]);
  let truncated = heads.length > D2C_LIMITS.EXPORT_MAX_ROWS;
  const items = await enrich(heads.slice(0, D2C_LIMITS.EXPORT_MAX_ROWS));
  if (level !== D2C_EXPORT_LEVEL.SKU) {
    return { csv: `${[row(PO_COLUMNS.map((c) => c[0])), ...items.map((t) => row(PO_COLUMNS.map((c) => c[1](t))))].join('\r\n')}\r\n`, rows: items.length, truncated };
  }
  const lines = items.length
    ? await AppDataSource.getRepository(DetailsPurchaseOrder).createQueryBuilder('l').where('l.shipmentOrderId IN (:...uids)', { uids: items.map((t) => t.uid) })
      .orderBy('l.shipmentOrderId').addOrderBy('l.id').getMany()
    : [];
  const byUid = new Map<string, DetailsPurchaseOrder[]>();
  for (const l of lines) byUid.set(String(l.shipmentOrderId), [...(byUid.get(String(l.shipmentOrderId)) ?? []), l]);
  const out = [row([...SKU_HEAD.map((c) => c[0]), ...SKU_COLUMNS.map((c) => c[0])])];
  for (const t of items) {
    for (const l of byUid.get(t.uid) ?? []) {
      if (out.length > D2C_LIMITS.EXPORT_MAX_ROWS) { truncated = true; break; }
      out.push(row([...SKU_HEAD.map((c) => c[1](t)), ...SKU_COLUMNS.map((c) => c[1](l))]));
    }
  }
  return { csv: `${out.join('\r\n')}\r\n`, rows: out.length - 1, truncated };
};

// ---- the form ----------------------------------------------------------------------------------------------------

/** GET /d2c-transfers/options: what the form and the filters offer. */
export const transferOptions = async () => {
  const settings = await readSettings();
  const [senders, locations, routes, facilities] = await Promise.all([
    AppDataSource.query<{ id: number; code: string; name: string | null }[]>(
      `SELECT id, code, name FROM ${TABLES.MASTER_FACILITIES} WHERE is_active = 1 AND allow_internal_transfer = 1 ORDER BY code`,
    ),
    AppDataSource.query<Record<string, unknown>[]>(
      `SELECT d.id, d.channel_name, d.channel_location_code, d.transfer_po_prefix, d.is_active, d.transfer_facility_id, f.code receiving_code,
              f.is_active receiving_active, f.allow_internal_transfer receiving_allowed
         FROM ${TABLES.DETAILS_CHANNELS} d JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id
        WHERE d.channel_name IN (?) ORDER BY d.channel_name, d.channel_location_code`,
      [settings.channels],
    ),
    AppDataSource.query<Record<string, unknown>[]>(
      `SELECT r.id, r.dispatch_facility_id, f.code sender_code, r.location_id, r.is_active, r.uniware_channel_code, r.customer_code, r.vendor_code
         FROM ${TABLES.D2C_TRANSFER_ROUTES} r JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = r.dispatch_facility_id ORDER BY f.code, r.uniware_channel_code`,
    ),
    AppDataSource.query<{ id: number; code: string }[]>(`SELECT DISTINCT f.id, f.code FROM ${TABLES.MASTER_FACILITIES} f JOIN ${TABLES.DETAILS_CHANNELS} d ON d.transfer_facility_id = f.id ORDER BY f.code`),
  ]);
  const routesOf = (locationId: string) => routes.filter((r) => String(r.location_id) === locationId).map((r) => ({
    routeId: Number(r.id), senderId: Number(r.dispatch_facility_id), senderCode: String(r.sender_code), isActive: Number(r.is_active) === 1,
    uniwareChannelCode: (r.uniware_channel_code as string | null) ?? null,
    missingVendor: !r.vendor_code, missingCustomer: !r.customer_code, missingChannel: !r.uniware_channel_code,
  }));
  const today = todayIst();
  return {
    senders: senders.map((s) => ({ id: Number(s.id), code: s.code, name: s.name })),
    receivingFacilities: facilities.map((f) => ({ id: Number(f.id), code: f.code })),
    channels: settings.channels,
    locations: settings.channels.map((channel) => ({
      channel,
      locations: locations.filter((l) => String(l.channel_name).toLowerCase() === channel.toLowerCase()).map((l) => ({
        id: String(l.id), location: l.channel_location_code as string | null, poPrefix: l.transfer_po_prefix as string | null, isActive: Number(l.is_active) === 1,
        receivingFacilityId: Number(l.transfer_facility_id), receivingCode: String(l.receiving_code),
        receivingUsable: Number(l.receiving_active) === 1 && Number(l.receiving_allowed) === 1, routes: routesOf(String(l.id)),
      })),
    })),
    types: settings.types,
    priorities: [...D2C_PRIORITIES],
    stages: Object.values(D2C_STAGE),
    sources: Object.values(D2C_SOURCE),
    defaults: { priority: 'P2', type: settings.types[0], poDate: today, expiryDays: settings.defaultExpiryDays },
    live: settings.live,
    /** Production gate (plan 2.11): Uniware writes for every sender only when open; else only testFacilities. */
    uniwareGate: gateOf(settings),
    /** Local test mode (env.d2c.testOnly): only TEST_FACILITY transfers; the page and Transfer Routes show a banner. */
    testOnly: gateOf(settings).testOnly,
  };
};

/** GET /d2c-transfers/skus?q=: active, not a combo, with an MRP; by code or name. */
export const skuPicker = async (q: string) => {
  const t = q.trim();
  const rows = await AppDataSource.query<Record<string, unknown>[]>(
    `SELECT pep_code, product_name, brand_name, mrp, intransit_mrp FROM ${TABLES.MASTER_SKUS}
      WHERE is_active = 1 AND (product_type IS NULL OR LOWER(product_type) <> 'combo') AND (COALESCE(mrp, 0) > 0 OR COALESCE(intransit_mrp, 0) > 0)
        ${t ? 'AND (pep_code LIKE ? OR product_name LIKE ?)' : ''}
      ORDER BY pep_code LIMIT ?`,
    t ? [like(t), like(t), D2C_LIMITS.SKU_PICKER_MAX] : [D2C_LIMITS.SKU_PICKER_MAX],
  );
  return rows.map((r) => {
    const mrp = mrpOf(r.mrp === null ? null : Number(r.mrp), r.intransit_mrp === null ? null : Number(r.intransit_mrp));
    return { code: String(r.pep_code), name: r.product_name as string | null, brand: r.brand_name as string | null, mrp, soUnitPrice: mrp === null ? null : Math.round(mrp * D2C_PRICE.SO_MRP_SHARE * 100) / 100 };
  });
};

/** GET /d2c-transfers/next-reference?locationId=&poDate=&type=: the reference the next save would take (may change). */
export const nextReference = async (query: Record<string, unknown>) => {
  const settings = await readSettings();
  const today = todayIst();
  const s = (k: string) => {
    const v = query[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const poDate = s('poDate') ? parseDay(s('poDate')) : today;
  if (!poDate) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'poDate', code: ERROR_CODES.FIELD_NOT_DAY, message: 'poDate must be a date (YYYY-MM-DD or DD-MM-YYYY)' }]);
  const type = s('type') ? settings.types.find((x) => x.toLowerCase() === s('type').toLowerCase()) : settings.types[0];
  if (!type) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'type', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `type must be one of ${settings.types.join(', ')}` }]);
  const locationId = s('locationId');
  if (!/^\d{1,19}$/.test(locationId)) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'locationId', code: ERROR_CODES.FIELD_REQUIRED, message: 'locationId is required' }]);
  const [loc] = await AppDataSource.query<{ channel_name: string; channel_location_code: string | null; transfer_po_prefix: string | null }[]>(
    `SELECT channel_name, channel_location_code, transfer_po_prefix FROM ${TABLES.DETAILS_CHANNELS} WHERE id = ? AND transfer_facility_id IS NOT NULL`,
    [locationId],
  );
  if (!loc?.transfer_po_prefix?.trim()) throw appError(ERROR_CODES.D2C_NO_MAPPING, loc?.channel_name ?? '-', loc?.channel_location_code ?? locationId);
  const [reference] = await peekReferences([{ prefix: loc.transfer_po_prefix.trim(), poDate, type }], settings, today);
  return { reference, poDate, type, note: 'may change on save' };
};

// ---- invoices (phase 7: Create inward PO / Inward POs tabs) ----------------------------------------------------------

/** Invoice rows of the two invoice tabs (plan 1.3): the transfer filters apply, plus the invoice's own condition. */
const INVOICE_TAB_SQL: Partial<Record<D2cTab, string>> = {
  [D2C_TAB.CREATE_INWARD_PO]: `i.dispatched_at IS NOT NULL AND (i.inward_po_state IS NULL OR i.inward_po_state = '${R.FAILED}')`,
  [D2C_TAB.INWARD_POS]: `p.transferStage <> '${D2C_STAGE.CLOSED}' AND i.inward_po_state IN ('${R.REQUESTED}', '${R.CREATED}', '${R.UNKNOWN}')`,
};
const INVOICE_TABS = Object.keys(INVOICE_TAB_SQL) as D2cTab[];
const INVOICE_FROM = `FROM ${I} i JOIN ${P} p ON p.uid = i.po_uid
  LEFT JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = p.locationId
  LEFT JOIN ${TABLES.MASTER_FACILITIES} rf ON rf.id = d.transfer_facility_id
  LEFT JOIN ${TABLES.D2C_TRANSFER_ROUTES} tr ON tr.id = p.transferRouteId`;

/** The route's vendor: the chosen route, else the only active route of the sender + location. */
const ROUTE_VENDOR = `COALESCE(tr.vendor_code, (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(r2.vendor_code) END FROM ${TABLES.D2C_TRANSFER_ROUTES} r2
  WHERE r2.dispatch_facility_id = p.facilityId AND r2.location_id = p.locationId AND r2.is_active = 1))`;

export interface D2cInvoiceItem {
  id: string; uid: string; transferCode: string; reference: string | null; soCode: string | null; stage: string | null; priority: string | null;
  sender: string | null; receiving: string | null; vendorCode: string | null; vendorMissing: boolean;
  invoiceNo: string | null; shippingPackageCode: string; invoiceDate: string | null; dispatchedAt: string | null; units: number;
  inwardPoCode: string | null; inwardPoState: string | null; inwardPoError: string | null; inwardPoStatus: string | null; inwardPoRequestedAt: string | null;
  grnCodes: unknown; receivedUnits: number; grnCompletedAt: string | null; variance: number; varianceOpen: boolean;
  varianceReason: string | null; varianceNote: string | null;
  /** May an inward PO be requested now (state + vendor + receiving + gate; the reserve re-checks everything). */
  canCreate: boolean; createBlockedBecause: string | null; canVarianceReason: boolean;
}

/**
 * GET /d2c-transfers/invoices?tab=create_inward_po|inward_pos&<list filters>: one page of invoice rows (plan 1.3,
 * 9.1), sorted like the list (priority, PO date, transfer), then invoice id.
 */
export const listInvoices = async (f: D2cFilters, p: Paging): Promise<{ items: D2cInvoiceItem[]; total: number }> => {
  const cond = INVOICE_TAB_SQL[f.tab];
  if (!cond) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'tab', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `tab must be one of ${INVOICE_TABS.join(', ')}` }]);
  }
  const w = where({ ...f, tab: D2C_TAB.OVERVIEW });
  const from = INVOICE_FROM;
  const sql = `${w.sql} AND ${cond}`;
  const [[{ total }], rows, settings] = await Promise.all([
    AppDataSource.query<{ total: string | number }[]>(`SELECT COUNT(*) total ${from} WHERE ${sql}`, w.params),
    AppDataSource.query<Record<string, unknown>[]>(
      `SELECT i.*, p.uid, p.transferCode, p.poNumber, p.orderNo1, p.transferStage, p.transferPriority, p.facility, p.soState, rf.code rcode, ${ROUTE_VENDOR} vendor
       ${from} WHERE ${sql}
       ORDER BY p.transferPriority IS NULL, p.transferPriority ASC, p.poDate ASC, p.uid ASC, i.id ASC LIMIT ? OFFSET ?`,
      [...w.params, p.pageSize, (p.page - 1) * p.pageSize],
    ),
    readSettings(),
  ]);
  const envWrites = gateOf(settings).envWrites;
  const items = rows.map((r): D2cInvoiceItem => {
    const vendor = (r.vendor as string | null) ?? null;
    const receiving = (r.rcode as string | null) ?? null;
    const state = (r.inward_po_state as string | null) ?? null;
    const dispatched = !!r.dispatched_at;
    const created = state === R.CREATED || state === R.REQUESTED || state === R.UNKNOWN;
    const blocked = !dispatched ? 'not dispatched'
      : created ? `inward PO ${state}`
        : r.soState !== R.CREATED ? 'no sale order in Uniware'
          : !receiving ? 'no receiving facility: fill it in Masters'
            : !vendor ? `vendor code missing on route ${(r.facility as string | null) ?? '-'} -> ${receiving}: fill it in Masters`
              : !uniwareWritesAllowed(settings, envWrites, { sender: (r.facility as string | null) ?? null, receiving }, 'receiving')
                ? gateError({ sender: (r.facility as string | null) ?? null, receiving }).message
                : null;
    const units = n(r.units);
    const received = n(r.received_units);
    return {
      id: String(r.id), uid: String(r.uid), transferCode: String(r.transferCode), reference: (r.poNumber as string | null) ?? null, soCode: (r.orderNo1 as string | null) ?? null,
      stage: (r.transferStage as string | null) ?? null, priority: (r.transferPriority as string | null) ?? null, sender: (r.facility as string | null) ?? null,
      receiving, vendorCode: vendor, vendorMissing: !vendor,
      invoiceNo: ((r.invoice_display_code ?? r.invoice_code) as string | null) ?? null, shippingPackageCode: String(r.shipping_package_code),
      invoiceDate: iso(r.invoice_date as Date | null), dispatchedAt: iso(r.dispatched_at as Date | null), units,
      inwardPoCode: (r.inward_po_code as string | null) ?? null, inwardPoState: state, inwardPoError: (r.inward_po_error as string | null) ?? null,
      inwardPoStatus: (r.inward_po_status as string | null) ?? null, inwardPoRequestedAt: iso(r.inward_po_requested_at as Date | null),
      grnCodes: r.grn_codes ?? null, receivedUnits: received, grnCompletedAt: iso(r.grn_completed_at as Date | null), variance: received - units,
      varianceOpen: !!r.grn_completed_at && received !== units && !r.variance_reason,
      varianceReason: (r.variance_reason as string | null) ?? null, varianceNote: (r.variance_note as string | null) ?? null,
      canCreate: blocked === null, createBlockedBecause: blocked,
      canVarianceReason: varianceBlock({
        grnCompletedAt: r.grn_completed_at as Date | null, receivedUnits: received, units, varianceReason: (r.variance_reason as string | null) ?? null,
      }) === null,
    };
  });
  return { items, total: Number(total) };
};
