import { NextFunction, Request, Response, Router } from 'express';
import {
  ACCESS_LEVEL,
  APPROVAL_LIST_STATUSES,
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
} from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { approveSubmission, rejectSubmission } from '../modules/po-review/po-review-actions.service';
import { getApproval, listApprovals } from '../modules/po-review/po-review-approvals.service';
import { reviewEvents, reviewVersion } from '../modules/po-review/po-review.live';
import { appError } from '../utils/AppError';
import { bodyReader, Problem } from './po-review.routes';

/*
 * Approvals page (2026-10-15, user): PO reviews submitted for approval.
 *   GET  /approvals/po-reviews?status=pending|approved|rejected&q=&page=&pageSize=   one tab + the count of every tab.
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
    const page = int(PO_REVIEW_QUERY.PAGE, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = int(PO_REVIEW_QUERY.PAGE_SIZE, PO_REVIEW_LIST.DEFAULT_PAGE_SIZE, PO_REVIEW_LIST.MAX_PAGE_SIZE);
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
    const { items, total, counts } = await listApprovals({ status: status as ReviewSubmissionStatus, q: str(PO_REVIEW_QUERY.Q), page, pageSize });
    const canDecide = !!req.auth?.roles.some((r) => (APPROVER_ROLES as readonly string[]).includes(r));
    res.json({ data: items, meta: { page, pageSize, total, counts, canDecide } });
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
    res.json({ data: await approveSubmission(id, actor(req), remark) });
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
