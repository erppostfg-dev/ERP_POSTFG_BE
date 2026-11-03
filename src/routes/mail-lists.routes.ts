import { NextFunction, Request, Response, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, errorMessage, MAIL_ADDRESS_MAX, MAIL_LIST_BODY, MAIL_LISTS_ROUTES, PAGE, RECIPIENT_KIND, RecipientKind } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import {
  addRecipient,
  listHistory,
  listMailLists,
  removeRecipient,
  sendTest,
  setListEnabled,
  updateRecipient,
} from '../modules/mail/mail-lists.service';
import { sampleMail } from '../modules/mail/mail-samples';
import { appError } from '../utils/AppError';

/*
 * Users & Roles -> Email (2026-10-30, user): who gets each mail the ERP sends. Admin / developer only, editor on /admin
 * (as the rest of Users & Roles).
 *   GET    /admin/mail-lists                        every mail: on / off, recipients
 *   PUT    /admin/mail-lists/:key                   { enabled }                     switch a mail on / off
 *   POST   /admin/mail-lists/:key/recipients        { email, kind: to|cc|bcc }      add anyone (any address)
 *   PATCH  /admin/mail-lists/:key/recipients/:id    { kind?, paused? }
 *   DELETE /admin/mail-lists/:key/recipients/:id
 *   GET    /admin/mail-lists/:key/history           changes, newest first: { at, by, what }
 *   POST   /admin/mail-lists/:key/test              { onlyMe }   a [Test] copy to yourself, or to the mail's recipients
 * Each change answers the mail as it is now (as in GET).
 */

const router = Router();

const requireUserAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.NOT_A_USER_ADMIN, USER_ADMIN_ROLES.join(' / ')));
  }
  next();
};
const guard = [requireAuth, requirePage(PAGE.ADMIN, ACCESS_LEVEL.EDITOR), requireUserAdmin];
const actor = (req: Request) => ({ id: req.auth!.user.id, email: req.auth!.user.email, roles: req.auth!.roles });

const wrap = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req).then((data) => res.json({ data })).catch(next);
};

const body = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

const KINDS: readonly string[] = Object.values(RECIPIENT_KIND);

/** One field check with the shared validation error (400 VALIDATION_FAILED with the field). */
const invalid = (field: string, code: 'FIELD_REQUIRED' | 'FIELD_NOT_ONE_OF' | 'FIELD_TOO_LONG', ...args: unknown[]) =>
  appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{
    field,
    code,
    message: (errorMessage as (c: string, ...a: unknown[]) => string)(ERROR_CODES[code], field, ...(code === 'FIELD_NOT_ONE_OF' ? [args.join(', ')] : args)),
  }]);

const flag = (b: Record<string, unknown>, field: string, required: boolean): boolean | undefined => {
  const v = b[field];
  if (v === undefined) {
    if (required) throw invalid(field, 'FIELD_REQUIRED');
    return undefined;
  }
  if (typeof v !== 'boolean') throw invalid(field, 'FIELD_NOT_ONE_OF', 'true', 'false');
  return v;
};

const kindOf = (b: Record<string, unknown>, required: boolean): RecipientKind | undefined => {
  const v = b[MAIL_LIST_BODY.KIND];
  if (v === undefined) {
    if (required) throw invalid(MAIL_LIST_BODY.KIND, 'FIELD_REQUIRED');
    return undefined;
  }
  if (typeof v !== 'string' || !KINDS.includes(v)) throw invalid(MAIL_LIST_BODY.KIND, 'FIELD_NOT_ONE_OF', ...KINDS);
  return v as RecipientKind;
};

const recipientId = (req: Request): number => {
  if (!/^\d{1,9}$/.test(req.params.id)) throw appError(ERROR_CODES.MAIL_RECIPIENT_NOT_FOUND, req.params.id);
  return Number(req.params.id);
};

router.get(MAIL_LISTS_ROUTES.LIST, ...guard, wrap(() => listMailLists()));

router.put(MAIL_LISTS_ROUTES.ONE, ...guard, wrap((req) => setListEnabled(req.params.key, flag(body(req), MAIL_LIST_BODY.ENABLED, true) as boolean, actor(req))));

router.post(MAIL_LISTS_ROUTES.RECIPIENTS, ...guard, wrap(async (req) => {
  const b = body(req);
  const email = b[MAIL_LIST_BODY.EMAIL];
  if (typeof email !== 'string' || !email.trim()) throw invalid(MAIL_LIST_BODY.EMAIL, 'FIELD_REQUIRED');
  if (email.trim().length > MAIL_ADDRESS_MAX) throw invalid(MAIL_LIST_BODY.EMAIL, 'FIELD_TOO_LONG', MAIL_ADDRESS_MAX);
  return addRecipient(req.params.key, { email, kind: kindOf(b, false) ?? RECIPIENT_KIND.TO }, actor(req));
}));

router.patch(MAIL_LISTS_ROUTES.RECIPIENT, ...guard, wrap(async (req) => {
  const b = body(req);
  return updateRecipient(req.params.key, recipientId(req), { kind: kindOf(b, false), paused: flag(b, MAIL_LIST_BODY.PAUSED, false) }, actor(req));
}));

router.delete(MAIL_LISTS_ROUTES.RECIPIENT, ...guard, wrap(async (req) => removeRecipient(req.params.key, recipientId(req), actor(req))));

router.get(MAIL_LISTS_ROUTES.HISTORY, ...guard, wrap((req) => listHistory(req.params.key)));

router.post(MAIL_LISTS_ROUTES.TEST, ...guard, wrap(async (req) => {
  const onlyMe = flag(body(req), MAIL_LIST_BODY.ONLY_ME, false) ?? true;
  return sendTest(req.params.key, actor(req), onlyMe, () => sampleMail(req.params.key));
}));

export default router;
