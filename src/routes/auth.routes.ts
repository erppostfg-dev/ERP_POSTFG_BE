import { CookieOptions, Router } from 'express';
import { env } from '../config/env';
import { AUTH, ERROR_CODES } from '../constants';
import { resolveAllAccess } from '../modules/auth/access.service';
import { clientInfo, requireAuth } from '../modules/auth/auth.middleware';
import { allowedUser, endSession, googleSignInUrl, newState, profileFromCode, startSession } from '../modules/auth/session.service';
import { AppError, appError } from '../utils/AppError';

/*
 * Login routes (API contract, 2026-10-09; prefg's flow):
 *   GET  /auth/google            redirect to Google sign-in
 *   GET  /auth/google/callback   Google returns here -> session cookie -> redirect to AUTH_REDIRECT_URL
 *                                 (refused: AUTH_REDIRECT_URL?error=<CODE>)
 *   GET  /auth/me                the signed-in user, roles and every page's access
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

const redirectWithError = (code: string): string => {
  const url = new URL(env.auth.redirectUrl);
  url.searchParams.set('error', code);
  return url.toString();
};

router.get('/google', (_req, res, next) => {
  try {
    const state = newState();
    res.cookie(AUTH.STATE_COOKIE, state, cookieOptions(AUTH.STATE_COOKIE_MINUTES * 60 * 1000));
    res.redirect(googleSignInUrl(state));
  } catch (err) {
    next(err);
  }
});

router.get('/google/callback', async (req, res) => {
  const expected = req.cookies?.[AUTH.STATE_COOKIE];
  res.clearCookie(AUTH.STATE_COOKIE, { path: '/' });
  try {
    if (!expected || req.query.state !== expected) throw appError(ERROR_CODES.OAUTH_STATE_INVALID);
    if (typeof req.query.code !== 'string') throw appError(ERROR_CODES.GOOGLE_TOKEN_INVALID);
    const profile = await profileFromCode(req.query.code);
    const user = await allowedUser(profile);
    const { token, expiresAt } = await startSession(user, profile, clientInfo(req));
    res.cookie(AUTH.SESSION_COOKIE, token, cookieOptions(expiresAt.getTime() - Date.now()));
    console.log(`[auth] login ${user.email} (user ${user.id})`);
    res.redirect(env.auth.redirectUrl);
  } catch (err) {
    const code = err instanceof AppError ? err.code : ERROR_CODES.INTERNAL;
    console.log(`[auth] login refused: ${code}${err instanceof AppError ? ` (${err.message})` : ''}`);
    if (!(err instanceof AppError)) console.error(err);
    res.redirect(redirectWithError(code));
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { user, roles } = req.auth!;
    res.json({
      data: {
        user: { id: String(user.id), name: user.name, email: user.email, roles },
        access: await resolveAllAccess(user.id, roles),
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
    console.log(`[auth] logout ${req.auth!.user.email}`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
