import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AppDataSource } from '../../config/data-source';
import { AccessLevel, AUTH, ERROR_CODES, IST_OFFSET_MS } from '../../constants';
import { ActivityLog } from '../../entities';
import { appError } from '../../utils/AppError';
import { allows, resolveAccess } from './access.service';
import { authFromToken, AuthContext, ClientInfo } from './session.service';

/*
 * Route guards, the counterpart of prefg's withGateway: requireAuth (signed in) and requirePage(slug, level)
 * (page access, prefg's rules). activityLog writes one activity_log row per request that changes something.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. */
    auth?: AuthContext;
    /** Set by activityLog; ties the activity_log row to the log lines. */
    requestId?: string;
  }
}

/** IP (first hop of x-forwarded-for) and user agent, as prefg records them. */
export const clientInfo = (req: Request): ClientInfo => ({
  ip: (req.header('x-forwarded-for')?.split(',')[0].trim() || req.ip) ?? null,
  userAgent: req.header('user-agent')?.slice(0, 255) ?? null,
});

/** 401 unless the session cookie belongs to an active session of an allowed user. */
export const requireAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    req.auth = await authFromToken(req.cookies?.[AUTH.SESSION_COOKIE]);
    next();
  } catch (err) {
    next(err);
  }
};

/** 403 unless the user's access to the page is at least `level` (use after requireAuth). */
export const requirePage = (pageSlug: string, level: AccessLevel) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) throw appError(ERROR_CODES.UNAUTHENTICATED);
      const have = await resolveAccess(req.auth.user.id, req.auth.roles, pageSlug);
      if (!allows(have, level)) throw appError(ERROR_CODES.FORBIDDEN_PAGE, pageSlug, level, have).withDetails({ page: pageSlug, needed: level, have });
      next();
    } catch (err) {
      next(err);
    }
  };

/** Like requirePage, for data shown on several pages: access at `level` on any one of them is enough. */
export const requireAnyPage = (pageSlugs: string[], level: AccessLevel) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) throw appError(ERROR_CODES.UNAUTHENTICATED);
      let have: AccessLevel | undefined;
      for (const slug of pageSlugs) {
        have = await resolveAccess(req.auth.user.id, req.auth.roles, slug);
        if (allows(have, level)) return next();
      }
      throw appError(ERROR_CODES.FORBIDDEN_PAGE, pageSlugs.join(' or '), level, have ?? 'none').withDetails({ page: pageSlugs, needed: level, have });
    } catch (err) {
      next(err);
    }
  };

/**
 * One activity_log row for every request that changes something (not GET / HEAD / OPTIONS), written after the
 * response is sent. A failed log write never fails the request (as prefg).
 */
export const activityLog = (req: Request, res: Response, next: NextFunction): void => {
  req.requestId = crypto.randomUUID();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const started = Date.now();
  res.on('finish', () => {
    const c = clientInfo(req);
    AppDataSource.isInitialized &&
      AppDataSource.getRepository(ActivityLog)
        .insert({
          userId: req.auth?.user.id ?? null,
          method: req.method,
          path: req.originalUrl.split('?')[0].slice(0, 255),
          status: res.statusCode,
          durationMs: Date.now() - started,
          ipAddress: c.ip,
          userAgent: c.userAgent,
          requestId: req.requestId ?? null,
          createdOn: new Date(Date.now() + IST_OFFSET_MS), // IST wall time, as prefg's created_on
        })
        .catch((err) => console.error('[activity_log] write failed:', err instanceof Error ? err.message : err));
  });
  next();
};
