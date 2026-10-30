import { EntityManager } from 'typeorm';
import { MASTER_LOG_TYPE, PRICE_CHOICE, PRICE_DIFF_FIELD, PriceChoice, round2 } from '../../constants';
import { PoPriceDifference } from '../../entities';
import { afterEdit, editRowIn } from '../masters/master-edit.service';
import { Actor, approveSubmission } from './po-review-actions.service';
import { ValidatedLine, ValidationResult } from '../po-validation/validate-po';

/*
 * Price check in PO review (user, 2026-10-30), what happens when the PO is APPROVED (inside the approval's transaction,
 * so the PO, the list and the master change commit or fail together):
 *   - every line kept at OUR price / MRP -> a po_price_differences row (the Price differences tab, to tell the channel);
 *   - every line set to the CHANNEL's value with "update master" -> the channel SKU's rate_after_margin / mrp becomes the
 *     PO's value, through the Masters edit (same checks, History row by the reviewer with the PO in the remark). The
 *     caller re-checks the channel's other POs in review once committed (afterEdit).
 */

export interface PriceCheckLine {
  lineNo: string;
  priceFrom?: PriceChoice;
  mrpFrom?: PriceChoice;
  updateMaster?: boolean;
}

export interface PriceCheckContext {
  v: ValidationResult;
  poDate: string | null;
  uploadId: string;
  submissionId: string;
  poUid: string;
  reviewer: { id: number; email: string };
  approverId: number;
  now: Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown): number => Number(v);

/** The OURS lines as po_price_differences rows (price and MRP each its own row). */
const differenceRows = (c: PriceCheckContext): Partial<PoPriceDifference>[] => {
  const rows: Partial<PoPriceDifference>[] = [];
  const base = (l: ValidatedLine): Partial<PoPriceDifference> => ({
    uploadId: c.uploadId, submissionId: c.submissionId, poUid: c.poUid, poNumber: c.v.poNumber, poDate: c.poDate && DATE.test(c.poDate) ? c.poDate : null,
    channel: c.v.channelDisplayName, lineNo: String(l.lineNo), channelSkuCode: l.channelSkuCode ?? '', pepCode: l.pepCode, productName: (l.skuName ?? '').slice(0, 255),
    qty: l.chargedQty === '' ? null : String(l.chargedQty), reviewedBy: c.reviewer.id, approvedBy: c.approverId, approvedAt: c.now,
  });
  for (const l of c.v.lines) {
    if (l.priceFrom === PRICE_CHOICE.OURS && l.poUnitPrice !== '' && l.masterRate !== '') {
      rows.push({ ...base(l), field: PRICE_DIFF_FIELD.PRICE, poValue: String(l.poUnitPrice), ourValue: String(l.masterRate), difference: String(round2(n(l.poUnitPrice) - n(l.masterRate))) });
    }
    if (l.mrpFrom === PRICE_CHOICE.OURS && l.poMrp !== '' && l.masterMrp !== '') {
      rows.push({ ...base(l), field: PRICE_DIFF_FIELD.MRP, poValue: String(l.poMrp), ourValue: String(l.masterMrp), difference: String(round2(n(l.poMrp) - n(l.masterMrp))) });
    }
  }
  return rows;
};

/**
 * Writes the difference rows and applies the "update master" choices; returns the Masters edit results for afterEdit.
 * One edit per channel SKU row (two lines of the same SKU change it once).
 */
const applyPriceChoices = async (
  m: EntityManager, c: PriceCheckContext, choices: PriceCheckLine[],
): Promise<{ changed: string[]; channels: string[] | null }[]> => {
  const rows = differenceRows(c);
  if (rows.length) await m.getRepository(PoPriceDifference).insert(rows);

  const edits = new Map<string, { changes: Record<string, number>; original: Record<string, number>; lines: string[] }>();
  for (const choice of choices.filter((x) => x.updateMaster)) {
    const l = c.v.lines.find((x) => String(x.lineNo) === choice.lineNo);
    if (!l?.channelSkuId) continue;
    const e = edits.get(l.channelSkuId) ?? { changes: {}, original: {}, lines: [] };
    if (l.priceFrom === PRICE_CHOICE.CHANNEL && l.ourRate !== '' && !('rateAfterMargin' in e.changes)) {
      e.changes.rateAfterMargin = n(l.ourRate);
      e.original.rateAfterMargin = n(l.masterRate);
    }
    if (l.mrpFrom === PRICE_CHOICE.CHANNEL && l.ourMrp !== '' && !('mrp' in e.changes)) {
      e.changes.mrp = n(l.ourMrp);
      e.original.mrp = n(l.masterMrp);
    }
    e.lines.push(choice.lineNo);
    if (Object.keys(e.changes).length) edits.set(l.channelSkuId, e);
  }
  const results: { changed: string[]; channels: string[] | null }[] = [];
  for (const [id, e] of edits) {
    const remark = `From PO review: ${c.v.channelDisplayName} PO ${c.v.poNumber} line ${e.lines.join(', ')} (upload ${c.uploadId}), the channel's value`;
    results.push(await editRowIn(m, MASTER_LOG_TYPE.CHANNEL_SKU, id, { changes: e.changes, original: e.original, remark }, c.reviewer));
  }
  return results;
};

/** Approve a PO review submission (Approvals page) with its price check choices; the re-checks run once committed. */
export const approveWithPrices = async (id: string, by: Actor, remark?: string) => {
  const edits: { changed: string[]; channels: string[] | null }[] = [];
  const result = await approveSubmission(id, by, remark, async (m, ctx) => {
    edits.push(...(await applyPriceChoices(m, { ...ctx, approverId: by.id }, ctx.lines)));
  });
  for (const e of edits) afterEdit(e);
  return result;
};
