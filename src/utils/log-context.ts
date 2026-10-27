import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

/*
 * The request / job a log line belongs to, without passing it around by hand (Node's AsyncLocalStorage follows every
 * await). An API request gets its requestId in middlewares/request-log.ts; background work (Pub/Sub change, Amazon
 * poll, OCR run, resume) gets a jobId from runJob(). Every log line then carries that id, so one request or one
 * email can be followed through the DB, S3, Gmail and OCR lines in CloudWatch.
 * The counters find waste: how many queries / outside calls one request or job made, and which call repeated.
 */

export interface LogContext {
  requestId?: string;
  jobId?: string;
  method?: string;
  path?: string;
  userId?: number;
  /** PO upload being worked on, when known (pipeline, review): added to every line. */
  uploadId?: string | number;
  /** The step of a job running now (step() in log-call.ts): on every line, and on "server blocked" lines. */
  step?: string;
  /** The first step that failed (JOB_FAILED names it). */
  failedStep?: string;
  dbQueries: number;
  extCalls: number;
  extMs: number;
  /** "<source>:<op>:<key>" -> times called, for API_REPEATED_CALLS. */
  repeats: Map<string, number>;
}

const store = new AsyncLocalStorage<LogContext>();

export const newContext = (ids: Partial<LogContext>): LogContext => ({ dbQueries: 0, extCalls: 0, extMs: 0, repeats: new Map(), ...ids });

/** The current request / job, or undefined at start-up and in timers outside a job. */
export const logContext = (): LogContext | undefined => store.getStore();

export const runInContext = <T>(ctx: LogContext, fn: () => T): T => store.run(ctx, fn);

/** Adds facts to the current context (e.g. the user after login, the upload id in the pipeline). */
export const setLogFields = (fields: Partial<Pick<LogContext, 'userId' | 'uploadId'>>): void => {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, fields);
};

export const shortId = (): string => crypto.randomUUID().slice(0, 8);

/**
 * Background work that must not carry the request it was started from (2026-10-27): a shared poller started by the
 * first screen kept that request's id and path on every later tick (slow queries showed up as GET /health). Runs `fn`
 * (and every timer it starts) under its own job name instead.
 */
export const inBackground = <T>(jobId: string, fn: () => T): T => store.run(newContext({ jobId }), fn);

/*
 * What is running now (2026-10-27): jobs and requests register here, so a "server blocked" or heartbeat line can say
 * what was going on ("intransit run 36 · step building, 41 s") instead of only how many requests were open.
 */
const work = new Map<string, { what: string; since: number; ctx?: LogContext; idle?: () => boolean }>();

/** `idle`: true while the work only waits (a live-updates stream that stays open): left out of runningNow. */
export const trackWork = (id: string, what: string, ctx?: LogContext, idle?: () => boolean): void =>
  void work.set(id, { what, since: Date.now(), ctx, idle });
export const untrackWork = (id: string): void => void work.delete(id);

/** e.g. ["ocr:1a2b3c4d · step 'run OCR' · 41 s", "GET /api/v1/intransit/day · 2 s"], longest running first (max 5). */
export const runningNow = (): string[] =>
  [...work.values()]
    .filter((w) => !w.idle?.())
    .sort((a, b) => a.since - b.since)
    .slice(0, 5)
    .map((w) => `${w.what}${w.ctx?.step ? ` · step '${w.ctx.step}'` : ''} · ${Math.round((Date.now() - w.since) / 1000)} s`);
