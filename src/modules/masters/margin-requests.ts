import { EntityManager, In } from 'typeorm';
import {
  ERROR_CODES, MARGIN_APPROVAL, MARGIN_REQUEST_KIND, MARGIN_REQUEST_OPEN, MARGIN_REQUEST_SOURCE, MARGIN_REQUEST_STATUS, MarginRequestSource,
} from '../../constants';
import { MarginChangeRequest } from '../../entities';
import { appError } from '../../utils/AppError';

/*
 * Saving a margin change as a REQUEST (2026-11-06, two-layer approval; constants/margin-approval.ts), inside the
 * caller's transaction: Masters Edit (margin % / rate after margin of a channel SKU), Masters Add (a new channel SKU
 * row) and the price check's "update master" (rate). One open request per channel SKU row / per new channel code at a
 * time (409 MARGIN_REQUEST_PENDING). Deciding: margin-approval.service.ts.
 */

/** A checked new channel SKU row (kept as a margin request's payload until both approvals). */
export interface NewChannelSku {
  channelId: number; channelName: string; channelCode: string; pepCode: string; pepSkuId: number;
  productName: string | null; brand: string | null; mrp: number | null; margin: number; rateAfterMargin: number | null; eanCode: string | null;
}

const clip = (s: string | null | undefined): string | null => (s ? s.slice(0, MARGIN_APPROVAL.REMARK_MAX) : null);
const dec = (v: number | null | undefined, places: number): string | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v.toFixed(places));

/** An edit of a channel SKU's margin / rate (values as stored: margin a fraction of MRP). Returns the request id. */
export const requestMarginEdit = async (
  m: EntityManager,
  row: { id: string; channelId: number; channelName: string; channelCode: string; pepCode: string },
  change: { oldMargin?: number | null; newMargin?: number | null; oldRate?: number | null; newRate?: number | null },
  by: { id: number }, remark: string | null, source: MarginRequestSource = MARGIN_REQUEST_SOURCE.MASTERS,
): Promise<string> => {
  const repo = m.getRepository(MarginChangeRequest);
  const open = await repo.findOne({ where: { channelSkuId: row.id, status: In([...MARGIN_REQUEST_OPEN]) }, lock: { mode: 'pessimistic_write' } });
  // from a PO approval (price check): the waiting request is kept and the PO is not blocked; from Masters: refused
  if (open && source === MARGIN_REQUEST_SOURCE.PRICE_CHECK) return String(open.id);
  if (open) throw appError(ERROR_CODES.MARGIN_REQUEST_PENDING, `${row.channelName} ${row.channelCode}`, String(open.id));
  const margin = 'newMargin' in change;
  const rate = 'newRate' in change;
  const r = await repo.insert({
    kind: MARGIN_REQUEST_KIND.EDIT, source, status: MARGIN_REQUEST_STATUS.PENDING_L1, channelSkuId: row.id, channelId: row.channelId,
    channelName: row.channelName, channelCode: row.channelCode, pepCode: row.pepCode,
    oldMargin: margin ? dec(change.oldMargin, 4) : null, newMargin: margin ? dec(change.newMargin, 4) : null,
    oldRate: rate ? dec(change.oldRate, 2) : null, newRate: rate ? dec(change.newRate, 2) : null,
    remark: clip(remark), requestedBy: by.id,
  });
  return String(r.identifiers[0]?.id ?? '');
};

/** A new channel SKU row (already checked): added when both layers approve. Returns the request id. */
export const requestChannelSkuAdd = async (m: EntityManager, v: NewChannelSku, by: { id: number }, remark: string | null): Promise<string> => {
  const repo = m.getRepository(MarginChangeRequest);
  const open = await repo.createQueryBuilder('r').setLock('pessimistic_write')
    .where('r.kind = :kind AND r.channelId = :ch AND LOWER(TRIM(r.channelCode)) = LOWER(:code) AND r.status IN (:...open)',
      { kind: MARGIN_REQUEST_KIND.ADD, ch: v.channelId, code: v.channelCode.trim(), open: [...MARGIN_REQUEST_OPEN] })
    .getOne();
  if (open) throw appError(ERROR_CODES.MARGIN_REQUEST_PENDING, `${v.channelName} ${v.channelCode}`, String(open.id));
  const saved = await repo.save(repo.create({
    kind: MARGIN_REQUEST_KIND.ADD, source: MARGIN_REQUEST_SOURCE.MASTERS, status: MARGIN_REQUEST_STATUS.PENDING_L1, channelSkuId: null,
    channelId: v.channelId, channelName: v.channelName, channelCode: v.channelCode, pepCode: v.pepCode,
    oldMargin: null, newMargin: dec(v.margin, 4), oldRate: null, newRate: dec(v.rateAfterMargin, 2),
    payload: { ...v }, remark: clip(remark), requestedBy: by.id,
  }));
  return String(saved.id);
};
