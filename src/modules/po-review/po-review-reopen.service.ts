import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ChannelName, ERROR_CODES, ISSUE_FIELDS, ISSUE_STATUS, ISSUE_TYPE, LOG_SOURCE, REOPEN, REVIEW_SUBMISSION_STATUS, REVIEW_SUBMISSION_TYPE, UPLOAD_STATUS,
} from '../../constants';
import { PoIssue, PoReopen, PoReviewSubmission, PoUpload, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { readS3Json } from '../email-intake/s3-mirror.service';
import { issueKey, originalValues } from '../po-pipeline/po-uploads.service';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { MasterDataReader } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';
import { Actor } from './po-review-actions.service';
import { bumpReview } from './po-review.live';

/*
 * Rejected POs: see why, reopen, fix, approve (2026-11-03, user). Someone with PO review edit rights reopens a REJECTED
 * PO with a remark (any number of times):
 *   - its processed.json (S3) is checked again against today's masters: every issue found becomes an open issue (the
 *     old rejected ones stay as they were: history);
 *   - one OTHER issue "Reopened after rejection" is added: a person accepts it in the review panel, so the PO always
 *     goes through Approvals (the timed re-check never saves a PO with an OTHER issue open);
 *   - the upload goes back to needs_review; a po_reopens row keeps who / when / why and the rejection it undid.
 * Then it is a PO in review like any other: fixed in the same panel, submitted, approved or rejected again.
 */

export interface RejectionDetail {
  uploadId: string;
  poNumber: string | null;
  channel: string | null;
  status: string;
  /** The latest rejection: where (review = the reviewer, approval = the approver), who, when, why. */
  rejection: { from: 'review' | 'approval'; by: string | null; byEmail: string | null; at: string | null; reason: string | null } | null;
  /** The errors rejected with it (what was wrong, per field / line). */
  rejectedIssues: { type: string; lineNo: number | null; field: string | null; details: string | null; values: Record<string, unknown> | null }[];
  /** When an approver rejected it: what the reviewer had changed (old -> new), from the submission. */
  reviewerFixes: PoReviewSubmission['fixes'];
  /** Every reopen of this PO, newest first. */
  reopens: { at: string; by: string | null; remark: string; rejectedReason: string | null }[];
}

const latestRejection = (uploadId: string) =>
  AppDataSource.getRepository(PoReviewSubmission).findOne({ where: { uploadId, status: REVIEW_SUBMISSION_STATUS.REJECTED }, order: { id: 'DESC' } });

const fromOf = (s: PoReviewSubmission): 'review' | 'approval' => (s.type === REVIEW_SUBMISSION_TYPE.REVIEWER_REJECT ? 'review' : 'approval');

/** Issues rejected within this long of the rejection count as rejected WITH it (they are closed in its transaction). */
const SAME_ROUND_MS = 60_000;

export const getRejection = async (uploadId: string): Promise<RejectionDetail> => {
  const u = await AppDataSource.getRepository(PoUpload).findOne({ select: { id: true, poNumber: true, channel: true, status: true }, where: { id: uploadId } });
  if (!u) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  const s = await latestRejection(uploadId);
  const rejected = await AppDataSource.getRepository(PoIssue).find({ where: { uploadId, status: ISSUE_STATUS.REJECTED }, order: { id: 'ASC' } });
  const at = s?.decidedAt?.getTime();
  const round = at ? rejected.filter((i) => i.resolvedAt && Math.abs(i.resolvedAt.getTime() - at) < SAME_ROUND_MS) : [];
  const reopens = await AppDataSource.getRepository(PoReopen).find({ where: { uploadId }, order: { id: 'DESC' } });
  const ids = [...new Set([s?.decidedBy, ...reopens.map((r) => r.reopenedBy)].filter((v): v is number => typeof v === 'number'))];
  const users = ids.length ? await AppDataSource.getRepository(User).findBy({ id: In(ids) }) : [];
  const person = (id: number | null | undefined) => users.find((x) => x.id === id);
  return {
    uploadId: String(u.id),
    poNumber: u.poNumber,
    channel: u.channel,
    status: u.status,
    rejection: s ? { from: fromOf(s), by: person(s.decidedBy)?.name ?? null, byEmail: person(s.decidedBy)?.email ?? null, at: s.decidedAt?.toISOString() ?? null, reason: s.decisionRemark } : null,
    rejectedIssues: (round.length ? round : rejected).map((i) => ({ type: i.issueType, lineNo: i.lineNo, field: i.fieldName, details: i.details, values: i.originalValues })),
    reviewerFixes: s && s.type === REVIEW_SUBMISSION_TYPE.APPROVAL ? s.fixes : null,
    reopens: reopens.map((r) => ({ at: r.reopenedAt.toISOString(), by: person(r.reopenedBy)?.name ?? person(r.reopenedBy)?.email ?? null, remark: r.remark, rejectedReason: r.rejectedReason })),
  };
};

export const reopenRejected = async (uploadId: string, remark: string, by: Actor): Promise<{ status: string; openIssues: number }> => {
  const upload = await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId });
  if (!upload) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  if (upload.status !== UPLOAD_STATUS.REJECTED) throw appError(ERROR_CODES.UPLOAD_NOT_REJECTED, uploadId, upload.status);
  // the checks again, against today's masters (processed.json from S3 only)
  const url = upload.ocrResult?.processed_json;
  const po = typeof url === 'string' ? await readS3Json<ProcessedPo>(url) : undefined;
  if (!po) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  const v = await validatePo(po, await new MasterDataReader(AppDataSource).forChannel(po.channel_name as ChannelName));
  const rejection = await latestRejection(uploadId);
  let openIssues = 0;
  await AppDataSource.transaction(async (m) => {
    const locked = await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } });
    if (!locked || locked.status !== UPLOAD_STATUS.REJECTED) throw appError(ERROR_CODES.UPLOAD_NOT_REJECTED, uploadId, locked?.status ?? 'gone');
    await m.getRepository(PoReopen).insert({
      uploadId, remark, reopenedBy: by.id, reopenedAt: new Date(),
      rejectedReason: rejection?.decisionRemark ?? null, rejectedFrom: rejection ? fromOf(rejection) : null,
      rejectedBy: rejection?.decidedBy ?? null, rejectedAt: rejection?.decidedAt ?? null, rejectedSubmissionId: rejection ? String(rejection.id) : null,
    });
    const issues = m.getRepository(PoIssue);
    const seen = new Set<string>();
    for (const i of v.issues) {
      const key = issueKey(i.type, i.lineNo, i.field);
      if (seen.has(key)) continue;
      seen.add(key);
      await issues.save(issues.create({
        uploadId, lineNo: typeof i.lineNo === 'number' ? i.lineNo : null, issueType: i.type, fieldName: i.field,
        details: i.message.slice(0, 500), originalValues: originalValues(i, v), status: ISSUE_STATUS.OPEN,
      }));
    }
    await issues.save(issues.create({
      uploadId, lineNo: null, issueType: ISSUE_TYPE.OTHER, fieldName: ISSUE_FIELDS.REOPENED,
      details: REOPEN.ISSUE_TEXT(rejection?.decisionRemark ?? null).slice(0, 500), originalValues: { remark }, status: ISSUE_STATUS.OPEN,
    }));
    openIssues = seen.size + 1;
    await m.getRepository(PoUpload).save({ ...locked, status: UPLOAD_STATUS.NEEDS_REVIEW });
  });
  log.info(LOG_SOURCE.APP, `[po-review] ${uploadId} ${upload.poNumber ?? ''}: reopened by ${by.email} (${openIssues} issue(s) open): ${remark}`);
  bumpReview();
  return { status: UPLOAD_STATUS.NEEDS_REVIEW, openIssues };
};
