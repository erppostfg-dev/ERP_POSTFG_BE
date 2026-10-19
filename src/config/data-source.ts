import 'reflect-metadata';
import path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALLOWED_DATABASES, ERROR_CODES, MIGRATIONS_TABLE } from '../constants';
import { appError } from '../utils/AppError';
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

/** A DataSource that checks the database before every connection (server, scripts and the TypeORM CLI). */
class GuardedDataSource extends DataSource {
  override async initialize(): Promise<this> {
    assertAllowedDatabase(this.options.database as string | undefined);
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
  // Glob needs forward slashes, so normalise Windows paths.
  entities: [path.join(__dirname, '../entities/**/*.{ts,js}').replace(/\\/g, '/')],
};

export const AppDataSource = new GuardedDataSource(options);
