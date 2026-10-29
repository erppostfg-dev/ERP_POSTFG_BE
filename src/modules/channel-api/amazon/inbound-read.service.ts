import { In } from 'typeorm';
import { AppDataSource } from '../../../config/data-source';
import { AMAZON_SHIPMENT_STATUS_ORDER, ERROR_CODES, SOURCE_SYSTEM } from '../../../constants';
import {
  ChannelApiSync, InboundPlan, InboundShipment, InboundShipmentEvent, InboundShipmentLine, InboundStatusLimit, MasterChannelSku,
  MasterPurchaseOrder, PoUpload, User,
} from '../../../entities';
import { INBOUND_SYNC } from '../../../constants/inbound';
import { appError } from '../../../utils/AppError';

/*
 * What the Amazon Inbound page reads (2026-10-19): only our own tables, never Amazon. A plan's picture (shipments by
 * status, units, received %, stuck, attention) is computed here from its shipments. "Stuck" = longer in its status than
 * the limit of inbound_status_limits (the courier row when there is one, else the default row). Days in a status count
 * from when we first saw that status (Amazon gives no history; shipments of the first load count from that day).
 */

const SRC = SOURCE_SYSTEM.AMAZON_SPAPI;
const DAY_MS = 864e5;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export type UniwareState = 'none' | 'not_downloaded' | 'downloaded' | 'uploaded';

export interface ShipmentItem {
  externalId: string;
  planId: string | null;
  name: string | null;
  fcCode: string | null;
  fcCity: string | null;
  fcPincode: string | null;
  status: string;
  statusSince: string;
  daysInStatus: number;
  stuck: boolean;
  limitDays: number | null;
  skuCount: number | null;
  unitsPlanned: number | null;
  unitsReceived: number | null;
  attention: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  po: { uploadId: string; poNumber: string | null; uploadStatus: string; saleOrder: string | null; uniware: UniwareState } | null;
}

export interface PlanItem {
  planId: string;
  name: string | null;
  status: string | null;
  createdAt: string | null;
  shipFrom: string | null;
  shipFromPincode: string | null;
  planSkuCount: number | null;
  planUnits: number | null;
  shipmentCount: number;
  /** Shipments per status (Amazon order). */
  byStatus: Record<string, number>;
  /** Units per status. */
  unitsByStatus: Record<string, number>;
  unitsPlanned: number;
  unitsReceived: number;
  /** The plan asked for a different number of units than its shipments hold. */
  unitsMismatch: boolean;
  stuck: number;
  attention: number;
  /** Shipments already linked to our PO. */
  withPo: number;
  lastChangeAt: string | null;
}

const limitsMap = async () => {
  const rows = await AppDataSource.getRepository(InboundStatusLimit).findBy({ sourceSystem: SRC });
  // Default rows only for now (no courier on a shipment yet); a courier row overrides once shipments carry one.
  return new Map(rows.filter((r) => r.courierPartnerId === null).map((r) => [r.status, r.maxDays]));
};

const uniwareOf = (u: PoUpload): UniwareState => (u.uniwareUploadedAt ? 'uploaded' : u.csvDownloadedAt ? 'downloaded' : 'not_downloaded');

/** Shipments as the screens show them (plan id, stuck, PO + Uniware state). */
const toItems = async (ships: InboundShipment[]): Promise<ShipmentItem[]> => {
  const limits = await limitsMap();
  const planIds = [...new Set(ships.map((s) => s.planRowId).filter((x): x is number => x !== null))];
  const plans = planIds.length ? await AppDataSource.getRepository(InboundPlan).find({ select: ['id', 'planId'], where: { id: In(planIds) } }) : [];
  const uploadIds = ships.map((s) => s.poUploadId).filter((x): x is string => x !== null);
  const uploads = uploadIds.length ? await AppDataSource.getRepository(PoUpload).find({
    select: ['id', 'poNumber', 'status', 'poUid', 'csvDownloadedAt', 'uniwareUploadedAt'], where: { id: In(uploadIds) },
  }) : [];
  const uids = uploads.map((u) => u.poUid).filter((x): x is string => !!x);
  const pos = uids.length ? await AppDataSource.getRepository(MasterPurchaseOrder).find({ select: ['uid', 'orderNo1'], where: { uid: In(uids) } }) : [];
  const now = Date.now();
  return ships.map((s) => {
    const inStatusMs = now - s.statusSince.getTime();
    const days = Math.floor(inStatusMs / DAY_MS);
    const limit = limits.get(s.status) ?? null;
    const u = uploads.find((x) => String(x.id) === String(s.poUploadId));
    return {
      externalId: s.externalId,
      planId: plans.find((p) => p.id === s.planRowId)?.planId ?? null,
      name: s.name, fcCode: s.fcCode, fcCity: s.fcCity, fcPincode: s.fcPincode,
      status: s.status, statusSince: s.statusSince.toISOString(), daysInStatus: days,
      // Exact time against the limit (1.7 days with a 1-day limit is stuck; whole days alone hid it, 2026-10-21).
      stuck: limit !== null && inStatusMs > limit * DAY_MS, limitDays: limit,
      skuCount: s.skuCount, unitsPlanned: s.unitsPlanned, unitsReceived: s.unitsReceived,
      attention: s.attention, firstSeenAt: s.firstSeenAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(),
      po: u ? { uploadId: String(u.id), poNumber: u.poNumber, uploadStatus: u.status, saleOrder: pos.find((p) => p.uid === u.poUid)?.orderNo1 ?? null, uniware: uniwareOf(u) } : null,
    };
  });
};

const emptyCounts = () => Object.fromEntries(AMAZON_SHIPMENT_STATUS_ORDER.map((s) => [s, 0])) as Record<string, number>;

export const listPlans = async (): Promise<{ items: PlanItem[]; totals: Record<string, number> }> => {
  const plans = await AppDataSource.getRepository(InboundPlan).find({ where: { sourceSystem: SRC }, order: { createdAtChannel: 'DESC' } });
  const ships = await toItems(await AppDataSource.getRepository(InboundShipment).findBy({ sourceSystem: SRC }));
  const lastEvents: { planRowId: number; last: string }[] = await AppDataSource.getRepository(InboundShipmentEvent)
    .createQueryBuilder('e').innerJoin(InboundShipment, 's', 's.id = e.shipment_id')
    .select('s.plan_row_id', 'planRowId').addSelect('MAX(e.seen_at)', 'last').where('s.plan_row_id IS NOT NULL').groupBy('s.plan_row_id').getRawMany();
  const items = plans.map((p): PlanItem => {
    const mine = ships.filter((s) => s.planId === p.planId);
    const byStatus = emptyCounts();
    const unitsByStatus = emptyCounts();
    for (const s of mine) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      unitsByStatus[s.status] = (unitsByStatus[s.status] ?? 0) + (s.unitsPlanned ?? 0);
    }
    const unitsPlanned = mine.reduce((a, s) => a + (s.unitsPlanned ?? 0), 0);
    const last = lastEvents.find((e) => Number(e.planRowId) === p.id)?.last;
    return {
      planId: p.planId, name: p.name, status: p.status, createdAt: iso(p.createdAtChannel), shipFrom: p.shipFromName, shipFromPincode: p.shipFromPincode,
      planSkuCount: p.planSkuCount, planUnits: p.planUnits, shipmentCount: p.shipmentCount, byStatus, unitsByStatus, unitsPlanned,
      unitsReceived: mine.reduce((a, s) => a + (s.unitsReceived ?? 0), 0),
      unitsMismatch: p.planUnits !== null && mine.length > 0 && mine.length === p.shipmentCount && p.planUnits !== unitsPlanned,
      stuck: mine.filter((s) => s.stuck).length, attention: mine.filter((s) => s.attention).length, withPo: mine.filter((s) => s.po).length,
      lastChangeAt: last ? new Date(last).toISOString() : null,
    };
  });
  const totals = emptyCounts();
  for (const s of ships) totals[s.status] = (totals[s.status] ?? 0) + 1;
  return {
    items,
    totals: {
      ...totals, plans: plans.length, shipments: ships.length, stuck: ships.filter((s) => s.stuck).length, attention: ships.filter((s) => s.attention).length,
      unitsInTransit: ships.filter((s) => ['SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN'].includes(s.status)).reduce((a, s) => a + (s.unitsPlanned ?? 0), 0),
      noPlan: ships.filter((s) => !s.planId).length,
    },
  };
};

const eventsOf = async (shipmentIds: number[], limit = 500) =>
  shipmentIds.length ? (await AppDataSource.getRepository(InboundShipmentEvent).find({ where: { shipmentId: In(shipmentIds) }, order: { seenAt: 'DESC', id: 'DESC' }, take: limit })) : [];

export const getPlan = async (planId: string) => {
  const plan = await AppDataSource.getRepository(InboundPlan).findOneBy({ sourceSystem: SRC, planId });
  if (!plan) throw appError(ERROR_CODES.INBOUND_PLAN_NOT_FOUND, planId);
  const rows = await AppDataSource.getRepository(InboundShipment).find({ where: { planRowId: plan.id }, order: { fcCode: 'ASC' } });
  const ships = await toItems(rows);
  const events = await eventsOf(rows.map((r) => r.id), 300);
  return {
    plan: (await listPlans()).items.find((p) => p.planId === planId),
    shipments: ships,
    events: events.map((e) => ({ ...eventView(e), externalId: rows.find((r) => r.id === e.shipmentId)?.externalId ?? null })),
  };
};

const eventView = (e: InboundShipmentEvent) => ({
  id: e.id, kind: e.kind, oldValue: e.oldValue, newValue: e.newValue, detail: e.detail, source: e.source, seenAt: e.seenAt.toISOString(),
});

export const listShipments = async (): Promise<ShipmentItem[]> =>
  toItems(await AppDataSource.getRepository(InboundShipment).find({ where: { sourceSystem: SRC }, order: { lastSeenAt: 'DESC' } }));

export const getShipment = async (externalId: string) => {
  const row = await AppDataSource.getRepository(InboundShipment).findOneBy({ sourceSystem: SRC, externalId });
  if (!row) throw appError(ERROR_CODES.INBOUND_SHIPMENT_NOT_FOUND, externalId);
  const [item] = await toItems([row]);
  const lines = await AppDataSource.getRepository(InboundShipmentLine).find({ where: { shipmentId: row.id }, order: { sellerSku: 'ASC' } });
  // Our PEP code + name for each line: Amazon SKU master by FNSKU (master_channel_skus.channel_code).
  const fnskus = lines.map((l) => l.fnsku).filter((x): x is string => !!x);
  const master = fnskus.length ? await AppDataSource.getRepository(MasterChannelSku).find({ select: ['channelCode', 'pepCode', 'productName'], where: { channelCode: In(fnskus), isActive: true } }) : [];
  return {
    shipment: item,
    lines: lines.map((l) => {
      const m = master.find((x) => x.channelCode === l.fnsku);
      return { sellerSku: l.sellerSku, fnsku: l.fnsku, pepCode: m?.pepCode ?? null, productName: m?.productName ?? null, qtyPlanned: l.qtyPlanned, qtyReceived: l.qtyReceived };
    }),
    events: (await eventsOf([row.id])).map(eventView),
  };
};

export const listLimits = async () => {
  const rows = await AppDataSource.getRepository(InboundStatusLimit).find({ where: { sourceSystem: SRC }, relations: { courierPartner: true }, order: { status: 'ASC' } });
  const userIds = rows.map((r) => r.updatedBy).filter((x): x is number => x !== null);
  const users = userIds.length ? await AppDataSource.getRepository(User).find({ select: ['id', 'name'], where: { id: In(userIds) } }) : [];
  return rows.map((r) => ({
    id: r.id, status: r.status, courier: r.courierPartner?.code ?? null, maxDays: r.maxDays,
    updatedBy: users.find((u) => u.id === r.updatedBy)?.name ?? null, updatedAt: iso(r.updatedAt),
  }));
};

export const updateLimit = async (id: number, maxDays: number, by: number) => {
  const repo = AppDataSource.getRepository(InboundStatusLimit);
  const row = await repo.findOneBy({ id, sourceSystem: SRC });
  if (!row) throw appError(ERROR_CODES.INBOUND_LIMIT_NOT_FOUND, String(id));
  await repo.update({ id }, { maxDays, updatedBy: by });
  return (await listLimits()).find((l) => l.id === id);
};

/** The tracking run's health (last run, last success, last error, what it did). */
export const syncState = async () => {
  const row = await AppDataSource.getRepository(ChannelApiSync).findOneBy({ connector: INBOUND_SYNC.CONNECTOR_KEY });
  return row ? { syncedUntil: iso(row.syncedUntil), lastRunAt: iso(row.lastRunAt), lastSuccessAt: iso(row.lastSuccessAt), failures: row.failures, lastError: row.lastError, lastResult: row.lastResult } : null;
};
