import { Logger } from 'typeorm';

/*
 * Database console log (user, 2026-10-08): every write (INSERT / UPDATE / DELETE / schema change) and every transaction
 * start / commit / rollback is printed, so the console shows what the app does to the database.
 * Reads are printed only with DB_LOGGING=true. Long values are shortened; nothing secret goes through these queries.
 */

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)\b/i;
const TRANSACTION = /^\s*(START TRANSACTION|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i;
const MAX_SQL = 220;
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

const params = (p?: unknown[]): string =>
  p?.length ? ` -- [${p.slice(0, MAX_PARAMS).map(value).join(', ')}${p.length > MAX_PARAMS ? `, … +${p.length - MAX_PARAMS}` : ''}]` : '';

export class DbConsoleLogger implements Logger {
  constructor(private readonly logReads: boolean) {}

  logQuery(query: string, parameters?: unknown[]): void {
    if (TRANSACTION.test(query)) console.log(`[db] ${oneLine(query).toUpperCase()}`);
    else if (WRITE.test(query)) console.log(`[db] ${short(oneLine(query), MAX_SQL)}${params(parameters)}`);
    else if (this.logReads) console.log(`[db] ${short(oneLine(query), MAX_SQL)}${params(parameters)}`);
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
    console.error(`[db] FAILED ${short(oneLine(query), MAX_SQL)}${params(parameters)}: ${error instanceof Error ? error.message : error}`);
  }

  logQuerySlow(time: number, query: string): void {
    console.warn(`[db] slow (${time} ms): ${short(oneLine(query), MAX_SQL)}`);
  }

  /** Schema and migration messages are always shown (migration:show / run list their migrations here). */
  logSchemaBuild(message: string): void {
    console.log(`[db] ${message}`);
  }

  logMigration(message: string): void {
    console.log(`[db] migration: ${message}`);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') console.warn(`[db] ${String(message)}`);
    // migration:show lists "[X] name" / "[ ] name" here; TypeORM's other info (file scans) only with DB_LOGGING=true.
    else if (/^\s*\[[ X]\]/.test(String(message)) || this.logReads) console.log(`[db] ${String(message)}`);
  }
}
