import { inject } from 'vitest';
import { AppDataSource } from '../../src/config/data-source';
import { forgetAccess } from '../../src/modules/auth/access.service';
import { forgetSessions } from '../../src/modules/auth/session.service';

/*
 * The test database (2026-10-28): mcaff_postfg_test, built from all migrations by test/setup/global.ts.
 *   db()       the app's own DataSource, connected once per test file
 *   resetDb()  empties every table the migrations left empty and puts the ones they filled (roles, page access, team
 *              access, status lists) back exactly as seeded; clears the login caches
 *   insert()   one row, returns its id (raw SQL: tests describe exactly the row they need)
 *   rows()     SELECT helper for checking side effects
 */
export const db = async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  return AppDataSource;
};

export const resetDb = async (): Promise<void> => {
  const ds = await db();
  await ds.transaction(async (m) => {
    await m.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of inject('dataTables')) await m.query(`DELETE FROM \`${t}\``);
    // back to exactly what the migrations seeded (a test may have changed a role's page access, ...)
    for (const t of inject('seedTables')) {
      await m.query(`DELETE FROM \`${t}\``);
      await m.query(`INSERT INTO \`${t}\` SELECT * FROM \`__seed_${t}\``);
    }
    await m.query('SET FOREIGN_KEY_CHECKS = 1');
  });
  // the 30 s login / page-access caches must not carry anything over from the previous test
  forgetSessions();
  forgetAccess();
};

export const insert = async (table: string, row: Record<string, unknown>): Promise<number> => {
  const ds = await db();
  const cols = Object.keys(row);
  const values = cols.map((c) => {
    const v = row[c];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  const res = await ds.query<{ insertId: number }>(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
  return res.insertId;
};

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await db()).query<T[]>(sql, params);

export const count = async (table: string, where = '1 = 1', params: unknown[] = []): Promise<number> =>
  Number(((await rows<{ n: string }>(`SELECT COUNT(*) n FROM \`${table}\` WHERE ${where}`, params))[0]).n);

export const closeDb = async (): Promise<void> => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
};
