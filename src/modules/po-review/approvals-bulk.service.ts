import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { APPROVAL_BULK_RESULT, APPROVAL_KIND, ERROR_CODES, LOG_SOURCE, REVIEW_SUBMISSION_STATUS, REVIEW_SUBMISSION_TYPE } from '../../constants';
import { PoReviewSubmission } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { Actor, rejectSubmission } from './po-review-actions.service';
import { kindOf } from './po-review-approvals.service';
import { approveWithPrices } from './price-check.service';

/*
 * Approve / reject several pending PO reviews at once (Approvals page, user 2026-11-02: the approver opens and checks
 * them one by one, then approves the checked ones together). Each submission goes through EXACTLY the single action
 * (approveWithPrices / rejectSubmission), one after another, each in its own transaction: one that fails or no longer
 * passes the checks (returned to In Review by itself) does not stop the others. Approving ones that update the master
 * (price check "update master") needs confirmMasterUpdates: the screen shows the warning first.
 */

export type BulkResult = (typeof APPROVAL_BULK_RESULT)[keyof typeof APPROVAL_BULK_RESULT];
export interface BulkItemResult {
  id: string;
  poNumber: string | null;
  channel: string | null;
  result: BulkResult;
  saleOrderCode?: string;
  /** Why it was returned / failed (the same message the single action gives). */
  message?: string;
}

const pendingOf = async (ids: string[]) =>
  AppDataSource.getRepository(PoReviewSubmission).find({
    select: { id: true, poNumber: true, channel: true, status: true, fixes: true },
    where: { id: In(ids), type: REVIEW_SUBMISSION_TYPE.APPROVAL },
  });

const failure = (err: unknown): { result: BulkResult; message: string } => {
  if (err instanceof AppError && err.code === ERROR_CODES.REVIEW_RETURNED) return { result: APPROVAL_BULK_RESULT.RETURNED, message: err.message };
  return { result: APPROVAL_BULK_RESULT.FAILED, message: err instanceof Error ? err.message : String(err) };
};

export const bulkApprove = async (ids: string[], by: Actor, opts: { remark?: string; confirmMasterUpdates: boolean }): Promise<BulkItemResult[]> => {
  const rows = await pendingOf(ids);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const master = rows.filter((r) => r.status === REVIEW_SUBMISSION_STATUS.PENDING && kindOf(r.fixes) === APPROVAL_KIND.MASTER_UPDATE);
  if (master.length && !opts.confirmMasterUpdates) {
    throw appError(ERROR_CODES.MASTER_UPDATE_NOT_CONFIRMED, master.length).withDetails({ ids: master.map((r) => String(r.id)) });
  }
  const out: BulkItemResult[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    const base = { id, poNumber: s?.poNumber ?? null, channel: s?.channel ?? null };
    try {
      const r = await approveWithPrices(id, by, opts.remark);
      out.push({ ...base, result: APPROVAL_BULK_RESULT.APPROVED, saleOrderCode: r.saleOrderCode });
    } catch (err) {
      out.push({ ...base, ...failure(err) });
    }
  }
  log.info(LOG_SOURCE.APP, `[approvals] bulk approve by ${by.email}: ${summary(out)}`);
  return out;
};

export const bulkReject = async (ids: string[], remark: string, by: Actor): Promise<BulkItemResult[]> => {
  const byId = new Map((await pendingOf(ids)).map((r) => [String(r.id), r]));
  const out: BulkItemResult[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    const base = { id, poNumber: s?.poNumber ?? null, channel: s?.channel ?? null };
    try {
      await rejectSubmission(id, remark, by);
      out.push({ ...base, result: APPROVAL_BULK_RESULT.REJECTED });
    } catch (err) {
      out.push({ ...base, ...failure(err) });
    }
  }
  log.info(LOG_SOURCE.APP, `[approvals] bulk reject by ${by.email}: ${summary(out)}`);
  return out;
};

const summary = (out: BulkItemResult[]) =>
  Object.entries(out.reduce<Record<string, number>>((a, r) => ({ ...a, [r.result]: (a[r.result] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ');
