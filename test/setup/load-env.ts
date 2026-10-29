import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

/*
 * Test settings (2026-10-28), used by the global setup and by every test file BEFORE the app reads its settings:
 *   1. the DB login: CI job variables (TEST_DB_*) or the laptop's git-ignored .env.test;
 *   2. test/env/test.env (committed, no secrets) overrides everything it names;
 *   3. every OTHER key of the real .env is blanked, so no real key / token can reach a test (dotenv never overwrites a
 *      key that is already set).
 */
export const ROOT = path.resolve(__dirname, '../..');

export const loadTestEnv = (): void => {
  if (process.env.__POSTFG_TEST_ENV === '1') return;
  dotenv.config({ path: path.join(ROOT, '.env.test'), quiet: true });
  const test = dotenv.parse(fs.readFileSync(path.join(ROOT, 'test/env/test.env')));
  Object.assign(process.env, test);
  Object.assign(process.env, {
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_USERNAME: process.env.TEST_DB_USER ?? 'root',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
    DB_NAME: process.env.TEST_DB_NAME ?? 'mcaff_postfg_test',
  });
  const real = path.join(ROOT, '.env');
  if (fs.existsSync(real)) {
    const keep = new Set([...Object.keys(test), 'DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME']);
    for (const key of Object.keys(dotenv.parse(fs.readFileSync(real)))) if (!keep.has(key) && !key.startsWith('TEST_DB_')) process.env[key] = '';
  }
  process.env.__POSTFG_TEST_ENV = '1';
};
