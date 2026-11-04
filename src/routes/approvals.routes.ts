import { NextFunction, Request, Response, Router } from 'express';
import {
  ACCESS_LEVEL,
  APPROVAL_BULK,
  APPROVAL_KIND,
  APPROVAL_LIST_STATUSES,
  APPROVAL_QUERY,
  DAY_PATTERN,
  APPROVER_ROLES,
  ERROR_CODES,
  errorMessage,
  PAGE,
  PO_REVIEW_BODY,
  PO_REVIEW_LIST,
  PO_REVIEW_QUERY,
  REVIEW_LIVE,
  REVIEW_SUBMISSION_STATUS,
  ReviewSubmissionStatus,
  SUBMISSION_ID_PATTERN,
  type ApprovalKind,
} from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { bulkApprove, bulkReject } from '../modules/po-review/approvals-bulk.service';
import { rejectSubmission } from '../modules/po-review/po-review-actions.service';
import { approveWithPrices } from '../modules/po-review/price-check.service';
import { getApproval, listApprovals } from '../modules/po-review/po-review-approvals.service';
import { reviewEvents, reviewVersion } from '../modules/po-review/po-review.live';
import { appError } from '../utils/AppError';
import { bodyReader, Problem } from './po-review.routes';

/*
 * Approvals page (2026-10-15, user): PO reviews submitted for approval.
 *   GET  /approvals/po-reviews?status=pending|approved|rejected&q=&channel=&kind=&issue=&submittedBy=&from=&to=&page=&pageSize=
 *        (channel, issue, submittedBy: one value or several, comma-separated = any of them)
 *        one tab + the count of every tab + the Filters panel's choices; each item has kind (review | master_update)
 *        and fixedIssues (the errors the reviewer resolved, per type).
 *   POST /approvals/po-reviews/bulk-approve  { ids: [1..50], remark?, confirmMasterUpdates? }  each exactly like approve,
 *        one after another; 409 MASTER_UPDATE_NOT_CONFIRMED when one updates the master and it is not confirmed.
 *   POST /approvals/po-reviews/bulk-reject   { ids: [1..50], remark }  each exactly like reject.
 *        Both answer 200 with one result per id: approved (sale order) | rejected | returned | failed (+ message).
 *   GET  /approvals/po-reviews/:id   the submission (who, when, fixes old -> new) + the PO as the review panel shows it.
 *   POST /approvals/po-reviews/:id/approve   { remark? }   creates the PO (PO rows + sale order + Uniware CSV); if it no
 *                                             longer passes, 409 REVIEW_RETURNED and the PO is back in In Review.
 *   POST /approvals/po-reviews/:id/reject    { remark }    rejected with the reason.
 *   GET  /approvals/events, /approvals/live-state   live updates (same stream as PO Review).
 * Viewer on /approvals to read; editor on /approvals AND one of APPROVER_ROLES (admin, developer) to decide.
 */

const router = Router();

const idOf = (req: Request): string => {
  const { id } = req.params;
  if (!SUBMISSION_ID_PATTERN.test(id)) throw appError(ERROR_CODES.SUBMISSION_NOT_FOUND, id);
  return id;
};

/** Only approvers decide (the page access alone is not enough). */
const requireApprover = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.NOT_AN_APPROVER, APPROVER_ROLES.join(' / ')));
  }
  next();
};

const actor = (req: Request) => ({ id: req.auth!.user.id, email: req.auth!.user.email });

router.get(REVIEW_LIVE.EVENTS, requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.VIEWER), (req, res, next) => {
  reviewEvents(req, res).catch(next);
});
router.get(REVIEW_LIVE.STATE, requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    res.json({ data: { version: await reviewVersion() } });
  } catch (err) {
    next(err);
  }
});

router.get('/po-reviews', requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.VIEWER), async (req, res, next) => {
  try {
    const problems: Problem[] = [];
    const str = (name: string) => (typeof req.query[name] === 'string' && (req.query[name] as string).trim() ? (req.query[name] as string).trim() : undefined);
    const status = str(PO_REVIEW_QUERY.STATUS) ?? REVIEW_SUBMISSION_STATUS.PENDING;
    if (!(APPROVAL_LIST_STATUSES as readonly string[]).includes(status)) {
      problems.push({ field: PO_REVIEW_QUERY.STATUS, code: ERROR_CODES.FIELD_NOT_ONE_OF, message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, PO_REVIEW_QUERY.STATUS, APPROVAL_LIST_STATUSES.join(', ')) });
    }
    const int = (name: string, fallback: number, max: number) => {
      const v = str(name);
      if (v === undefined) return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > max) {
        problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_INT_RANGE, message: errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, name, 1, max) });
        return fallback;
      }
      return n;
    };
    // channel / issue / submittedBy: one value or several separated by commas (the Filters panel's multi-selects)
    const list = (name: string) => str(name)?.split(',').map((x) => x.trim()).filter(Boolean);
    const kind = str(APPROVAL_QUERY.KIND);
    const KINDS = Object.values(APPROVAL_KIND) as string[];
    if (kind && !KINDS.includes(kind)) {
      problems.push({ field: APPROVAL_QUERY.KIND, code: ERROR_CODES.FIELD_NOT_ONE_OF, message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, APPROVAL_QUERY.KIND, KINDS.join(', ')) });
    }
    const day = (name: string) => {
      const v = str(name);
      if (v && (!DAY_PATTERN.test(v) || Number.isNaN(Date.parse(v)))) {
        problems.push({ field: name, code: ERROR_CODES.FIELD_NOT_DAY, message: errorMessage(ERROR_CODES.FIELD_NOT_DAY, name) });
        return undefined;
      }
      return v;
    };
    const from = day(PO_REVIEW_QUERY.FROM);
    const to = day(PO_REVIEW_QUERY.TO);
    if (from && to && from > to) {
      problems.push({ field: PO_REVIEW_QUERY.FROM, code: ERROR_CODES.FIELD_RANGE_REVERSED, message: errorMessage(ERROR_CODES.FIELD_RANGE_REVERSED, PO_REVIEW_QUERY.FROM, PO_REVIEW_QUERY.TO) });
    }
    const page = int(PO_REVIEW_QUERY.PAGE, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = int(PO_REVIEW_QUERY.PAGE_SIZE, PO_REVIEW_LIST.DEFAULT_PAGE_SIZE, PO_REVIEW_LIST.MAX_PAGE_SIZE);
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    const { items, total, counts, filterOptions } = await listApprovals({
      status: status as ReviewSubmissionStatus, q: str(PO_REVIEW_QUERY.Q), channels: list(PO_REVIEW_QUERY.CHANNEL),
      kind: kind as ApprovalKind | undefined, issues: list(APPROVAL_QUERY.ISSUE), submittedBy: list(APPROVAL_QUERY.SUBMITTED_BY), from, to, page, pageSize,
      reopened: str(APPROVAL_QUERY.REOPENED) === 'true',
    });
    const canDecide = !!req.auth?.roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r));
    res.json({ data: items, meta: { page, pageSize, total, counts, canDecide, filterOptions } });
  } catch (err) {
    next(err);
  }
});

/** { ids: 1..APPROVAL_BULK.MAX submission ids } of a bulk body, problems listed like the other bodies. */
const idsOf = (body: Record<string, unknown> | undefined, problems: Problem[]): string[] => {
  const v = body?.[APPROVAL_BULK.IDS];
  const ids = Array.isArray(v) ? [...new Set(v.map((x) => String(x)))] : [];
  if (!Array.isArray(v) || !ids.length || ids.length > APPROVAL_BULK.MAX || ids.some((x) => !SUBMISSION_ID_PATTERN.test(x))) {
    problems.push({ field: APPROVAL_BULK.IDS, code: ERROR_CODES.FIELD_NOT_ID_LIST, message: errorMessage(ERROR_CODES.FIELD_NOT_ID_LIST, APPROVAL_BULK.IDS, APPROVAL_BULK.MAX) });
  }
  return ids;
};

router.post('/po-reviews/bulk-approve', requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.EDITOR), requireApprover, async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown> | undefined;
    const problems: Problem[] = [];
    const ids = idsOf(body, problems);
    const remark = bodyReader(problems).remark(body?.[PO_REVIEW_BODY.REMARK], PO_REVIEW_BODY.REMARK, false);
    const confirm = body?.[APPROVAL_BULK.CONFIRM_MASTER];
    if (confirm !== undefined && typeof confirm !== 'boolean') {
      problems.push({ field: APPROVAL_BULK.CONFIRM_MASTER, code: ERROR_CODES.FIELD_NOT_BOOLEAN, message: errorMessage(ERROR_CODES.FIELD_NOT_BOOLEAN, APPROVAL_BULK.CONFIRM_MASTER) });
    }
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    res.json({ data: await bulkApprove(ids, actor(req), { remark, confirmMasterUpdates: confirm === true }) });
  } catch (err) {
    next(err);
  }
});

router.post('/po-reviews/bulk-reject', requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.EDITOR), requireApprover, async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown> | undefined;
    const problems: Problem[] = [];
    const ids = idsOf(body, problems);
    const remark = bodyReader(problems).remark(body?.[PO_REVIEW_BODY.REMARK], PO_REVIEW_BODY.REMARK, true);
    if (problems.length || !remark) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    res.json({ data: await bulkReject(ids, remark, actor(req)) });
  } catch (err) {
    next(err);
  }
});

router.get('/po-reviews/:id', requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.VIEWER), async (req, res, next) => {
  try {
    res.json({ data: await getApproval(idOf(req)) });
  } catch (err) {
    next(err);
  }
});

router.post('/po-reviews/:id/approve', requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.EDITOR), requireApprover, async (req, res, next) => {
  try {
    const id = idOf(req);
    const problems: Problem[] = [];
    const remark = bodyReader(problems).remark((req.body as Record<string, unknown> | undefined)?.[PO_REVIEW_BODY.REMARK], PO_REVIEW_BODY.REMARK, false);
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    res.json({ data: await approveWithPrices(id, actor(req), remark) });
  } catch (err) {
    next(err);
  }
});

router.post('/po-reviews/:id/reject', requireAuth, requirePage(PAGE.APPROVALS, ACCESS_LEVEL.EDITOR), requireApprover, async (req, res, next) => {
  try {
    const id = idOf(req);
    const problems: Problem[] = [];
    const remark = bodyReader(problems).remark((req.body as Record<string, unknown> | undefined)?.[PO_REVIEW_BODY.REMARK], PO_REVIEW_BODY.REMARK, true);
    if (problems.length || !remark) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    res.json({ data: await rejectSubmission(id, remark, actor(req)) });
  } catch (err) {
    next(err);
  }
});

export default router;
