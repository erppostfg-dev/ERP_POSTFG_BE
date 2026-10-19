import { Logger } from 'typeorm';
import { LOG_MAX_SQL, LOG_SOURCE } from '../constants/logging';
import { logError } from '../utils/classify-error';
import { logContext } from '../utils/log-context';
import { logEvent, writeLog } from '../utils/logger';
import { env } from './env';

/*
 * Database log (user, 2026-10-08; logger lines 2026-10-19):
 *   - every query is COUNTED in its request / job (API_TOO_MANY_QUERIES finds queries in a loop);
 *   - a query slower than DB_SLOW_MS is a DB_SLOW_QUERY warning, ALWAYS (also with DB_LOGGING=false), with the API
 *     path / job it came from (TypeORM's maxQueryExecutionTime, set in data-source.ts);
 *   - a failed query is DB_<FAILURE> with the plain reason and fix (e.g. DB_SCHEMA_MISMATCH: run the migration);
 *   - writes and transactions are DB_QUERY lines (the console shows what the app does to the database); reads
 *     only with DB_LOGGING=true. With LOG_FORMAT=json (EC2) writes are debug, so CloudWatch gets them only with LOG_LEVEL=debug.
 * Parameter values are written only for local runs (pretty format), never on EC2 (they can hold emails / names).
 */

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)\b/i;
const TRANSACTION = /^\s*(START TRANSACTION|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i;
const MAX_VALUE = 60;
const MAX_PARAMS = 12;

const short = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);
const oneLine = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const value = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return short(JSON.stringify(v), MAX_VALUE);
  return short(String(v), MAX_VALUE);
};

/** Parameters only in local (pretty) logs. */
const params = (p?: unknown[]): string | undefined =>
  env.log.format === 'json' || !p?.length ? undefined : `[${p.slice(0, MAX_PARAMS).map(value).join(', ')}${p.length > MAX_PARAMS ? `, … +${p.length - MAX_PARAMS}` : ''}]`;

const where = () => {
  const ctx = logContext();
  return ctx?.path ? { path: `${ctx.method} ${ctx.path}` } : {};
};

export class DbConsoleLogger implements Logger {
  constructor(private readonly logReads: boolean) {}

  logQuery(query: string, parameters?: unknown[]): void {
    const ctx = logContext();
    if (ctx) ctx.dbQueries++;
    // Writes / transactions: shown locally (info), only with LOG_LEVEL=debug on EC2 (json) to keep CloudWatch small.
    const writeLevel = env.log.format === 'json' ? 'debug' : 'info';
    if (TRANSACTION.test(query)) writeLog(writeLevel, LOG_SOURCE.DB, 'DB_QUERY', oneLine(query).toUpperCase());
    else if (WRITE.test(query)) writeLog(writeLevel, LOG_SOURCE.DB, 'DB_QUERY', short(oneLine(query), LOG_MAX_SQL), { params: params(parameters) });
    else if (this.logReads) writeLog('info', LOG_SOURCE.DB, 'DB_QUERY', short(oneLine(query), LOG_MAX_SQL), { params: params(parameters) });
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
    logError(LOG_SOURCE.DB, 'query failed', error, { query: short(oneLine(query), LOG_MAX_SQL), params: params(parameters), ...where() });
  }

  logQuerySlow(time: number, query: string, parameters?: unknown[]): void {
    logEvent('DB_SLOW_QUERY', `query took ${time} ms`, { ms: time, limitMs: env.log.dbSlowMs, query: short(oneLine(query), LOG_MAX_SQL), params: params(parameters), ...where() });
  }

  /** Schema and migration messages are always shown (migration:show / run list their migrations here). */
  logSchemaBuild(message: string): void {
    logEvent('DB_INFO', message);
  }

  logMigration(message: string): void {
    logEvent('DB_INFO', `migration: ${message}`);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') writeLog('warn', LOG_SOURCE.DB, 'DB_WARN', String(message));
    // migration:show lists "[X] name" / "[ ] name" here; TypeORM's other info (file scans) only with DB_LOGGING=true.
    else if (/^\s*\[[ X]\]/.test(String(message)) || this.logReads) logEvent('DB_INFO', String(message));
  }
}
