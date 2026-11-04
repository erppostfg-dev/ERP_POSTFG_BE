import { createHash } from 'crypto';
import { D2C_REQUEST_STATE, D2C_SOURCE_TAG, D2C_STAGE, D2C_STATUS_TEXT, D2C_TAB, D2cStage, D2cTab } from '../../constants';

/*
 * Pure rules of a transfer (no database): status texts per stage (plan 1.5), sub-tab membership from facts (1.3), the
 * edit token of a draft (2.2: a hash of what can be edited, checked under the row lock) and export cell escaping.
 * The list's SQL (queries.ts) applies the same tab rules; the unit tests pin both down.
 */

/** statusPlanning / statusWarehouse / statusLogistics of a stage. */
export const statusTextsOf = (stage: D2cStage) => {
  const t = D2C_STATUS_TEXT[stage];
  return { statusPlanning: t.planning, statusWarehouse: t.warehouse, statusLogistics: t.logistics };
};

export interface TabFacts {
  stage: string;
  soState: string | null;
  /** Σ(updatedQty − dispatched) over the lines. */
  openBalance: number;
  invoices: { dispatched: boolean; inwardPoState: string | null }[];
}

const FAILED_OR_NONE = (s: string | null) => s === null || s === D2C_REQUEST_STATE.FAILED;
const IN_FLIGHT_OR_DONE: (string | null)[] = [D2C_REQUEST_STATE.REQUESTED, D2C_REQUEST_STATE.CREATED, D2C_REQUEST_STATE.UNKNOWN];

/** Every sub-tab a transfer shows in (plan 1.3): a partly dispatched one is in each tab where it has work. */
export const tabsOf = (f: TabFacts): D2cTab[] => {
  const tabs: D2cTab[] = [];
  if (f.stage === D2C_STAGE.DRAFT) tabs.push(D2C_TAB.DRAFT);
  if (f.soState === D2C_REQUEST_STATE.CREATED && f.openBalance > 0 && f.stage !== D2C_STAGE.CANCELLED) tabs.push(D2C_TAB.SALE_ORDERS);
  if (f.invoices.some((i) => i.dispatched && FAILED_OR_NONE(i.inwardPoState))) tabs.push(D2C_TAB.CREATE_INWARD_PO);
  if (f.stage !== D2C_STAGE.CLOSED && f.invoices.some((i) => IN_FLIGHT_OR_DONE.includes(i.inwardPoState))) tabs.push(D2C_TAB.INWARD_POS);
  tabs.push(D2C_TAB.OVERVIEW);
  return tabs;
};

/** What a draft edit may change; the token is a hash of exactly this. */
export interface EditableState {
  facilityId: number | null;
  channel: string | null;
  locationId: string | null;
  poDate: string | null;
  priority: string | null;
  type: string | null;
  expiry: string | null;
  remarks: string | null;
  /** d2c_transfer_routes.id chosen (the Uniware channel when the route has 2+); absent = not set. */
  routeId?: number | null;
  lines: { id: string; skuCode: string | null; qty: number | null; updatedQty: number | null }[];
}

/** Edit token: sha256 of the editable fields + lines (line order does not matter). */
export const editToken = (s: EditableState): string => {
  const lines = [...s.lines].sort((a, b) => Number(a.id) - Number(b.id)).map((l) => [String(l.id), l.skuCode ?? '', l.qty ?? null, l.updatedQty ?? null]);
  const body = JSON.stringify([
    s.facilityId ?? null, s.channel ?? null, s.locationId === null ? null : String(s.locationId), s.poDate ?? null, s.priority ?? null,
    s.type ?? null, s.expiry ?? null, s.remarks ?? null, lines, s.routeId ?? null,
  ]);
  return createHash('sha256').update(body).digest('hex');
};

/** TOOL / TOOL · API / UNIWARE / SYSTEM of a shipment_logs source (pipeline / review / script stay as they are). */
export const sourceTag = (source: string): string => D2C_SOURCE_TAG[source] ?? source.toUpperCase();

/** A spreadsheet cell that would start a formula (= + - @, tab, CR) is prefixed with ' (plan, review 25). */
export const safeCell = (v: unknown): string | number => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : JSON.stringify(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

/** The group a transfer was imported with, from its `created` log remark ("IT-... | group G1"). */
const GROUP_REMARK = ' | group ';
export const createdRemark = (transferCode: string, group: string | null): string => (group ? `${transferCode}${GROUP_REMARK}${group}` : transferCode);
export const groupOfRemark = (remark: string | null): string | null => {
  const i = (remark ?? '').indexOf(GROUP_REMARK);
  return i < 0 ? null : (remark as string).slice(i + GROUP_REMARK.length);
};

// ---- stage (plan 1.1) --------------------------------------------------------------------------------------------

export interface StageFacts {
  /** The stage now (cancelled stays cancelled). */
  stage: string | null;
  soState: string | null;
  lines: { updatedQty: number; dispatched: number }[];
  invoices: {
    packageStatus: string | null; invoiced: boolean; dispatched: boolean; inwardPoState: string | null; grnCompleted: boolean;
    variance: number; varianceReason: string | null;
  }[];
}

const PACKAGE_RTS = ['READY_TO_SHIP', 'MANIFESTED'];

/**
 * The stage of a transfer from its facts (plan 1.1), recomputed after every action and sync, inside the row lock.
 * No SO in Uniware = draft. Nothing dispatched and nothing left (closed short / cancelled in Uniware before any
 * dispatch) = cancelled.
 */
export const deriveStage = (f: StageFacts): D2cStage => {
  if (f.stage === D2C_STAGE.CANCELLED) return D2C_STAGE.CANCELLED;
  if (f.soState !== D2C_REQUEST_STATE.CREATED) return D2C_STAGE.DRAFT;
  const dispatched = f.lines.reduce((s, l) => s + Math.max(0, l.dispatched), 0);
  const balance = f.lines.reduce((s, l) => s + Math.max(0, l.updatedQty - l.dispatched), 0);
  const shipped = f.invoices.filter((i) => i.dispatched);
  if (!dispatched && !shipped.length) {
    if (balance === 0) return D2C_STAGE.CANCELLED;
    if (f.invoices.some((i) => i.invoiced)) return D2C_STAGE.INVOICED;
    if (f.invoices.some((i) => PACKAGE_RTS.includes((i.packageStatus ?? '').toUpperCase()))) return D2C_STAGE.READY_TO_SHIP;
    if (f.invoices.some((i) => (i.packageStatus ?? '').toUpperCase() === 'PACKED')) return D2C_STAGE.PACKED;
    return D2C_STAGE.SALE_ORDER;
  }
  if (balance > 0) return D2C_STAGE.PARTLY_DISPATCHED;
  if (shipped.some((i) => i.inwardPoState !== D2C_REQUEST_STATE.CREATED)) return D2C_STAGE.DISPATCHED;
  if (shipped.some((i) => !i.grnCompleted)) return D2C_STAGE.INWARD_PO_CREATED;
  if (shipped.some((i) => i.variance !== 0 && !i.varianceReason)) return D2C_STAGE.GRN;
  return D2C_STAGE.CLOSED;
};
