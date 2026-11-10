import { NextFunction, Request, Response, Router } from 'express';
import { ERROR_CODES, NOTICES } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth } from '../modules/auth/auth.middleware';
import { Actor, markNoticesSeen, myNotices, noticePeople, noticeSettings, saveNoticeSettings, sendNotice } from '../modules/notices/notices.service';
import { appError } from '../utils/AppError';

/*
 * Notices (2026-11-10, constants/notices.ts, modules/notices). Every signed-in person:
 *   GET   /notices            my bell part: { enabled, canSendEveryone, unread, items } (to me / everyone + sent by me, 2 days)
 *   POST  /notices            { to: userId | 'everyone', text, link? } or { replyToId, text, link? } -> 201 my bell part
 *   POST  /notices/seen       {} : everything received so far counts as read -> my bell part
 *   GET   /notices/people     active people to send to (not me)
 * Admin / developer (403 NOT_A_USER_ADMIN otherwise):
 *   GET   /notices/settings   { enabled }        PUT /notices/settings { enabled }
 */

const router = Router();
const actor = (req: Request): Actor => ({ id: req.auth!.user.id, roles: req.auth!.roles });
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const send = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(status).json({ data: await fn(req) });
  } catch (err) {
    next(err);
  }
};
const adminOnly = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.NOT_A_USER_ADMIN, USER_ADMIN_ROLES.join(' / ')));
  }
  next();
};

router.get(NOTICES.ROUTES.MINE, requireAuth, send((req) => myNotices(actor(req))));
router.post(NOTICES.ROUTES.SEND, requireAuth, send((req) => sendNotice(body(req), actor(req)), 201));
router.post(NOTICES.ROUTES.SEEN, requireAuth, send((req) => markNoticesSeen(actor(req))));
router.get(NOTICES.ROUTES.PEOPLE, requireAuth, send((req) => noticePeople(actor(req))));
router.get(NOTICES.ROUTES.SETTINGS, requireAuth, adminOnly, send(() => noticeSettings()));
router.put(NOTICES.ROUTES.SETTINGS, requireAuth, adminOnly, send((req) => saveNoticeSettings(body(req))));

export default router;
