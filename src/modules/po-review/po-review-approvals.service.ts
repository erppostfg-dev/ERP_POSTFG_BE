import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, REVIEW_SUBMISSION_STATUS, REVIEW_SUBMISSION_TYPE, ReviewSubmissionStatus, TABLES } from '../../constants';
import { ReviewFixes } from '../../entities';
import { appError } from '../../utils/AppError';
import { getPoReview, PoReviewDetail } from './po-review.service';

/*
 * The Approvals page's PO reviews (2026-10-15): submissions of type `approval`, one tab per status (pending / approved
 * / rejected), newest first, with who submitted and who decided. The detail adds the PO itself (getPoReview: header,
 * lines, issues, file links) so the approver sees everything on one screen.
 */

export interface ApprovalPerson {
  name: string | null;
  email: string | null;
}

export interface ApprovalListItem {
  id: string;
  uploadId: string;
  status: ReviewSubmissionStatus;
  poNumber: string | null;
  channel: string | null;
  fileName: string | null;
  submittedBy: ApprovalPerson;
  submittedAt: string;
  submitRemark: string | null;
  /** Issues the reviewer resolved (fixed or accepted). */
  issueCount: number;
  /** Fields the reviewer changed (location + every line field). */
  changeCount: number;
  decidedBy: ApprovalPerson | null;
  decidedAt: string | null;
  decisionRemark: string | null;
  saleOrderCode: string | null;
  poUid: string | null;
}

export interface ApprovalListQuery {
  status: ReviewSubmissionStatus;
  q?: string;
  page: number;
  pageSize: number;
}

type Row = {
  id: string | number; upload_id: string | number; status: ReviewSubmissionStatus; po_number: string | null; channel: string | null; file_name: string | null;
  sub_name: string | null; sub_email: string | null; submitted_at: Date; submit_remark: string | null; fixes: ReviewFixes | string | null;
  dec_name: string | null; dec_email: string | null; decided_at: Date | null; decision_remark: string | null; sale_order_code: string | null; po_uid: string | number | null;
};

const SELECT = `
  SELECT s.id, s.upload_id, s.status, s.po_number, s.channel, u.file_name, su.name sub_name, su.email sub_email, s.submitted_at, s.submit_remark,
         s.fixes, du.name dec_name, du.email dec_email, s.decided_at, s.decision_remark, s.sale_order_code, s.po_uid
    FROM ${TABLES.PO_REVIEW_SUBMISSIONS} s
    JOIN ${TABLES.PO_UPLOADS} u ON u.id = s.upload_id
    LEFT JOIN ${TABLES.USERS} su ON su.id = s.submitted_by
    LEFT JOIN ${TABLES.USERS} du ON du.id = s.decided_by`;

const fixesOf = (v: Row['fixes']): ReviewFixes | null => (typeof v === 'string' ? (JSON.parse(v) as ReviewFixes) : v);

const toItem = (r: Row): ApprovalListItem => {
  const fixes = fixesOf(r.fixes);
  return {
    id: String(r.id),
    uploadId: String(r.upload_id),
    status: r.status,
    poNumber: r.po_number,
    channel: r.channel,
    fileName: r.file_name,
    submittedBy: { name: r.sub_name, email: r.sub_email },
    submittedAt: new Date(r.submitted_at).toISOString(),
    submitRemark: r.submit_remark,
    issueCount: fixes?.issues.length ?? 0,
    changeCount: (fixes?.location ? 1 : 0) + (fixes?.lines.reduce((n, l) => n + l.changes.length, 0) ?? 0),
    decidedBy: r.dec_email || r.dec_name ? { name: r.dec_name, email: r.dec_email } : null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decisionRemark: r.decision_remark,
    saleOrderCode: r.sale_order_code,
    poUid: r.po_uid === null ? null : String(r.po_uid),
  };
};

/** One tab of the Approvals page + the count of every tab. */
export const listApprovals = async (query: ApprovalListQuery) => {
  const where = ['s.type = ?', 's.status = ?'];
  const params: unknown[] = [REVIEW_SUBMISSION_TYPE.APPROVAL, query.status];
  if (query.q) {
    where.push('(s.po_number LIKE ? OR s.channel LIKE ? OR su.name LIKE ? OR su.email LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  // Pending: oldest first (first come, first served); decided: latest decision first.
  const order = query.status === REVIEW_SUBMISSION_STATUS.PENDING ? 's.submitted_at ASC, s.id ASC' : 's.decided_at DESC, s.id DESC';
  const rows = (await AppDataSource.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, [
    ...params,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  ])) as Row[];
  const [{ total }] = (await AppDataSource.query(
    `SELECT COUNT(*) total FROM ${TABLES.PO_REVIEW_SUBMISSIONS} s LEFT JOIN ${TABLES.USERS} su ON su.id = s.submitted_by WHERE ${where.join(' AND ')}`,
    params,
  )) as { total: string | number }[];
  const counts = (await AppDataSource.query(
    `SELECT status, COUNT(*) n FROM ${TABLES.PO_REVIEW_SUBMISSIONS} WHERE type = ? GROUP BY status`,
    [REVIEW_SUBMISSION_TYPE.APPROVAL],
  )) as { status: string; n: string | number }[];
  return {
    items: rows.map(toItem),
    total: Number(total),
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) as Record<string, number>,
  };
};

export interface ApprovalDetail extends ApprovalListItem {
  fixes: ReviewFixes | null;
  /** The PO as the review panel shows it (header, lines, issues, file links). */
  review: PoReviewDetail;
}

export const getApproval = async (id: string): Promise<ApprovalDetail> => {
  const [row] = (await AppDataSource.query(`${SELECT} WHERE s.id = ? AND s.type = ?`, [id, REVIEW_SUBMISSION_TYPE.APPROVAL])) as Row[];
  if (!row) throw appError(ERROR_CODES.SUBMISSION_NOT_FOUND, id);
  return { ...toItem(row), fixes: fixesOf(row.fixes), review: await getPoReview(String(row.upload_id)) };
};
