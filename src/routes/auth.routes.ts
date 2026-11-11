import { CookieOptions, Router } from 'express';
import { env } from '../config/env';
import { AUTH, ERROR_CODES } from '../constants';
import { loadAccess, resolveAllAccess, resolveCapabilities } from '../modules/auth/access.service';
import { clientInfo, requireAuth } from '../modules/auth/auth.middleware';
import { allowedUser, endSession, googleSignInUrl, newState, profileFromCode, startSession } from '../modules/auth/session.service';
import { AppError, appError } from '../utils/AppError';
import { AppDataSource } from '../config/data-source';
import { Role } from '../entities';
import { In } from 'typeorm';
import { LOG_SOURCE } from '../constants/logging';
import { log } from '../utils/logger';
import { logError } from '../utils/classify-error';

/*
 * Login routes (API contract, 2026-10-09; prefg's flow):
 *   GET  /auth/google            redirect to Google sign-in (?app=bulk: back to the Bulk Orders portal, BULK_PORTAL_URL)
 *   GET  /auth/google/callback   Google returns here -> session cookie -> redirect to AUTH_REDIRECT_URL
 *                                 (refused: AUTH_REDIRECT_URL?error=<CODE>)
 *   GET  /auth/me                the signed-in user, roles, PO Overview team and every page's access
 *   POST /auth/logout            ends the session, clears the cookie
 */

const router = Router();

/** httpOnly: scripts can't read it; Lax: sent on the redirect back from Google; Secure in production. */
const cookieOptions = (maxAgeMs: number): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.auth.cookieSecure,
  path: '/',
  maxAge: maxAgeMs,
});

/** Where the browser goes after sign-in: the frontend that started it (Bulk Orders portal or POST_FG). */
const backTo = (app: unknown): string => (app === AUTH.APP_BULK ? env.auth.bulkPortalUrl : env.auth.redirectUrl);

const redirectWithError = (code: string, app: unknown): string => {
  const url = new URL(backTo(app));
  url.searchParams.set('error', code);
  return url.toString();
};

router.get('/google', (req, res, next) => {
  try {
    const state = newState();
    res.cookie(AUTH.STATE_COOKIE, state, cookieOptions(AUTH.STATE_COOKIE_MINUTES * 60 * 1000));
    if (req.query.app === AUTH.APP_BULK) res.cookie(AUTH.APP_COOKIE, AUTH.APP_BULK, cookieOptions(AUTH.STATE_COOKIE_MINUTES * 60 * 1000));
    else res.clearCookie(AUTH.APP_COOKIE, { path: '/' });
    res.redirect(googleSignInUrl(state));
  } catch (err) {
    next(err);
  }
});

router.get('/google/callback', async (req, res) => {
  const expected = req.cookies?.[AUTH.STATE_COOKIE];
  const app: unknown = req.cookies?.[AUTH.APP_COOKIE];
  res.clearCookie(AUTH.STATE_COOKIE, { path: '/' });
  res.clearCookie(AUTH.APP_COOKIE, { path: '/' });
  try {
    if (!expected || req.query.state !== expected) throw appError(ERROR_CODES.OAUTH_STATE_INVALID);
    if (typeof req.query.code !== 'string') throw appError(ERROR_CODES.GOOGLE_TOKEN_INVALID);
    const profile = await profileFromCode(req.query.code);
    const user = await allowedUser(profile);
    const { token, expiresAt } = await startSession(user, profile, clientInfo(req));
    res.cookie(AUTH.SESSION_COOKIE, token, cookieOptions(expiresAt.getTime() - Date.now()));
    log.info(LOG_SOURCE.GOOGLE_LOGIN, `[auth] login ${user.email} (user ${user.id})`);
    res.redirect(backTo(app));
  } catch (err) {
    const code = err instanceof AppError ? err.code : ERROR_CODES.INTERNAL;
    log.info(LOG_SOURCE.GOOGLE_LOGIN, `[auth] login refused: ${code}${err instanceof AppError ? ` (${err.message})` : ''}`);
    if (!(err instanceof AppError)) logError(LOG_SOURCE.GOOGLE_LOGIN, '[auth] login failed unexpectedly', err);
    res.redirect(redirectWithError(code, app));
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { user, roles } = req.auth!;
    const rows = await loadAccess(user.id, roles); // one load for the pages and the special permissions
    res.json({
      data: {
        // team = the person's PO Overview team (users.po_team), null = none; the header shows it next to the roles.
        // roleLabels (2026-10-15): custom roles' names from the roles table, for the header badge.
        user: {
          id: String(user.id), name: user.name, email: user.email, roles, team: user.poTeam ?? null,
          // Never blocks sign-in: before the UsersAndRoles migration (no roles table) the labels are just empty.
          roleLabels: roles.length ? await AppDataSource.getRepository(Role).findBy({ key: In(roles) }).then((rs) => Object.fromEntries(rs.map((r) => [r.key, r.label]))).catch(() => ({})) : {},
        },
        access: await resolveAllAccess(user.id, roles, rows),
        // Special permissions (on / off), e.g. po-review:edit-all (2026-10-22).
        capabilities: await resolveCapabilities(user.id, roles, rows),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await endSession(req.auth!, clientInfo(req));
    res.clearCookie(AUTH.SESSION_COOKIE, { path: '/' });
    log.info(LOG_SOURCE.GOOGLE_LOGIN, `[auth] logout ${req.auth!.user.email}`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
