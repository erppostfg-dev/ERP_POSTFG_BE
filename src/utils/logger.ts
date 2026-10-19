import { env } from '../config/env';
import {
  FAILURES, FIX_DEFAULT, FIXES, LOG_EVENTS, LOG_FORMAT, LOG_LEVEL_RANK, LOG_MASK, LOG_MAX_TEXT, LOG_SECRET_FIELDS,
  LOG_SECRET_TEXT, LOG_SOURCE, LOG_SOURCE_PREFIX, type FailureKind, type LogEvent, type LogLevel, type LogSource,
} from '../constants/logging';
import { logContext } from './log-context';

/*
 * The one logger of the server (2026-10-19). One line per event on stdout / stderr:
 *   LOG_FORMAT=json   {"time","level","code","source","msg","reason"?,"fix"?,"requestId"|"jobId",...fields}
 *                     -> pm2 log file -> CloudWatch agent -> /mcaffeine-erp-post-fg/po-api-ec2/<env>
 *   LOG_FORMAT=pretty 12:01:02 WARN  s3     S3_SLOW  putObject took 3412 ms  key=…  [req 1a2b3c4d]
 * Secrets are masked by field name and by pattern (LOG_SECRET_FIELDS / LOG_SECRET_TEXT); long text is cut.
 * Logging never throws: if a line cannot be built, a plain line is printed instead.
 */

export type LogFields = Record<string, unknown>;

const cut = (s: string, max = LOG_MAX_TEXT): string => (s.length > max ? `${s.slice(0, max)}… (+${s.length - max})` : s);

export const maskText = (s: string): string => LOG_SECRET_TEXT.reduce((t, re) => t.replace(re, LOG_MASK), s);

/** A safe copy of a value for a log line: secrets masked, depth / size limited, errors as their message. */
const clean = (v: unknown, depth = 0): unknown => {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return cut(maskText(v));
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return cut(maskText(v.message));
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (depth >= 4) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1)).concat(v.length > 20 ? [`… +${v.length - 20}`] : []);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = LOG_SECRET_FIELDS.test(k) ? LOG_MASK : clean(x, depth + 1);
    return out;
  }
  return String(v);
};

const enabled = (level: LogLevel): boolean => LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[env.log.level];

const PRETTY_LEVEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const PRETTY_IN_MSG = new Set(['method', 'path', 'status', 'ms']);
const PRETTY_SKIP = new Set(['time', 'level', 'code', 'source', 'msg', 'requestId', 'jobId', 'reason', 'fix']);

const pretty = (line: Record<string, unknown>): string => {
  const time = new Date(String(line.time)).toLocaleTimeString('en-GB', { hour12: false }); // local time on the console
  const msg = String(line.msg);
  // Fields already said in the message (method, path, status, ms of a request line) are not repeated.
  const said = (k: string, v: unknown) => PRETTY_IN_MSG.has(k) && (typeof v === 'string' || typeof v === 'number') && msg.includes(String(v));
  const rest = Object.entries(line)
    .filter(([k, v]) => !PRETTY_SKIP.has(k) && v !== undefined && !said(k, v))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ');
  const id = line.requestId ? `  [req ${String(line.requestId).slice(0, 8)}]` : line.jobId ? `  [job ${String(line.jobId)}]` : '';
  const why = line.reason ? `\n         why: ${String(line.reason)}${line.fix ? `\n         fix: ${String(line.fix)}` : ''}` : '';
  return `${time} ${PRETTY_LEVEL[line.level as LogLevel]} ${String(line.source).padEnd(6)} ${line.code}  ${line.msg}${rest ? `  ${rest}` : ''}${id}${why}`;
};

/** Writes one line (the base of everything below). */
export const writeLog = (level: LogLevel, source: LogSource, code: string, msg: string, fields: LogFields = {}): void => {
  if (!enabled(level)) return;
  try {
    const ctx = logContext();
    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      code,
      source,
      msg: cut(maskText(msg)),
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.jobId ? { jobId: ctx.jobId } : {}),
      ...(ctx?.userId !== undefined && fields.userId === undefined ? { userId: ctx.userId } : {}),
      ...(ctx?.uploadId !== undefined && fields.uploadId === undefined ? { uploadId: ctx.uploadId } : {}),
      ...(clean(fields) as Record<string, unknown>),
    };
    const text = env.log.format === LOG_FORMAT.JSON ? JSON.stringify(line) : pretty(line);
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${text}\n`);
  } catch (err) {
    process.stderr.write(`${new Date().toISOString()} ${level} ${code} ${msg} (log line failed: ${(err as Error).message})\n`);
  }
};

/** An event of our own app (LOG_EVENTS): level and reason come from the catalog. */
export const logEvent = (code: LogEvent, msg: string, fields: LogFields = {}, source?: LogSource): void => {
  const def = LOG_EVENTS[code];
  const src = source ?? ((Object.entries(LOG_SOURCE_PREFIX).find(([, p]) => code.startsWith(`${p}_`))?.[0] as LogSource) ?? LOG_SOURCE.APP);
  writeLog(def.level, src, code, msg, def.level === 'warn' || def.level === 'error' ? { reason: def.reason, ...fields } : fields);
};

/** A failed call to a source, with the plain reason and the fix (constants/logging FAILURES / FIXES). */
export const logFailure = (source: LogSource, kind: FailureKind, msg: string, fields: LogFields = {}, level?: LogLevel): void => {
  writeLog(level ?? FAILURES[kind].level, source, `${LOG_SOURCE_PREFIX[source]}_${kind}`, msg, {
    reason: FAILURES[kind].reason,
    fix: FIXES[source]?.[kind] ?? FIX_DEFAULT[kind],
    ...fields,
  });
};

/**
 * Short helpers for our own app's lines (replace console.log / warn / error in the server code). The source is the
 * area the line is about, e.g. log.info(LOG_SOURCE.GMAIL, 'catch-up done', { emails: 3 }).
 */
export const log = {
  debug: (source: LogSource, msg: string, fields?: LogFields) => writeLog('debug', source, `${LOG_SOURCE_PREFIX[source]}_INFO`, msg, fields),
  info: (source: LogSource, msg: string, fields?: LogFields) => writeLog('info', source, `${LOG_SOURCE_PREFIX[source]}_INFO`, msg, fields),
  warn: (source: LogSource, msg: string, fields?: LogFields) => writeLog('warn', source, `${LOG_SOURCE_PREFIX[source]}_WARN`, msg, fields),
  error: (source: LogSource, msg: string, fields?: LogFields) => writeLog('error', source, `${LOG_SOURCE_PREFIX[source]}_ERROR`, msg, fields),
};
