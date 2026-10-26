import { env } from '../config/env';
import { LOG_SOURCE_PREFIX, type LogSource } from '../constants/logging';
import { classifyError, kindOfStatus } from './classify-error';
import { logContext, newContext, runInContext, shortId } from './log-context';
import { logEvent, logFailure, writeLog, type LogFields } from './logger';

/*
 * Timing and logging of every call to another service (S3, Gmail, Pub/Sub, Google login, Amazon, web links, OCR):
 *   <SOURCE>_CALL  debug  it worked (time in ms)          -> LOG_LEVEL=debug to see every call
 *   <SOURCE>_SLOW  warn   it worked but took > EXT_SLOW_MS -> always
 *   <SOURCE>_<FAILURE>    it failed: reason + fix            -> always (constants/logging FAILURES / FIXES)
 * The error is re-thrown unchanged, so callers keep their own handling (retries, fallbacks).
 * It also counts the call in the current request / job and warns once when the same op + key repeats.
 */

export interface CallOptions {
  /** Shown on the line (key, messageId, path ...); also the repeat check's key when `key` is set. */
  fields?: LogFields;
  /** Identity of what is read / written (S3 key, message id): same op + key several times = API_REPEATED_CALLS. */
  key?: string;
  /**
   * For APIs that answer errors without throwing (fetch): the HTTP status to log as a failure, or undefined when ok.
   * The result is still returned to the caller.
   */
  failedStatus?: (result: unknown) => number | undefined;
  /** Kinds that are normal for this call (e.g. NOT_FOUND when checking whether a file exists): logged as debug. */
  expected?: string[];
}

const noteRepeat = (source: LogSource, op: string, key?: string): void => {
  const ctx = logContext();
  if (!ctx || !key) return;
  const id = `${source}:${op}:${key}`;
  const n = (ctx.repeats.get(id) ?? 0) + 1;
  ctx.repeats.set(id, n);
  if (n === env.log.repeatWarn + 1) logEvent('API_REPEATED_CALLS', `${op} called ${n} times for the same key`, { service: source, op, key });
};

export const logCall = async <T>(source: LogSource, op: string, fn: () => Promise<T>, opts: CallOptions = {}): Promise<T> => {
  const started = Date.now();
  const ctx = logContext();
  noteRepeat(source, op, opts.key);
  const done = () => {
    const ms = Date.now() - started;
    if (ctx) { ctx.extCalls++; ctx.extMs += ms; }
    return ms;
  };
  const prefix = LOG_SOURCE_PREFIX[source];
  try {
    const result = await fn();
    const ms = done();
    const status = opts.failedStatus?.(result);
    if (status !== undefined) {
      const kind = kindOfStatus(status);
      logFailure(source, kind, `${op} answered HTTP ${status}`, { op, ms, status, ...opts.fields }, opts.expected?.includes(kind) ? 'debug' : undefined);
    } else if (env.log.extSlowMs > 0 && ms > env.log.extSlowMs) {
      writeLog('warn', source, `${prefix}_SLOW`, `${op} took ${ms} ms`, { op, ms, limitMs: env.log.extSlowMs, reason: `A call to ${source} took longer than EXT_SLOW_MS.`, ...opts.fields });
    } else {
      writeLog('debug', source, `${prefix}_CALL`, `${op} ok`, { op, ms, ...opts.fields });
    }
    return result;
  } catch (err) {
    const ms = done();
    const f = classifyError(source, err);
    logFailure(source, f.kind, `${op} failed`, { op, ms, status: f.status, errorCode: f.errorCode, error: f.error, ...opts.fields },
      opts.expected?.includes(f.kind) ? 'debug' : undefined);
    throw err;
  }
};

/**
 * Runs background work (no web request) as a job: its own jobId on every line, query / call counters, and one
 * JOB_DONE / JOB_SLOW / JOB_FAILED line at the end. Errors are re-thrown to the caller's own handling.
 *   await runJob('pubsub-change', () => processGmailChanges(...), { historyId })
 */
export const runJob = async <T>(name: string, fn: () => Promise<T>, fields: LogFields = {}): Promise<T> => {
  const ctx = newContext({ jobId: `${name}:${shortId()}` });
  return runInContext(ctx, async () => {
    const started = Date.now();
    try {
      const result = await fn();
      const ms = Date.now() - started;
      const counts = { job: name, ms, dbQueries: ctx.dbQueries, extCalls: ctx.extCalls, extMs: ctx.extMs, ...fields };
      if (env.log.jobSlowMs > 0 && ms > env.log.jobSlowMs) logEvent('JOB_SLOW', `${name} took ${Math.round(ms / 1000)} s`, { limitMs: env.log.jobSlowMs, ...counts });
      else logEvent('JOB_DONE', `${name} done`, counts);
      if (env.log.dbQueriesWarn > 0 && ctx.dbQueries > env.log.dbQueriesWarn * 10) {
        logEvent('API_TOO_MANY_QUERIES', `${name} ran ${ctx.dbQueries} queries`, { job: name, dbQueries: ctx.dbQueries, limit: env.log.dbQueriesWarn * 10 });
      }
      return result;
    } catch (err) {
      const f = classifyError('app', err);
      logEvent('JOB_FAILED', `${name} failed`, { job: name, ms: Date.now() - started, errorCode: f.errorCode, error: f.error, ...fields });
      throw err;
    }
  });
};
