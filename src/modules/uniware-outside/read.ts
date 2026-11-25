import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { TABLES, UNIWARE_OUTSIDE_ACTIONS_FOR, UNIWARE_OUTSIDE_STATE, UniwareOutsideAction, UniwareOutsideKind, UPLOAD_STATUS } from '../../constants';
import { UniwareOutsideOrder } from '../../entities';
import { kindOf } from './match';

/*
 * Read side of the outside-Uniware findings (2026-11-25): what the PO Review lists show on a row, and the counts per tab.
 * Its own file (only the DB): po-review.service reads it without importing the actions (no import cycle).
 */

export interface OutsideOnRow {
  id: string;
  code: string;
  channel: string;
  status: string | null;
  createdAt: string | null;
  firstSeenAt: string;
  kind: UniwareOutsideKind;
  /** What the person may do on it here. */
  actions: readonly UniwareOutsideAction[];
  /** Other open findings on the same PO (several Uniware codes). */
  more: number;
}

/**
 * The newest open finding of each upload that still warrants one (In Review, Rejected, Processed not uploaded): one
 * indexed read for a page of uploads.
 */
export const outsideForUploads = async (uploads: { id: string; status: string; uniwareUploadedAt: Date | null }[]): Promise<Map<string, OutsideOnRow>> => {
  const out = new Map<string, OutsideOnRow>();
  const live = uploads.map((u) => ({ id: String(u.id), kind: kindOf({ status: u.status, uploaded: !!u.uniwareUploadedAt }) })).filter((u) => u.kind);
  if (!live.length) return out;
  const rows = await AppDataSource.getRepository(UniwareOutsideOrder).find({
    select: { id: true, uniwareCode: true, uniwareChannel: true, uniwareStatus: true, uniwareCreatedAt: true, uploadId: true, firstSeenAt: true },
    where: { uploadId: In(live.map((u) => u.id)), state: UNIWARE_OUTSIDE_STATE.OPEN },
    order: { id: 'DESC' },
  });
  const kindById = new Map(live.map((u) => [u.id, u.kind!] as const));
  for (const r of rows) {
    const id = String(r.uploadId);
    const had = out.get(id);
    if (had) { had.more++; continue; }
    const kind = kindById.get(id)!;
    out.set(id, {
      id: String(r.id), code: r.uniwareCode, channel: r.uniwareChannel, status: r.uniwareStatus,
      createdAt: r.uniwareCreatedAt ? r.uniwareCreatedAt.toISOString() : null, firstSeenAt: r.firstSeenAt.toISOString(),
      kind, actions: UNIWARE_OUTSIDE_ACTIONS_FOR[kind], more: 0,
    });
  }
  return out;
};

/** POs with an open finding, per tab (the same rule as the rows): { review, rejected, processed }. One query. */
export const outsideCounts = async (): Promise<Record<UniwareOutsideKind, number>> => {
  const rows = await AppDataSource.query<{ k: UniwareOutsideKind; n: string }[]>(
    `SELECT CASE u.status WHEN ? THEN 'review' WHEN ? THEN 'rejected' ELSE 'processed' END AS k, COUNT(DISTINCT u.id) AS n
       FROM ${TABLES.UNIWARE_OUTSIDE_ORDERS} o JOIN ${TABLES.PO_UPLOADS} u ON u.id = o.upload_id
      WHERE o.state = ? AND (u.status IN (?, ?) OR (u.status = ? AND u.uniware_uploaded_at IS NULL))
      GROUP BY k`,
    [UPLOAD_STATUS.NEEDS_REVIEW, UPLOAD_STATUS.REJECTED, UNIWARE_OUTSIDE_STATE.OPEN, UPLOAD_STATUS.NEEDS_REVIEW, UPLOAD_STATUS.REJECTED, UPLOAD_STATUS.COMPLETED],
  );
  const counts: Record<UniwareOutsideKind, number> = { review: 0, rejected: 0, processed: 0 };
  for (const r of rows) counts[r.k] = Number(r.n);
  return counts;
};
