import 'reflect-metadata';
import path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALLOWED_DATABASES, ERROR_CODES, MIGRATIONS_TABLE } from '../constants';
import { LOG_SOURCE } from '../constants/logging';
import { appError } from '../utils/AppError';
import { log } from '../utils/logger';
import { DbConsoleLogger } from './db-logger';
import { env } from './env';

/**
 * Refuses a database that is not in ALLOWED_DATABASES (constants/db.ts). The current DB login can also reach other
 * schemas (prod, inv ...), so this keeps the app on mcaff_postfg_dev until dedicated logins exist.
 */
export const assertAllowedDatabase = (database: string | undefined): void => {
  if (!database || !ALLOWED_DATABASES.includes(database)) {
    throw appError(ERROR_CODES.DB_NOT_ALLOWED, String(database), ALLOWED_DATABASES.join(', '));
  }
};

type PoolConnection = { query: (sql: string, values: unknown[], cb: (err: Error | null) => void) => void };
type MysqlPool = { on: (event: 'connection', fn: (c: PoolConnection) => void) => void };
type MysqlModule = { createPool: (options: unknown) => MysqlPool };

let sessionWarned = false;

/**
 * Time limits on every new pool connection, before its first query (mysql2 runs one connection's commands in order):
 * MySQL stops a SELECT after DB_QUERY_TIMEOUT_MS, a write waiting on a row lock gives up after DB_LOCK_WAIT_S. A server
 * without these settings logs one warning and works as before.
 */
const setSessionLimits = (c: PoolConnection): void => {
  const sets: string[] = [];
  const values: number[] = [];
  if (env.db.queryTimeoutMs > 0) { sets.push('max_execution_time = ?'); values.push(env.db.queryTimeoutMs); }
  if (env.db.lockWaitS > 0) { sets.push('innodb_lock_wait_timeout = ?'); values.push(env.db.lockWaitS); }
  if (!sets.length) return;
  c.query(`SET SESSION ${sets.join(', ')}`, values, (err) => {
    if (!err || sessionWarned) return;
    sessionWarned = true;
    log.warn(LOG_SOURCE.DB, '[db] could not set the query / lock time limits on a connection: queries run without them', { error: err.message });
  });
};

/** A DataSource that checks the database before every connection (server, scripts and the TypeORM CLI). */
class GuardedDataSource extends DataSource {
  override async initialize(): Promise<this> {
    assertAllowedDatabase(this.options.database as string | undefined);
    // Our own copy of the mysql2 module for this driver only (the PEPIMS sources keep theirs), so the pool gets the
    // time limits from its first connection on, including the one TypeORM opens to test the login.
    const driver = this.driver as unknown as { mysql?: MysqlModule };
    const mysql = driver.mysql;
    if (mysql) {
      driver.mysql = {
        ...mysql,
        createPool: (opts: unknown) => {
          const pool = mysql.createPool(opts);
          pool.on('connection', setSessionLimits);
          return pool;
        },
      };
    }
    return super.initialize();
  }
}

const options: DataSourceOptions = {
  type: 'mysql',
  host: env.db.host,
  port: env.db.port,
  username: env.db.username,
  password: env.db.password,
  database: env.db.name,
  // Every schema change goes through a migration in src/migrations (user, 2026-10-09): `npm run migration:generate`
  // writes one from the entities, it is reviewed, then `npm run migration:run` applies it and records it in the
  // migrations table. synchronize is always off, so the schema never changes by itself; migrations never run on start.
  synchronize: false,
  migrationsRun: false,
  migrationsTableName: MIGRATIONS_TABLE,
  migrations: [path.join(__dirname, '../migrations/*.{ts,js}').replace(/\\/g, '/')],
  logging: ['query', 'error', 'warn'],
  logger: new DbConsoleLogger(env.db.logging),
  // A query slower than this is logged as DB_SLOW_QUERY, always (2026-10-19; DB_SLOW_MS, 0 = off).
  ...(env.log.dbSlowMs > 0 ? { maxQueryExecutionTime: env.log.dbSlowMs } : {}),
  timezone: 'Z',
  charset: 'utf8mb4',
  // queueLimit: past this many requests waiting for a free connection, the next one fails at once (0 = no limit)
  extra: { connectionLimit: env.db.poolSize, queueLimit: env.db.queueLimit },
  // Glob needs forward slashes, so normalise Windows paths.
  entities: [path.join(__dirname, '../entities/**/*.{ts,js}').replace(/\\/g, '/')],
};

export const AppDataSource = new GuardedDataSource(options);
