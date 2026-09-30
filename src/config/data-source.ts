import 'reflect-metadata';
import path from 'path';
import { DataSource } from 'typeorm';
import { env } from './env';

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: env.db.host,
  port: env.db.port,
  username: env.db.username,
  password: env.db.password,
  database: env.db.name,
  synchronize: env.db.synchronize,
  logging: env.db.logging,
  timezone: 'Z',
  charset: 'utf8mb4',
  // Glob needs forward slashes, so normalise Windows paths.
  entities: [path.join(__dirname, '../entities/**/*.{ts,js}').replace(/\\/g, '/')],
  migrations: [path.join(__dirname, '../migrations/**/*.{ts,js}').replace(/\\/g, '/')],
});
