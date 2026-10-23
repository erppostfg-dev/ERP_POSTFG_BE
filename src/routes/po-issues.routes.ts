import { NextFunction, Request, Response, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, PAGE, PO_ISSUES } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { poIssuePos, poIssuesByChannel } from '../modules/po-issues/po-issues.service';
import { appError } from '../utils/AppError';

/*
 * PO issues per channel (user, 2026-10-22; Users & Roles -> PO issues). Admin / developer only, like the rest of
 * Users & Roles (editor on /admin AND the role):
 *   GET /admin/po-issues?days=30                                   per channel: POs by status, POs with issues, and
 *                                                                   each kind of problem with its items (once per PO)
 *   GET /admin/po-issues/pos?channel=&kind=&item=&days=30           the POs behind one count
 */

const router = Router();

const requireUserAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.NOT_A_USER_ADMIN, USER_ADMIN_ROLES.join(' / ')));
  }
  next();
};
const admin = [requireAuth, requirePage(PAGE.ADMIN, ACCESS_LEVEL.EDITOR), requireUserAdmin];

const daysOf = (req: Request): number => {
  const d = Number(req.query[PO_ISSUES.QUERY.DAYS]);
  return PO_ISSUES.DAYS.includes(d) ? d : PO_ISSUES.DEFAULT_DAYS;
};
const text = (req: Request, name: string): string => (typeof req.query[name] === 'string' ? (req.query[name] as string) : '');

router.get(PO_ISSUES.ROUTES.LIST, ...admin, async (req, res, next) => {
  try {
    res.json({ data: await poIssuesByChannel(daysOf(req)) });
  } catch (err) {
    next(err);
  }
});

router.get(PO_ISSUES.ROUTES.POS, ...admin, async (req, res, next) => {
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
