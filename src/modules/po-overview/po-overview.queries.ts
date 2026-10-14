import { In, SelectQueryBuilder } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { NOT_ASSIGNED, NOT_ASSIGNED_DATE, NotAssignedDate, STATUS_STAGE, STATUS_WHEN_EMPTY, TABLES } from '../../constants';
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
  if (f.q) qb.andWhere('(po.poNumber LIKE :q OR CAST(po.uid AS CHAR) LIKE :q)', { q: `%${f.q}%` });
  if (f.docketNo) qb.andWhere('(po.firstDocketNo LIKE :docket OR po.secondDocketNo LIKE :docket OR po.thirdDocketNo LIKE :docket)', { docket: `%${f.docketNo}%` });
  if (f.skuCode && lineAlias) qb.andWhere(`${lineAlias}.skuCode LIKE :sku`, { sku: `%${f.skuCode}%` });

  whereIn(qb, 'po.channel', f.channel, 'channel');
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

/** One page of shipments, newest first, and how many match. */
export const findShipmentPage = async (f: PoOverviewFilters, p: Paging): Promise<{ rows: MasterPurchaseOrder[]; total: number }> => {
  const qb = AppDataSource.getRepository(MasterPurchaseOrder).createQueryBuilder('po');
  await applyFilters(qb, f);
  const [rows, total] = await qb.orderBy('po.uid', 'DESC').skip((p.page - 1) * p.pageSize).take(p.pageSize).getManyAndCount();
  return { rows, total };
};

export const findShipment = (uid: string): Promise<MasterPurchaseOrder | null> =>
  AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });

/** One page of lines with their shipment, newest shipment first, lines in their order. */
export const findLinePage = async (f: PoOverviewFilters, p: Paging): Promise<{ rows: DetailsPurchaseOrder[]; total: number }> => {
  const qb = AppDataSource.getRepository(DetailsPurchaseOrder).createQueryBuilder('d').innerJoinAndSelect('d.purchaseOrder', 'po');
  await applyFilters(qb, f, 'd');
  const [rows, total] = await qb.orderBy('po.uid', 'DESC').addOrderBy('d.id', 'ASC').offset((p.page - 1) * p.pageSize).limit(p.pageSize).getManyAndCount();
  return { rows, total };
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
    distinct(`SELECT DISTINCT brandName v FROM ${TABLES.DETAILS_PURCHASE_ORDERS} ORDER BY v`),
    distinct(`SELECT DISTINCT channel v FROM ${TABLES.MASTER_PURCHASE_ORDERS} ORDER BY v`),
    distinct(`SELECT DISTINCT location v FROM ${TABLES.MASTER_PURCHASE_ORDERS} ORDER BY v`),
    AppDataSource.getRepository(MasterFacility).find({ select: ['code'], where: { isActive: true }, order: { code: 'ASC' } }),
    AppDataSource.getRepository(MasterCourierPartner).find({ select: ['code'], where: { isActive: true }, order: { code: 'ASC' } }),
    finalStatusRows(),
  ]);
  return {
    brand,
    channel,
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
