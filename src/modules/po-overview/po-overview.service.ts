import {
  ACCESS_LEVEL,
  COLUMN_ACCESS,
  ColumnAccess,
  ColumnDef,
  DELIVERY_TYPE,
  ERROR_CODES,
  PAGE,
  PICKUP_CHANNELS,
  PO_KEY_COLUMNS,
  PO_SYSTEM_COLUMNS,
  PO_TEAM_COLUMNS,
  PO_TEAM_LABEL,
  PO_TEAM_ORDER,
  PoTeam,
  STATUS_WHEN_EMPTY,
} from '../../constants';
import { resolveAccess } from '../auth/access.service';
import { DetailsPurchaseOrder, MasterCourierRate, MasterPurchaseOrder } from '../../entities';
import { appError } from '../../utils/AppError';
import { matchKey } from '../masters/master-match';
import {
  facilitiesByIds,
  filterOptions,
  FilterOptions,
  finalStatusRows,
  findLinePage,
  findLinesOfShipment,
  findShipment,
  findShipmentPage,
  lineTotals,
  locationsByIds,
  Paging,
  partnersByIds,
  PoOverviewFilters,
  ratesOfPartners,
  skuWeights,
} from './po-overview.queries';

/*
 * PO Overview: our POs as PEPIMS's dashboard shows them. A shipment item = every master_purchase_orders column as
 * stored (camelCase, dates as YYYY-MM-DD) + the line sums + the columns PEPIMS computes:
 *   currentAppointmentDate   currentAppointmentDate, else firstAppointmentDateCOPT
 *   statusFinal              master_final_status_map for the three stages (empty stage = STATUS_WHEN_EMPTY); null = no mapping
 *   tatDays                  the courier rate's TAT (first transporter, facility pickup city -> location drop city), else the partner's
 *   criticalDispatchDate     current appointment date - TAT days
 *   ratePerKg                rpk, else that courier rate
 *   deliveryType             stored, else Amazon / Flipkart "Pick up", others "Drop in"
 *   channelType              stored, else the delivery location's appointment channel type (B2B / B2C)
 * The page's "PO Expiry Date" is PEPIMS's labelsLink column (PEPIMS keeps the expiry there).
 */

/** master_purchase_orders DATE columns: sent as YYYY-MM-DD. */
const DATE_FIELDS = [
  'entryDate', 'poDate', 'dispatchDateTentative', 'workingDatePlanner', 'rtsDate', 'dispatchDate', 'currentAppointmentDate',
  'firstAppointmentDateCOPT', 'invoiceDate', 'deliveryDate', 'firstAppointmentDate', 'secondAppointmentDate', 'thirdAppointmentDate',
  'appointmentShootedDate', 'appointmentRequestedDate',
] as const;

const day = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};
const minusDays = (isoDay: string, days: number): string => new Date(Date.parse(`${isoDay}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

type Stages = { statusPlanning: string | null; statusWarehouse: string | null; statusLogistics: string | null };
const stageKey = (s: Stages) => [s.statusPlanning, s.statusWarehouse, s.statusLogistics].map((v) => matchKey(v) || matchKey(STATUS_WHEN_EMPTY)).join('|');
/** Final status of a PO's three stages; null = no row in master_final_status_map. */
const finalStatusLookup = (rows: (Stages & { statusFinal: string })[]) => {
  const map = new Map(rows.map((m) => [stageKey(m), m.statusFinal]));
  return (po: Stages): string | null => map.get(stageKey(po)) ?? null;
};

export interface ShipmentComputed {
  lines: number;
  updatedQty: number;
  updatedGmv: number;
  updatedPoValue: number;
  currentAppointmentDate: string | null;
  statusFinal: string | null;
  tatDays: number | null;
  criticalDispatchDate: string | null;
  ratePerKg: number | null;
  deliveryType: string;
  channelType: string | null;
}

export type ShipmentItem = Omit<Record<string, unknown>, keyof ShipmentComputed> & ShipmentComputed & { uid: string };

/** Everything the computed columns need for a set of shipments, read once per request. */
const contextFor = async (pos: MasterPurchaseOrder[]) => {
  const ids = <T>(values: (T | null | undefined)[]) => [...new Set(values.filter((v): v is T => v !== null && v !== undefined))];
  const partnerIds = ids(pos.map((p) => p.firstTransporterId));
  const [totals, finals, facilities, partners, rates, locations] = await Promise.all([
    lineTotals(pos.map((p) => p.uid)),
    finalStatusRows(),
    facilitiesByIds(ids(pos.map((p) => p.facilityId))),
    partnersByIds(partnerIds),
    ratesOfPartners(partnerIds),
    locationsByIds(ids(pos.map((p) => p.locationId))),
  ]);
  return {
    totals,
    finalOf: finalStatusLookup(finals),
    facilities: new Map(facilities.map((f) => [f.id, f])),
    partners: new Map(partners.map((p) => [p.id, p])),
    rates,
    locations: new Map(locations.map((l) => [String(l.id), l])),
  };
};
type Context = Awaited<ReturnType<typeof contextFor>>;

const toShipmentItem = (po: MasterPurchaseOrder, c: Context): ShipmentItem => {
  const plain: Record<string, unknown> = { ...po };
  for (const k of DATE_FIELDS) plain[k] = day(plain[k]);
  const t = c.totals.get(po.uid) ?? { lines: 0, updatedQty: 0, updatedGmv: 0, updatedPoValue: 0 };
  const currentAppointmentDate = day(po.currentAppointmentDate) ?? day(po.firstAppointmentDateCOPT);
  const facility = po.facilityId !== null ? c.facilities.get(po.facilityId) : undefined;
  const location = po.locationId !== null ? c.locations.get(String(po.locationId)) : undefined;
  const partner = po.firstTransporterId !== null ? c.partners.get(po.firstTransporterId) : undefined;
  const rate: MasterCourierRate | undefined = partner && facility?.pickupLocation && location?.dropLocation
    ? c.rates.find((r) => r.courierPartnerId === partner.id && matchKey(r.pickupLocation) === matchKey(facility.pickupLocation) && matchKey(r.dropLocation) === matchKey(location.dropLocation))
    : undefined;
  const tatDays = rate?.tatDays ?? partner?.tatDays ?? null;
  return {
    ...plain,
    uid: po.uid,
    ...t,
    currentAppointmentDate,
    statusFinal: c.finalOf(po),
    tatDays,
    criticalDispatchDate: currentAppointmentDate && tatDays !== null ? minusDays(currentAppointmentDate, tatDays) : null,
    ratePerKg: po.rpk ?? rate?.ratePerKg ?? null,
    deliveryType: po.deliveryType || (PICKUP_CHANNELS.includes(matchKey(po.channel)) ? DELIVERY_TYPE.PICK_UP : DELIVERY_TYPE.DROP_IN),
    channelType: po.channelType || location?.appointmentChannelType || null,
  };
};

export const listShipments = async (f: PoOverviewFilters, p: Paging): Promise<{ items: ShipmentItem[]; total: number }> => {
  const { rows, total } = await findShipmentPage(f, p);
  const c = await contextFor(rows);
  return { items: rows.map((po) => toShipmentItem(po, c)), total };
};

export interface LineItem {
  id: string;
  shipmentUid: string;
  srNo: string | null;
  skuName: string | null;
  skuCode: string | null;
  channelSkuCode: string | null;
  brandName: string | null;
  qty: number | null;
  gmv: number | null;
  poValue: number | null;
  updatedQty: number | null;
  updatedGmv: number | null;
  updatedPoValue: number | null;
  channelInwardingQuantity: number | null;
  accountsWorking: string | null;
  actualWeight: number | null;
  /** master_skus.weight_g of the SKU (per unit). */
  productWeightG: number | null;
  // The shipment's fields the line grid shows.
  entryDate: string | null;
  poDate: string | null;
  poNumber: string | null;
  channel: string | null;
  location: string | null;
  facility: string | null;
  workingDatePlanner: string | null;
  dispatchDate: string | null;
  currentAppointmentDate: string | null;
  statusPlanning: string | null;
  statusWarehouse: string | null;
  statusLogistics: string | null;
  statusFinal: string | null;
}

const toLineItems = async (lines: DetailsPurchaseOrder[], shipmentOf: (l: DetailsPurchaseOrder) => MasterPurchaseOrder): Promise<LineItem[]> => {
  const [weights, finals] = await Promise.all([
    skuWeights([...new Set(lines.map((l) => l.skuCode).filter((s): s is string => !!s))]),
    finalStatusRows(),
  ]);
  const finalOf = finalStatusLookup(finals);
  return lines.map((l) => {
    const po = shipmentOf(l);
    return {
      id: l.id,
      shipmentUid: l.shipmentOrderId,
      srNo: l.srNo,
      skuName: l.skuName,
      skuCode: l.skuCode,
      channelSkuCode: l.channelSkuCode,
      brandName: l.brandName,
      qty: l.qty,
      gmv: l.gmv,
      poValue: l.poValue,
      updatedQty: l.updatedQty,
      updatedGmv: l.updatedGmv,
      updatedPoValue: l.updatedPoValue,
      channelInwardingQuantity: l.channelInwardingQuantity,
      accountsWorking: l.accountsWorking,
      actualWeight: l.actualWeight,
      productWeightG: weights.get(matchKey(l.skuCode)) ?? null,
      entryDate: day(po.entryDate),
      poDate: day(po.poDate),
      poNumber: po.poNumber,
      channel: po.channel,
      location: po.location,
      facility: po.facility,
      workingDatePlanner: day(po.workingDatePlanner),
      dispatchDate: day(po.dispatchDate),
      currentAppointmentDate: day(po.currentAppointmentDate) ?? day(po.firstAppointmentDateCOPT),
      statusPlanning: po.statusPlanning,
      statusWarehouse: po.statusWarehouse,
      statusLogistics: po.statusLogistics,
      statusFinal: finalOf(po),
    };
  });
};

export const listLines = async (f: PoOverviewFilters, p: Paging): Promise<{ items: LineItem[]; total: number }> => {
  const { rows, total } = await findLinePage(f, p);
  return { items: await toLineItems(rows, (l) => l.purchaseOrder), total };
};

/** One shipment with its lines (the details drawer). */
export const getShipment = async (uid: string): Promise<{ shipment: ShipmentItem; lines: LineItem[] }> => {
  const po = await findShipment(uid);
  if (!po) throw appError(ERROR_CODES.SHIPMENT_NOT_FOUND, uid);
  const [c, lines] = await Promise.all([contextFor([po]), findLinesOfShipment(uid)]);
  return { shipment: toShipmentItem(po, c), lines: await toLineItems(lines, () => po) };
};

export const getFilterOptions = (): Promise<FilterOptions> => filterOptions();

export interface TeamColumns {
  key: PoTeam;
  label: string;
  /** Position in the workflow (1 = first). */
  step: number;
  access: ColumnAccess;
  columns: readonly ColumnDef[];
}

export interface PoOverviewColumns {
  keyColumns: readonly ColumnDef[];
  systemColumns: readonly ColumnDef[];
  /** In workflow order; teams the person has no access to are left out. */
  teams: TeamColumns[];
}

/**
 * The column groups and this person's access to each. For now access follows the page access of the PO Overview
 * (editor = edit every team's columns, viewer = view); per-team access replaces this once the team roles exist
 * (design doc, section 5).
 */
export const getColumns = async (userId: number, roles: string[]): Promise<PoOverviewColumns> => {
  const page = await resolveAccess(userId, roles, PAGE.PO_OVERVIEW);
  const access: ColumnAccess = page === ACCESS_LEVEL.EDITOR ? COLUMN_ACCESS.EDIT : page === ACCESS_LEVEL.VIEWER ? COLUMN_ACCESS.VIEW : COLUMN_ACCESS.NONE;
  return {
    keyColumns: PO_KEY_COLUMNS,
    systemColumns: PO_SYSTEM_COLUMNS,
    teams: PO_TEAM_ORDER.map((key, i) => ({ key, label: PO_TEAM_LABEL[key], step: i + 1, access, columns: PO_TEAM_COLUMNS[key] }))
      .filter((t) => t.access !== COLUMN_ACCESS.NONE),
  };
};
