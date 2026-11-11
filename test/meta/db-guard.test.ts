import { afterEach, describe, expect, it } from 'vitest';
import { assertAllowedDatabase } from '../../src/config/data-source';

/*
 * The database guard (constants/db.ts ALLOWED_DATABASES). 2026-11-11: the first prod deploy (326f9e6) stopped at
 * migration:run with DB_NOT_ALLOWED because mcaff_postfg_prod was not on the list. Outside tests the app may use our dev
 * and prod databases only; in tests only the local test database.
 */
describe('database guard', () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it('lets the server use mcaff_postfg_dev and mcaff_postfg_prod', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertAllowedDatabase('mcaff_postfg_dev', 'rds.example')).not.toThrow();
    expect(() => assertAllowedDatabase('mcaff_postfg_prod', 'rds.example')).not.toThrow();
  });

  it('refuses any other database the login can reach, or none', () => {
    process.env.NODE_ENV = 'production';
    for (const db of ['mcaff_inv', 'prefg', undefined]) {
      expect(() => assertAllowedDatabase(db, 'rds.example')).toThrow(expect.objectContaining({ code: 'DB_NOT_ALLOWED' }));
    }
  });

  it('in tests refuses dev and prod, even when allowed for the server', () => {
    process.env.NODE_ENV = 'test';
    expect(() => assertAllowedDatabase('mcaff_postfg_prod', '127.0.0.1')).toThrow(expect.objectContaining({ code: 'DB_NOT_ALLOWED' }));
    expect(() => assertAllowedDatabase('mcaff_postfg_dev', '127.0.0.1')).toThrow(expect.objectContaining({ code: 'DB_NOT_ALLOWED' }));
    expect(() => assertAllowedDatabase('mcaff_postfg_test', '127.0.0.1')).not.toThrow();
  });
});
