import { Request, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, PAGE, PO_ISSUES } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { poIssuePos, poIssuesByChannel } from '../modules/po-issues/po-issues.service';
import { appError } from '../utils/AppError';

/*
 * PO issues per channel (user, 2026-10-22). Since 2026-10-29 (user: "show it to everyone"): a tab of PO Processing &
 * Review, for everyone who can open that page (viewer on /operations/po-review; read-only); was Users & Roles, admin /
 * developer only, under /admin/po-issues.
 *   GET /po-review/issues?days=30[&fresh=1]                        per channel: POs by status, POs with issues, and
 *                                                                   each kind of problem with its items (once per PO);
 *                                                                   shared for 60 s unless fresh=1 (downloads), with
 *                                                                   computedAt + cached
 *   GET /po-review/issues/pos?channel=&kind=&item=&days=30          the POs behind one count
 * Mounted BEFORE the PO review routes (routes/index.ts), so "issues" is never read as an upload id.
 */

const router = Router();

/** Everyone who can open PO Processing & Review (read-only). */
const viewer = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER)];

const daysOf = (req: Request): number => {
  const d = Number(req.query[PO_ISSUES.QUERY.DAYS]);
  return PO_ISSUES.DAYS.includes(d) ? d : PO_ISSUES.DEFAULT_DAYS;
};
const text = (req: Request, name: string): string => (typeof req.query[name] === 'string' ? (req.query[name] as string) : '');

router.get(PO_ISSUES.ROUTES.LIST, ...viewer, async (req, res, next) => {
  try {
    // fresh=1 (downloads): computed now, never the shared answer (user 2026-10-29: nobody downloads stale data)
    res.json({ data: await poIssuesByChannel(daysOf(req), { fresh: req.query[PO_ISSUES.QUERY.FRESH] === '1' }) });
  } catch (err) {
    next(err);
  }
});

router.get(PO_ISSUES.ROUTES.POS, ...viewer, async (req, res, next) => {
  try {
    const channel = text(req, PO_ISSUES.QUERY.CHANNEL);
    const kind = text(req, PO_ISSUES.QUERY.KIND);
    const item = text(req, PO_ISSUES.QUERY.ITEM);
    if (!channel || !kind || !item) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'channel / kind / item', code: ERROR_CODES.FIELD_REQUIRED, message: 'channel, kind and item are required' }]);
    res.json({ data: await poIssuePos(channel, kind, item, daysOf(req)) });
  } catch (err) {
    next(err);
  }
});

export default router;
