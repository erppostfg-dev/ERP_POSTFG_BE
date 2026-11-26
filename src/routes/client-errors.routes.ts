import { NextFunction, Request, Response, Router } from 'express';
import { CLIENT_ERRORS, ERROR_CODES, errorMessage, type ClientErrorKind } from '../constants';
import { requireAuth } from '../modules/auth/auth.middleware';
import { appError } from '../utils/AppError';
import { logEvent } from '../utils/logger';

/*
 * POST /client-errors (2026-11-26, Admin > Monitor > Errors). Any signed-in person (POST_FG or the Bulk portal): the
 * browser reports an error the server never saw (a page crash, the server unreachable, a page file missing after a
 * deploy). The server writes ONE CLIENT_ERROR log line (CloudWatch); nothing is stored in the database.
 *   body { kind: crash | network | stale_chunk | other, message, page, code?, status?, requestId? } -> 202 { logged }
 * At most CLIENT_ERRORS.PER_MINUTE lines per person per minute: more are dropped quietly (logged: false).
 */

const router = Router();

const recent = new Map<number, { minute: number; n: number }>();
/** Tests only. */
export const clearClientErrorLimits = () => recent.clear();

const allow = (userId: number): boolean => {
  const minute = Math.floor(Date.now() / 60_000);
  const r = recent.get(userId);
  if (!r || r.minute !== minute) {
    recent.set(userId, { minute, n: 1 });
    if (recent.size > 5000) for (const [k, v] of recent) if (v.minute !== minute) recent.delete(k);
    return true;
  }
  r.n++;
  return r.n <= CLIENT_ERRORS.PER_MINUTE;
};

type Problem = { field: string; code: string; message: string };
const text = (v: unknown, field: string, max: number, problems: Problem[], required = false): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) problems.push({ field, code: ERROR_CODES.FIELD_REQUIRED, message: errorMessage(ERROR_CODES.FIELD_REQUIRED, field) });
    return undefined;
  }
  if (typeof v !== 'string') {
    problems.push({ field, code: ERROR_CODES.FIELD_REQUIRED, message: errorMessage(ERROR_CODES.FIELD_REQUIRED, field) });
    return undefined;
  }
  return v.slice(0, max);
};

router.post(CLIENT_ERRORS.ROUTES.REPORT, requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const problems: Problem[] = [];
    const kind = b.kind;
    if (typeof kind !== 'string' || !(CLIENT_ERRORS.KINDS as readonly string[]).includes(kind)) {
      problems.push({ field: 'kind', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, 'kind', CLIENT_ERRORS.KINDS.join(', ')) });
    }
    const message = text(b.message, 'message', CLIENT_ERRORS.MESSAGE_MAX, problems, true);
    const page = text(b.page, 'page', CLIENT_ERRORS.FIELD_MAX, problems, true);
    const code = text(b.code, 'code', CLIENT_ERRORS.FIELD_MAX, problems);
    const requestId = text(b.requestId, 'requestId', CLIENT_ERRORS.FIELD_MAX, problems);
    const status = typeof b.status === 'number' && Number.isInteger(b.status) ? b.status : undefined;
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);

    const userId = req.auth!.user.id;
    if (!allow(userId)) return res.status(202).json({ data: { logged: false } });
    logEvent('CLIENT_ERROR', `browser ${kind as ClientErrorKind} on ${page}`, {
      kind, page, userId, error: message, ...(code ? { errorCode: code } : {}), ...(status !== undefined ? { status } : {}),
      ...(requestId ? { failedRequestId: requestId } : {}), userAgent: String(req.headers['user-agent'] ?? '').slice(0, CLIENT_ERRORS.FIELD_MAX),
    });
    return res.status(202).json({ data: { logged: true } });
  } catch (err) {
    return next(err);
  }
});

export default router;
