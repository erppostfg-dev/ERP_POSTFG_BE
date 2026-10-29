import { NextFunction, Request, Response, Router } from 'express';
import {
  ACCESS_LEVEL,
  ERROR_CODES,
  errorMessage,
  PAGE,
  USER_ADMIN_ROLES,
  USER_BODY,
  USER_ID_PATTERN,
  USER_NAME_MAX,
  USER_STATUS,
  USER_TEAM,
  UserStatus,
  UserTeam,
} from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { Grants, listRoles, rolePages, updateRole } from '../modules/admin/roles.service';
import { createUser, listUsers, sendWelcome, updateUser, UserInput, userOptions } from '../modules/admin/users.service';
import { appError } from '../utils/AppError';
import { Problem } from './po-review.routes';

/*
 * Users & Roles (2026-10-15, user). Admin / developer only (USER_ADMIN_ROLES) and editor on /admin.
 *   GET   /admin/users                     everyone, with roles, team, facilities, who added them, last login, email state
 *   GET   /admin/users/options             roles, teams, facilities for the form
 *   POST  /admin/users                     { email, name?, roles[], team?, facilities[]?, sendEmail? }   add + welcome email
 *   PATCH /admin/users/:id                 { name?, roles?, team?, facilities?, status? }   change / switch off-on
 *   POST  /admin/users/:id/welcome-email   send the welcome email again
 *   GET   /admin/roles                     roles with their page grants and user counts; GET /admin/roles/pages
 *   PATCH /admin/roles/:key                { grants: { "<page>": none|viewer|editor } }   a role's page access
 *   Roles themselves are a fixed list (constants ROLE_CATALOG, loaded by migrations): no create / rename here.
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

/** Field checks: every bad field is collected, so the form shows them all at once. */
const reader = (body: unknown) => {
  const problems: Problem[] = [];
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const bad = (field: string, code: keyof typeof ERROR_CODES, ...args: unknown[]) =>
    problems.push({ field, code, message: (errorMessage as (c: string, ...a: unknown[]) => string)(ERROR_CODES[code], ...args) });
  const text = (field: string, max: number, required = false): string | undefined => {
    const v = b[field];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return required ? (bad(field, 'FIELD_REQUIRED', field), undefined) : undefined;
    if (typeof v !== 'string') return bad(field, 'FIELD_NOT_TEXT', field), undefined;
    if (v.trim().length > max) return bad(field, 'FIELD_TOO_LONG', field, max), undefined;
    return v.trim();
  };
  const list = (field: string): string[] | undefined => {
    const v = b[field];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return bad(field, 'FIELD_NOT_LIST', field), undefined;
    return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
  };
  const oneOf = <T extends string>(field: string, allowed: readonly string[], nullable = false): T | null | undefined => {
    const v = b[field];
    if (v === undefined) return undefined;
    if (v === null && nullable) return null;
    if (typeof v !== 'string' || !allowed.includes(v)) return bad(field, 'FIELD_NOT_ONE_OF', field, allowed.join(', ')), undefined;
    return v as T;
  };
  const done = () => { if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems); };
  return { b, bad, text, list, oneOf, done };
};

const userIdOf = (req: Request) => {
  if (!USER_ID_PATTERN.test(req.params.id)) throw appError(ERROR_CODES.USER_ID_NOT_FOUND, req.params.id);
  return Number(req.params.id);
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then((data) => res.json({ data })).catch(next);
};

// ---- Users ----

router.get('/users', ...guard, wrap(() => listUsers()));
router.get('/users/options', ...guard, wrap(() => userOptions()));

router.post('/users', ...guard, wrap(async (req) => {
  const r = reader(req.body);
  const input: UserInput = {
    email: r.text(USER_BODY.EMAIL, USER_NAME_MAX, true),
    name: r.text(USER_BODY.NAME, USER_NAME_MAX),
    roles: r.list(USER_BODY.ROLES) ?? [],
    team: r.oneOf<UserTeam>(USER_BODY.TEAM, Object.values(USER_TEAM), true) ?? null,
    facilities: r.list(USER_BODY.FACILITIES) ?? [],
    sendEmail: r.b[USER_BODY.SEND_EMAIL] !== false,
  };
  if (input.email && !/^[^\s@]+@[^\s@]+$/.test(input.email)) r.bad(USER_BODY.EMAIL, 'FIELD_NOT_EMAIL', USER_BODY.EMAIL);
  r.done();
  return createUser(input, actor(req));
}));

router.patch('/users/:id', ...guard, wrap(async (req) => {
  const id = userIdOf(req);
  const r = reader(req.body);
  const input: UserInput = {
    name: r.text(USER_BODY.NAME, USER_NAME_MAX),
    roles: r.list(USER_BODY.ROLES),
    team: r.oneOf<UserTeam>(USER_BODY.TEAM, Object.values(USER_TEAM), true),
    facilities: r.list(USER_BODY.FACILITIES),
    status: r.oneOf<UserStatus>(USER_BODY.STATUS, Object.values(USER_STATUS)) ?? undefined,
  };
  r.done();
  return updateUser(id, input, actor(req));
}));

router.post('/users/:id/welcome-email', ...guard, wrap((req) => sendWelcome(userIdOf(req))));

// ---- Roles ----

const grantsOf = (r: ReturnType<typeof reader>): Grants | undefined => {
  const v = r.b[USER_BODY.GRANTS];
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return r.bad(USER_BODY.GRANTS, 'FIELD_NOT_OBJECT', USER_BODY.GRANTS), undefined;
  return v as Grants;
};

router.get('/roles', ...guard, wrap(() => listRoles()));
router.get('/roles/pages', ...guard, wrap(async () => rolePages()));

router.patch('/roles/:key', ...guard, wrap(async (req) => {
  const r = reader(req.body);
  const grants = grantsOf(r);
  if (!grants) r.bad(USER_BODY.GRANTS, 'FIELD_REQUIRED', USER_BODY.GRANTS);
  r.done();
  return updateRole(req.params.key, { grants: grants! }, actor(req));
}));

export default router;
