import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { REQUEST_ID_HEADER } from '../constants/logging';
import { logContext, newContext, runInContext } from '../utils/log-context';
import { logEvent } from '../utils/logger';

/*
 * First middleware of every request (2026-10-19):
 *   - gives it a requestId (also sent back as the X-Request-Id header, and as error.requestId in error answers), so a
 *     problem a person reports can be found in CloudWatch;
 *   - runs the rest of the request inside that log context (every DB / S3 / Gmail line of it carries the id);
 *   - writes ONE line when the request ends: API_REQUEST (info), API_CLIENT_ERROR (4xx), API_SERVER_ERROR (5xx) or
 *     API_SLOW (> API_SLOW_MS), with time, status, user, DB query count, outside calls and their time, response size;
 *   - flags waste: API_TOO_MANY_QUERIES (> DB_QUERIES_WARN), API_RESPONSE_LARGE (> RESPONSE_WARN_KB).
 * Live-update streams (SSE) stay open for minutes by design: they are logged when closed, never as slow.
 */

declare module 'express-serve-static-core' {
  interface Locals {
    /** Set by the error handler: the error code of a failed request, for the request line. */
    errorCode?: string;
    errorMessage?: string;
  }
}

/** Counters of the whole server since the last heartbeat (utils/process-monitor reads and resets them). */
export const requestStats = { count: 0, errors5xx: 0, errors4xx: 0, slow: 0, totalMs: 0, maxMs: 0, active: 0 };

const STREAM = 'text/event-stream';

export const requestLog = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const path = req.originalUrl.split('?')[0];
  const ctx = newContext({ requestId, method: req.method, path });
  const started = Date.now();
  requestStats.active++;

  // Bytes sent (streams and files have no Content-Length up front).
  let bytes = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const count = (chunk: unknown, encoding?: unknown) => {
    if (chunk) bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  };
  res.write = ((chunk: unknown, ...rest: unknown[]) => { count(chunk, rest[0]); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => { count(typeof chunk === 'function' ? undefined : chunk, rest[0]); return (end as (...a: unknown[]) => Response)(chunk, ...rest); }) as typeof res.end;

  let logged = false;
  const finish = (closedEarly: boolean) => {
    if (logged) return;
    logged = true;
    requestStats.active--;
    const ms = Date.now() - started;
    const userId = req.auth?.user.id;
    const stream = String(res.getHeader('Content-Type') ?? '').startsWith(STREAM);
    const fields = {
      method: req.method, path, status: res.statusCode, ms, userId,
      dbQueries: ctx.dbQueries, extCalls: ctx.extCalls, extMs: ctx.extMs, kb: Math.round(bytes / 1024),
      ...(res.locals.errorCode ? { errorCode: res.locals.errorCode, error: res.locals.errorMessage } : {}),
      ...(closedEarly && !stream ? { closedByClient: true } : {}),
    };
    if (stream) return logEvent('API_STREAM_CLOSED', `${req.method} ${path} stream closed after ${Math.round(ms / 1000)} s`, fields);

    requestStats.count++;
    requestStats.totalMs += ms;
    requestStats.maxMs = Math.max(requestStats.maxMs, ms);
    const slow = env.log.apiSlowMs > 0 && ms > env.log.apiSlowMs;
    const line = `${req.method} ${path} ${res.statusCode} ${ms} ms`;
    if (res.statusCode >= 500) { requestStats.errors5xx++; logEvent('API_SERVER_ERROR', line, fields); }
    else if (slow) { requestStats.slow++; logEvent('API_SLOW', line, { ...fields, limitMs: env.log.apiSlowMs }); }
    else if (res.statusCode >= 400) { requestStats.errors4xx++; logEvent('API_CLIENT_ERROR', line, fields); }
    else logEvent('API_REQUEST', line, fields);

    if (env.log.dbQueriesWarn > 0 && ctx.dbQueries > env.log.dbQueriesWarn) {
      logEvent('API_TOO_MANY_QUERIES', `${req.method} ${path} ran ${ctx.dbQueries} queries`, { method: req.method, path, dbQueries: ctx.dbQueries, limit: env.log.dbQueriesWarn });
    }
    if (env.log.responseWarnKb > 0 && bytes > env.log.responseWarnKb * 1024) {
      logEvent('API_RESPONSE_LARGE', `${req.method} ${path} sent ${Math.round(bytes / 1024)} KB`, { method: req.method, path, kb: Math.round(bytes / 1024), limitKb: env.log.responseWarnKb });
    }
  };
  res.on('finish', () => runInContext(ctx, () => finish(false)));
  res.on('close', () => runInContext(ctx, () => finish(!res.writableFinished)));

  runInContext(ctx, () => next());
};

/** The current request id (for error answers). */
export const currentRequestId = (): string | undefined => logContext()?.requestId;
