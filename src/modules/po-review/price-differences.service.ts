import crypto from 'crypto';
import { In, IsNull } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, IST_OFFSET_MS, PRICE_DIFF_EMAIL, PRICE_DIFFS, TABLES } from '../../constants';
import { PoPriceDifference } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { LOG_SOURCE } from '../../constants/logging';
import { bumpReview } from './po-review.live';

/*
 * Price differences (2026-10-30, user): the approved PO lines where the reviewer kept OUR price / MRP (po_price_differences,
 * written by the price check at approval). Listed per PO and per channel, with an email draft to tell the channel
 * (subject, body, attachment name; the frontend builds the attachment from the lines), and "Mark as sent".
 */

export type PriceDiffStatus = (typeof PRICE_DIFFS.STATUS)[keyof typeof PRICE_DIFFS.STATUS];
export type PriceDiffView = (typeof PRICE_DIFFS.VIEW)[keyof typeof PRICE_DIFFS.VIEW];

export interface PriceDiffFilter {
  status: PriceDiffStatus;
  channel?: string;
  uploadId?: string;
  /** approved_at from / to, YYYY-MM-DD (IST days are close enough for a list filter). */
  from?: string;
  to?: string;
}

export interface PriceDiffLine {
  id: string;
  uploadId: string;
  poNumber: string;
  poDate: string | null;
  channel: string;
  lineNo: string;
  channelSkuCode: string;
  pepCode: string;
  productName: string;
  field: string;
  qty: number | null;
  poValue: number;
  ourValue: number;
  difference: number;
  approvedAt: string;
  sentAt: string | null;
  sentBy: string | null;
}

const repo = () => AppDataSource.getRepository(PoPriceDifference);

/** WHERE for a filter (the alias d), with its values. */
const whereOf = (f: PriceDiffFilter): { sql: string; params: unknown[] } => {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (f.status === PRICE_DIFFS.STATUS.OPEN) parts.push('d.sent_at IS NULL');
  if (f.status === PRICE_DIFFS.STATUS.SENT) parts.push('d.sent_at IS NOT NULL');
  if (f.channel) { parts.push('d.channel = ?'); params.push(f.channel); }
  if (f.uploadId) { parts.push('d.upload_id = ?'); params.push(f.uploadId); }
  if (f.from) { parts.push('d.approved_at >= ?'); params.push(`${f.from} 00:00:00`); }
  if (f.to) { parts.push('d.approved_at <= ?'); params.push(`${f.to} 23:59:59`); }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
};

const money = (v: unknown): number => Math.round(Number(v) * 100) / 100;
/** A DB value as text ('' for null; numbers as written). */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** One row per PO or per channel: lines, money difference (price lines: difference x qty), open / sent. */
export const listGroups = async (view: PriceDiffView, f: PriceDiffFilter) => {
  const w = whereOf(f);
  const value = `SUM(CASE WHEN d.field = 'price' THEN d.difference * COALESCE(d.qty, 0) ELSE 0 END)`;
  if (view === PRICE_DIFFS.VIEW.CHANNEL) {
    const rows = await AppDataSource.query<Record<string, unknown>[]>(
      `SELECT d.channel, COUNT(DISTINCT d.upload_id) pos, COUNT(*) line_count, ${value} value_difference,
              SUM(d.sent_at IS NULL) open_lines, MIN(CASE WHEN d.sent_at IS NULL THEN d.approved_at END) oldest_open, MAX(d.approved_at) last_approved
         FROM ${TABLES.PO_PRICE_DIFFERENCES} d ${w.sql} GROUP BY d.channel ORDER BY oldest_open IS NULL, oldest_open, d.channel LIMIT ${PRICE_DIFFS.LIST_LIMIT}`,
      w.params,
    );
    return rows.map((r) => ({
      channel: String(r.channel), pos: Number(r.pos), lines: Number(r.line_count), valueDifference: money(r.value_difference),
      openLines: Number(r.open_lines), oldestOpen: r.oldest_open ? new Date(r.oldest_open as string).toISOString() : null,
      lastApproved: new Date(r.last_approved as string).toISOString(),
    }));
  }
  const rows = await AppDataSource.query<Record<string, unknown>[]>(
    `SELECT d.upload_id, d.po_number, DATE_FORMAT(MAX(d.po_date), '%Y-%m-%d') po_date, d.channel, COUNT(*) line_count, ${value} value_difference,
            SUM(d.sent_at IS NULL) open_lines, MAX(d.approved_at) approved_at, MAX(d.sent_at) sent_at
       FROM ${TABLES.PO_PRICE_DIFFERENCES} d ${w.sql} GROUP BY d.upload_id, d.po_number, d.channel
      ORDER BY approved_at DESC LIMIT ${PRICE_DIFFS.LIST_LIMIT}`,
    w.params,
  );
  return rows.map((r) => ({
    uploadId: String(r.upload_id), poNumber: String(r.po_number), poDate: str(r.po_date) || null, channel: str(r.channel),
    lines: Number(r.line_count), valueDifference: money(r.value_difference), openLines: Number(r.open_lines),
    approvedAt: new Date(r.approved_at as string).toISOString(), sentAt: r.sent_at ? new Date(r.sent_at as string).toISOString() : null,
  }));
};

/** The lines of one PO or one channel (newest PO first, then line order). */
export const listLines = async (f: PriceDiffFilter): Promise<PriceDiffLine[]> => {
  if (!f.uploadId && !f.channel) throw appError(ERROR_CODES.PRICE_DIFF_SCOPE_REQUIRED);
  const w = whereOf(f);
  const rows = await AppDataSource.query<Record<string, unknown>[]>(
    `SELECT d.*, DATE_FORMAT(d.po_date, '%Y-%m-%d') po_day, u.name sent_by_name, u.email sent_by_email FROM ${TABLES.PO_PRICE_DIFFERENCES} d LEFT JOIN ${TABLES.USERS} u ON u.id = d.sent_by
      ${w.sql} ORDER BY d.approved_at DESC, d.upload_id, CAST(d.line_no AS UNSIGNED), d.line_no, d.field LIMIT ${PRICE_DIFFS.LINES_LIMIT}`,
    w.params,
  );
  return rows.map((r) => ({
    id: String(r.id), uploadId: String(r.upload_id), poNumber: String(r.po_number), poDate: str(r.po_day) || null,
    channel: str(r.channel), lineNo: str(r.line_no), channelSkuCode: str(r.channel_sku_code), pepCode: str(r.pep_code),
    productName: str(r.product_name), field: String(r.field), qty: r.qty === null ? null : Number(r.qty),
    poValue: money(r.po_value), ourValue: money(r.our_value), difference: money(r.difference),
    approvedAt: new Date(r.approved_at as string).toISOString(), sentAt: r.sent_at ? new Date(r.sent_at as string).toISOString() : null,
    sentBy: (r.sent_by_name as string | null) || (r.sent_by_email as string | null) || null,
  }));
};

const day = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The email to tell the channel: subject, body, attachment file name (no extension) and the lines it covers. */
export const emailDraft = async (f: PriceDiffFilter, signName: string) => {
  const lines = await listLines(f);
  const channel = f.channel ?? lines[0]?.channel ?? '';
  const pos = [...new Map(lines.map((l) => [l.uploadId, l])).values()];
  const what = pos.length === 1 ? PRICE_DIFF_EMAIL.WHAT_PO(pos[0].poNumber) : PRICE_DIFF_EMAIL.WHAT_POS(pos.length);
  const today = day(new Date());
  const shown = lines.slice(0, PRICE_DIFFS.BODY_LINES_MAX);
  const body = [
    PRICE_DIFF_EMAIL.GREETING, '', PRICE_DIFF_EMAIL.INTRO, '',
    ...pos.flatMap((p) => {
      const mine = shown.filter((l) => l.uploadId === p.uploadId);
      return mine.length ? [PRICE_DIFF_EMAIL.PO_LINE(p.poNumber, p.poDate ?? ''), ...mine.map((l) =>
        PRICE_DIFF_EMAIL.ITEM(l.productName || l.pepCode, l.channelSkuCode, PRICE_DIFF_EMAIL.FIELD_LABEL[l.field] ?? l.field, l.poValue.toFixed(2), l.ourValue.toFixed(2)))] : [];
    }),
    ...(lines.length > shown.length ? [PRICE_DIFF_EMAIL.MORE(lines.length - shown.length)] : []),
    '', PRICE_DIFF_EMAIL.ATTACHED, '', PRICE_DIFF_EMAIL.SIGN(signName),
  ].join('\n');
  return {
    to: '',
    subject: PRICE_DIFF_EMAIL.SUBJECT(channel, what, today),
    body,
    fileName: PRICE_DIFF_EMAIL.FILE(channel, what, today),
    lineIds: lines.map((l) => l.id),
    lines,
  };
};

/** Mark lines as sent (only ones not sent yet); one batch id for this email. */
export const markSent = async (ids: string[], by: { id: number; email: string }) => {
  if (!ids.length) throw appError(ERROR_CODES.PRICE_DIFF_IDS_REQUIRED);
  const batch = crypto.randomUUID();
  const res = await repo().update({ id: In(ids), sentAt: IsNull() }, { sentAt: new Date(), sentBy: by.id, sentBatch: batch });
  log.info(LOG_SOURCE.APP, `[price-differences] ${by.email} marked ${res.affected ?? 0} line(s) sent (batch ${batch})`);
  bumpReview();
  return { marked: res.affected ?? 0, batch };
};
