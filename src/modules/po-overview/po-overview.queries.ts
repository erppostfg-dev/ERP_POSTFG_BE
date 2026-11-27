import { In, IsNull, SelectQueryBuilder } from 'typeorm';
import { cached } from '../cache/cache.service';
import { CACHE_NS } from '../../constants/cache';
import { AppDataSource } from '../../config/data-source';
import { NOT_ASSIGNED, NOT_ASSIGNED_DATE, NotAssignedDate, PO_GROUPS, PoGroup, STATUS_STAGE, STATUS_WHEN_EMPTY, TABLES } from '../../constants';
import {
  DetailsChannel,
  DetailsPurchaseOrder,
  MasterCourierPartner,
  MasterCourierRate,
  MasterFacility,
  MasterFinalStatusMap,
  MasterPurchaseOrder,
  MasterShipmentStatus,
  MasterSku,
} from '../../entities';

/*
 * Every DB read of the PO Overview, one named function each (plain filters in, plain rows out), so a cache or query
 * logging can later wrap these functions without touching the routes or the service. All values go in as parameters.
 * Per request: one paged query (+ its count), one grouped query for the line sums, and a few lookups by the ids of
 * that page (no query per row).
 */

export interface PoOverviewFilters {
  /** PO number or shipment uid, part of it. */
  q?: string;
  /** Lines only: SKU code, part of it. */
  skuCode?: string;
  /** Any of the three docket numbers, part of it. */
  docketNo?: string;
  brand: string[];
  channel: string[];
  /** PO groups (Channel, D2C, Marketing, ...; constants/po-group.ts); missing = all. */
  poGroup?: PoGroup[];
  /** master_facilities codes. */
  facility: string[];
  location: string[];
  statusPlanning: string[];
  statusWarehouse: string[];
  statusLogistics: string[];
  statusFinal: string[];
  /** master_courier_partners codes, any of the three legs. */
  transporter: string[];
  notAssigned: NotAssignedDate[];
  poDateFrom?: string;
  poDateTo?: string;
  workingDateFrom?: string;
  workingDateTo?: string;
  dispatchDateFrom?: string;
  dispatchDateTo?: string;
  appointmentDateFrom?: string;
  appointmentDateTo?: string;
}

export interface Paging {
  page: number;
  pageSize: number;
}

/** A stage status as the final-status lookup sees it: empty = STATUS_WHEN_EMPTY. */
const stageSql = (col: string) => `COALESCE(NULLIF(TRIM(${col}), ''), '${STATUS_WHEN_EMPTY}')`;
const CURRENT_APPOINTMENT_SQL = 'COALESCE(po.currentAppointmentDate, po.firstAppointmentDateCOPT)';

/** `col IN (values)`, plus empty rows when NOT_ASSIGNED is picked. */
const whereIn = <T extends object>(qb: SelectQueryBuilder<T>, col: string, values: string[], key: string, inSql?: (p: string) => string) => {
  if (!values.length) return;
  const real = values.filter((v) => v !== NOT_ASSIGNED);
  const parts: string[] = [];
  if (real.length) parts.push(inSql ? inSql(`:...${key}`) : `${col} IN (:...${key})`);
  if (values.includes(NOT_ASSIGNED)) parts.push(`(${col} IS NULL OR ${col} = '')`);
  qb.andWhere(`(${parts.join(' OR ')})`, { [key]: real });
};

const range = <T extends object>(qb: SelectQueryBuilder<T>, sql: string, from: string | undefined, to: string | undefined, key: string) => {
  if (from) qb.andWhere(`${sql} >= :${key}From`, { [`${key}From`]: from });
  if (to) qb.andWhere(`${sql} <= :${key}To`, { [`${key}To`]: to });
};

/** The shipment filters on alias `po` (and `d` for a line-level brand when `lineAlias` is given). */
const applyFilters = async <T extends object>(qb: SelectQueryBuilder<T>, f: PoOverviewFilters, lineAlias?: string): Promise<void> => {
  // Only POs whose sale order CSV was marked uploaded into Uniware (user, 2026-10-19); the rest wait on Processed.
  // Imported POs (PEPIMS, 2026-11-16) have no CSV of ours: they are shown as they are.
  qb.andWhere(`(po.importedFrom IS NOT NULL OR EXISTS (SELECT 1 FROM ${TABLES.PO_UPLOADS} hu WHERE hu.po_uid = po.uid AND hu.uniware_uploaded_at IS NOT NULL))`);
  // Never a D2C internal transfer (user, 2026-11-02: transfers are not shown on PO Overview).
  qb.andWhere('po.transferCode IS NULL');
  if (f.q) qb.andWhere('(po.poNumber LIKE :q OR CAST(po.uid AS CHAR) LIKE :q)', { q: `%${f.q}%` });
  if (f.docketNo) qb.andWhere('(po.firstDocketNo LIKE :docket OR po.secondDocketNo LIKE :docket OR po.thirdDocketNo LIKE :docket)', { docket: `%${f.docketNo}%` });
  if (f.skuCode && lineAlias) qb.andWhere(`${lineAlias}.skuCode LIKE :sku`, { sku: `%${f.skuCode}%` });

  whereIn(qb, 'po.channel', f.channel, 'channel');
  if (f.poGroup?.length) qb.andWhere('po.poGroup IN (:...poGroup)', { poGroup: f.poGroup });
  whereIn(qb, 'po.location', f.location, 'location');
  whereIn(qb, 'po.statusPlanning', f.statusPlanning, 'stPlanning');
  whereIn(qb, 'po.statusWarehouse', f.statusWarehouse, 'stWarehouse');
  whereIn(qb, 'po.statusLogistics', f.statusLogistics, 'stLogistics');
  // Facility and transporter by their master rows (links), not by the free text.
  whereIn(qb, 'po.facilityId', f.facility, 'facility', (p) => `po.facilityId IN (SELECT id FROM ${TABLES.MASTER_FACILITIES} WHERE code IN (${p}))`);
  if (f.transporter.length) {
    const real = f.transporter.filter((v) => v !== NOT_ASSIGNED);
    const ids = `(SELECT id FROM ${TABLES.MASTER_COURIER_PARTNERS} WHERE code IN (:...transporter))`;
    const parts = real.length ? [`po.firstTransporterId IN ${ids}`, `po.secondTransporterId IN ${ids}`, `po.thirdTransporterId IN ${ids}`] : [];
    if (f.transporter.includes(NOT_ASSIGNED)) parts.push('(po.firstTransporterId IS NULL AND po.secondTransporterId IS NULL AND po.thirdTransporterId IS NULL)');
    qb.andWhere(`(${parts.join(' OR ')})`, { transporter: real });
  }
  // Brand: a line's brand (PEPIMS filters shipments by the brands of their lines).
  if (lineAlias) whereIn(qb, `${lineAlias}.brandName`, f.brand, 'brand');
  else whereIn(qb, 'po.brandName', f.brand, 'brand', (p) => `EXISTS (SELECT 1 FROM ${TABLES.DETAILS_PURCHASE_ORDERS} b WHERE b.shipmentOrderId = po.uid AND b.brandName IN (${p}))`);

  // Final status: computed from the three stages, so it is turned into the stage combinations that give it.
  if (f.statusFinal.length) {
    const map = await finalStatusRows();
    const wanted = f.statusFinal.filter((v) => v !== NOT_ASSIGNED).map((v) => v.toLowerCase());
    const combos = map.filter((m) => wanted.includes(m.statusFinal.toLowerCase()));
    const stages = `(${stageSql('po.statusPlanning')}, ${stageSql('po.statusWarehouse')}, ${stageSql('po.statusLogistics')})`;
    const params: Record<string, string> = {};
    const tuple = (list: MasterFinalStatusMap[], prefix: string) => list.map((m, i) => {
      Object.assign(params, { [`${prefix}p${i}`]: m.statusPlanning, [`${prefix}w${i}`]: m.statusWarehouse, [`${prefix}l${i}`]: m.statusLogistics });
      return `(:${prefix}p${i}, :${prefix}w${i}, :${prefix}l${i})`;
    }).join(', ');
    const parts: string[] = [];
    if (combos.length) parts.push(`${stages} IN (${tuple(combos, 'fs')})`);
    if (f.statusFinal.includes(NOT_ASSIGNED)) parts.push(map.length ? `${stages} NOT IN (${tuple(map, 'nm')})` : '1 = 1');
    qb.andWhere(parts.length ? `(${parts.join(' OR ')})` : '1 = 0', params);
  }

  range(qb, 'po.poDate', f.poDateFrom, f.poDateTo, 'poDate');
  range(qb, 'po.workingDatePlanner', f.workingDateFrom, f.workingDateTo, 'workingDate');
  range(qb, 'po.dispatchDate', f.dispatchDateFrom, f.dispatchDateTo, 'dispatchDate');
  range(qb, CURRENT_APPOINTMENT_SQL, f.appointmentDateFrom, f.appointmentDateTo, 'apptDate');

  for (const d of f.notAssigned) {
    if (d === NOT_ASSIGNED_DATE.WORKING_DATE) qb.andWhere('po.workingDatePlanner IS NULL');
    if (d === NOT_ASSIGNED_DATE.DISPATCH_DATE) qb.andWhere('po.dispatchDate IS NULL');
    if (d === NOT_ASSIGNED_DATE.RTS_DATE) qb.andWhere('po.rtsDate IS NULL');
    if (d === NOT_ASSIGNED_DATE.APPOINTMENT_DATE) qb.andWhere(`${CURRENT_APPOINTMENT_SQL} IS NULL`);
  }
};

/*
 * List totals (2026-11-27, prod jam: every page load counted every matching row again). A total is kept per filter for
 * LIST_COUNT_SECONDS and dropped when any PO changes (po-overview.live flush / a new PO), so pages stay right and the
 * count runs once per change instead of once per person per refresh.
 */
const LIST_COUNT_SECONDS = 60;
const countKey = (kind: string, f: PoOverviewFilters) => `${kind}:${JSON.stringify(f)}`;

/** One page of shipments, newest first, and how many match. */
export const findShipmentPage = async (f: PoOverviewFilters, p: Paging): Promise<{ rows: MasterPurchaseOrder[]; total: number }> => {
  const qb = AppDataSource.getRepository(MasterPurchaseOrder).createQueryBuilder('po');
  await applyFilters(qb, f);
  const [rows, total] = await Promise.all([
    qb.clone().orderBy('po.uid', 'DESC').skip((p.page - 1) * p.pageSize).take(p.pageSize).getMany(),
    cached(CACHE_NS.PO_OVERVIEW_COUNTS, countKey('shipments', f), () => qb.clone().getCount(), LIST_COUNT_SECONDS),
  ]);
  return { rows, total };
};

/** A channel PO by uid; a D2C internal transfer is not found here (not on PO Overview, 2026-11-03). */
export const findShipment = (uid: string): Promise<MasterPurchaseOrder | null> =>
  AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid, transferCode: IsNull() });

/**
 * One page of lines with their shipment, newest shipment first, lines in their order (2026-11-27, prod jam fix).
 * Was: every line joined with its PO, all columns of both, sorted as a whole (temporary table + filesort over 320K prod
 * lines, 4-12 s, 30 s when several people loaded it at once). Now two small steps:
 *   1. only the page's line ids: the lines are walked newest PO first through idx_details_po_ship_desc
 *      (shipmentOrderId DESC, id ASC = the page order, no sort), each joined to its PO by key for the filters,
 *      stopping at the page (STRAIGHT_JOIN keeps lines first so the index order is used);
 *   2. the full rows of just those ids. The total comes from the cache (findShipmentPage's note).
 */
export const findLinePage = async (f: PoOverviewFilters, p: Paging): Promise<{ rows: DetailsPurchaseOrder[]; total: number }> => {
  const repo = AppDataSource.getRepository(DetailsPurchaseOrder);
  const base = repo.createQueryBuilder('d').innerJoin('d.purchaseOrder', 'po');
  await applyFilters(base, f, 'd');
  const pageQb = base.clone().select('d.id', 'id').orderBy('d.shipmentOrderId', 'DESC').addOrderBy('d.id', 'ASC')
    .offset((p.page - 1) * p.pageSize).limit(p.pageSize);
  const [sql, params] = pageQb.getQueryAndParameters();
  const [idRows, total] = await Promise.all([
    AppDataSource.query<{ id: string | number }[]>(sql.replace(/^SELECT /, 'SELECT STRAIGHT_JOIN '), params),
    cached(CACHE_NS.PO_OVERVIEW_COUNTS, countKey('lines', f), () => base.clone().getCount(), LIST_COUNT_SECONDS),
  ]);
  const ids = idRows.map((r) => String(r.id));
  if (!ids.length) return { rows: [], total };
  const found = await repo.find({ where: { id: In(ids) }, relations: { purchaseOrder: true } });
  const at = new Map(ids.map((id, i) => [id, i]));
  return { rows: found.sort((a, b) => (at.get(String(a.id)) ?? 0) - (at.get(String(b.id)) ?? 0)), total };
};

export const findLinesOfShipment = (uid: string): Promise<DetailsPurchaseOrder[]> =>
  AppDataSource.getRepository(DetailsPurchaseOrder).find({ where: { shipmentOrderId: uid }, order: { id: 'ASC' } });

export interface LineTotals {
  lines: number;
  updatedQty: number;
  updatedGmv: number;
  updatedPoValue: number;
}

/** Line sums per shipment (an updated value falls back to the original), one grouped query for the page. */
export const lineTotals = async (uids: string[]): Promise<Map<string, LineTotals>> => {
  if (!uids.length) return new Map();
  const rows = await AppDataSource.getRepository(DetailsPurchaseOrder)
    .createQueryBuilder('d')
    .select('d.shipmentOrderId', 'uid')
    .addSelect('COUNT(*)', 'lines')
    .addSelect('SUM(COALESCE(d.updatedQty, d.qty, 0))', 'updatedQty')
    .addSelect('SUM(COALESCE(d.updatedGmv, d.gmv, 0))', 'updatedGmv')
    .addSelect('SUM(COALESCE(d.updatedPoValue, d.poValue, 0))', 'updatedPoValue')
    .where('d.shipmentOrderId IN (:...uids)', { uids })
    .groupBy('d.shipmentOrderId')
    .getRawMany<{ uid: string; lines: string; updatedQty: string; updatedGmv: string; updatedPoValue: string }>();
  return new Map(rows.map((r) => [String(r.uid), {
    lines: Number(r.lines),
    updatedQty: Number(r.updatedQty),
    updatedGmv: Math.round(Number(r.updatedGmv) * 100) / 100,
    updatedPoValue: Math.round(Number(r.updatedPoValue) * 100) / 100,
  }]));
};

export const finalStatusRows = (): Promise<MasterFinalStatusMap[]> =>
  AppDataSource.getRepository(MasterFinalStatusMap).find({ where: { isActive: true }, order: { id: 'ASC' } });

export const facilitiesByIds = (ids: number[]): Promise<MasterFacility[]> =>
  ids.length ? AppDataSource.getRepository(MasterFacility).findBy({ id: In(ids) }) : Promise.resolve([]);

export const partnersByIds = (ids: number[]): Promise<MasterCourierPartner[]> =>
  ids.length ? AppDataSource.getRepository(MasterCourierPartner).findBy({ id: In(ids) }) : Promise.resolve([]);

export const ratesOfPartners = (ids: number[]): Promise<MasterCourierRate[]> =>
  ids.length ? AppDataSource.getRepository(MasterCourierRate).findBy({ courierPartnerId: In(ids), isActive: true }) : Promise.resolve([]);

export const locationsByIds = (ids: string[]): Promise<DetailsChannel[]> =>
  ids.length
    ? AppDataSource.getRepository(DetailsChannel).find({ select: ['id', 'dropLocation', 'appointmentChannelType', 'appointmentChannel'], where: { id: In(ids) } })
    : Promise.resolve([]);

/** master_skus weight per pep_code. */
export const skuWeights = async (codes: string[]): Promise<Map<string, number | null>> => {
  if (!codes.length) return new Map();
  const rows = await AppDataSource.getRepository(MasterSku).find({ select: ['pepCode', 'weightG'], where: { pepCode: In(codes) } });
  return new Map(rows.map((r) => [r.pepCode.toLowerCase(), r.weightG]));
};

export interface FilterOptions {
  brand: string[];
  channel: string[];
  poGroup: PoGroup[];
  facility: string[];
  location: string[];
  statusPlanning: string[];
  statusWarehouse: string[];
  statusLogistics: string[];
  statusFinal: string[];
  transporter: string[];
  /** The value that picks empty fields in any list filter. */
  notAssigned: string;
}

const distinct = async (sql: string): Promise<string[]> =>
  ((await AppDataSource.query(sql)) as { v: string | null }[]).map((r) => r.v).filter((v): v is string => !!v && !!v.trim());

/** Dropdown values: from the masters (facilities, statuses, transporters) and from our POs (channel, location, brand). */
export const filterOptions = async (): Promise<FilterOptions> => {
  const statuses = await AppDataSource.getRepository(MasterShipmentStatus).find({ where: { isActive: true }, order: { stage: 'ASC', sortOrder: 'ASC' } });
  const ofStage = (s: string) => statuses.filter((x) => x.stage === s).map((x) => x.value);
  const [brand, channel, location, facilities, partners, finals] = await Promise.all([
    // channel POs only: D2C internal transfers (transferCode NOT NULL) are not on PO Overview
    distinct(`SELECT DISTINCT d.brandName v FROM ${TABLES.DETAILS_PURCHASE_ORDERS} d JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = d.shipmentOrderId WHERE p.transferCode IS NULL ORDER BY v`),
    distinct(`SELECT DISTINCT channel v FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE transferCode IS NULL ORDER BY v`),
    distinct(`SELECT DISTINCT location v FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE transferCode IS NULL ORDER BY v`),
    AppDataSource.getRepository(MasterFacility).find({ select: ['code'], where: { isActive: true }, order: { code: 'ASC' } }),
    AppDataSource.getRepository(MasterCourierPartner).find({ select: ['code'], where: { isActive: true }, order: { code: 'ASC' } }),
    finalStatusRows(),
  ]);
  return {
    brand,
    channel,
    poGroup: [...PO_GROUPS],
    facility: facilities.map((x) => x.code),
    location,
    statusPlanning: ofStage(STATUS_STAGE.PLANNING),
    statusWarehouse: ofStage(STATUS_STAGE.WAREHOUSE),
    statusLogistics: ofStage(STATUS_STAGE.LOGISTICS),
    statusFinal: [...new Set(finals.map((m) => m.statusFinal))],
    transporter: partners.map((x) => x.code),
    notAssigned: NOT_ASSIGNED,
  };
};
