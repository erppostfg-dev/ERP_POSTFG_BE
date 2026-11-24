import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { BULK_EVENT, BULK_ORDER_STATUS, BULK_TRACKING } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { BulkOrder, BulkOrderReceiver } from '../../entities';
import { log } from '../../utils/logger';
import type { SoDetail } from '../po-uniware-sync/sale-order';
import { addEvent } from './bulk-orders.service';

/*
 * Courier tracking of bulk orders (Bulk Orders Portal v2 piece 4, 2026-11-24; constants BULK_TRACKING). READ-ONLY on
 * Uniware: the channel PO sync already reads every uploaded sale order (saleorder/get); for the sale orders that belong
 * to a bulk order, that same answer also fills the order's tracking (AWB, courier, courier status, link, dispatched /
 * delivered dates, invoice) and moves its status Order placed -> Dispatched -> Delivered (never back, never by hand).
 * Load: one query per sync pass to find which read POs are bulk orders; one UPDATE (+ a timeline row when the status
 * moves) only when something changed.
 */

export interface BulkTracking {
  awb: string | null; courier: string | null; courierStatus: string | null; trackingLink: string | null;
  dispatchedAt: Date | null; deliveredAt: Date | null; invoiceCode: string | null;
  /** The status the shipments say (null = not dispatched yet). */
  status: string | null;
}

const joined = (vals: (string | null)[]): string | null => {
  const out = [...new Set(vals.filter((v): v is string => !!v && v.trim() !== ''))];
  return out.length ? out.join(', ').slice(0, BULK_TRACKING.TEXT_MAX) : null;
};
const earliest = (ds: (Date | null)[]): Date | null => ds.filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
const latest = (ds: (Date | null)[]): Date | null => ds.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

/** What Uniware's shipping packages say (cancelled packages ignored; several packages = joined values). */
export const trackingOf = (so: SoDetail): BulkTracking => {
  const live = so.packages.filter((p) => !BULK_TRACKING.CANCELLED.includes(p.status));
  const delivered = live.length > 0 && live.every((p) => BULK_TRACKING.DELIVERED.includes(p.status) || p.deliveredAt !== null);
  const dispatched = live.some((p) => BULK_TRACKING.DISPATCHED.includes(p.status) || BULK_TRACKING.DELIVERED.includes(p.status) || p.dispatchedAt !== null);
  return {
    awb: joined(live.map((p) => p.awb)),
    courier: joined(live.map((p) => p.courier)),
    courierStatus: joined(live.map((p) => p.courierStatus)),
    trackingLink: live.map((p) => p.trackingLink).find((l) => !!l) ?? null,
    dispatchedAt: earliest(live.map((p) => p.dispatchedAt)),
    deliveredAt: delivered ? latest(live.map((p) => p.deliveredAt)) : null,
    invoiceCode: joined(live.map((p) => p.invoiceDisplayCode ?? p.invoiceCode)),
    status: delivered ? BULK_ORDER_STATUS.DELIVERED : dispatched ? BULK_ORDER_STATUS.DISPATCHED : null,
  };
};

/** The bulk orders (id + what tracking may change) of the POs a sync pass reads: one query. */
export const bulkOrdersOfPos = async (poUids: string[]): Promise<Map<string, BulkOrder>> => {
  if (!poUids.length) return new Map();
  const rows = await AppDataSource.getRepository(BulkOrder).find({
    select: { id: true, poUid: true, poNumber: true, status: true, awb: true, courier: true, courierStatus: true, trackingLink: true, dispatchedAt: true, deliveredAt: true, invoiceCode: true },
    where: { poUid: In(poUids), status: In([...BULK_TRACKING.TRACKED_STATUSES]) },
  });
  return new Map(rows.map((r) => [String(r.poUid), r]));
};

const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime?.() === (b as Date | null)?.getTime?.() : (a ?? null) === (b ?? null));
const RANK: Record<string, number> = { [BULK_ORDER_STATUS.PROCESSING]: 0, [BULK_ORDER_STATUS.DISPATCHED]: 1, [BULK_ORDER_STATUS.DELIVERED]: 2 };

/** Saves one order's tracking when it changed; the status only moves forward. Returns whether anything changed. */
export const applyBulkTracking = async (o: BulkOrder, so: SoDetail, now = new Date()): Promise<boolean> => {
  const t = trackingOf(so);
  const fields = { awb: t.awb, courier: t.courier, courierStatus: t.courierStatus, trackingLink: t.trackingLink, dispatchedAt: t.dispatchedAt, deliveredAt: t.deliveredAt, invoiceCode: t.invoiceCode };
  const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => !same(o[k], fields[k]));
  const nextStatus = t.status && (RANK[t.status] ?? 0) > (RANK[o.status] ?? 0) ? t.status : null;
  if (!changed.length && !nextStatus) {
    await AppDataSource.getRepository(BulkOrder).update({ id: o.id }, { trackingCheckedAt: now });
    return false;
  }
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(BulkOrder).update({ id: o.id }, { ...fields, trackingCheckedAt: now, ...(nextStatus ? { status: nextStatus, updatedAt: now } : {}) });
    // one sale order for every receiver: they show the same tracking (Uniware joins several shipments' AWBs)
    await m.getRepository(BulkOrderReceiver).update({ orderId: String(o.id) }, { ...fields, trackingCheckedAt: now, ...(nextStatus ? { receiverStatus: nextStatus } : {}) });
    if (nextStatus) await addEvent(m, String(o.id), BULK_EVENT.TRACKING, BULK_TRACKING.SYSTEM_USER, null, { status: [o.status, nextStatus], awb: t.awb, courier: t.courier });
  });
  if (nextStatus) log.info(LOG_SOURCE.APP, `[bulk-orders] ${o.poNumber} ${nextStatus} (Uniware: AWB ${t.awb ?? '-'}, ${t.courier ?? '-'})`);
  return true;
};
