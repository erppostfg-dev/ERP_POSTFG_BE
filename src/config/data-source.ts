import 'reflect-metadata';
import path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ALLOWED_DATABASES, ERROR_CODES } from '../constants';
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
  // The tables are created and changed by others (Final_Schema/final_schema.sql): the app never alters the schema,
  // so synchronize is always off (DB_SYNCHRONIZE is ignored) and the app has no migrations.
  synchronize: false,
  migrationsRun: false,
  migrations: [],
  // Every write and transaction is printed (db-logger.ts); reads too with DB_LOGGING=true.
  logging: ['query', 'error', 'warn'],
  logger: new DbConsoleLogger(env.db.logging),
  timezone: 'Z',
  charset: 'utf8mb4',
  // Glob needs forward slashes, so normalise Windows paths.
  entities: [path.join(__dirname, '../entities/**/*.{ts,js}').replace(/\\/g, '/')],
};

export const AppDataSource = new GuardedDataSource(options);
