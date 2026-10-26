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
