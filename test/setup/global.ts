import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { TestProject } from 'vitest/node';
import { loadTestEnv, ROOT } from './load-env';

/*
 * Once per `npm test` (vitest globalSetup, 2026-10-28):
 *   1. the test MySQL must answer: on the laptop it is started from TEST_MYSQLD_BIN / TEST_MYSQLD_INI (.env.test) when
 *      it is not running, and stopped again at the end; in CI the job's MySQL service is used;
 *   2. mcaff_postfg_test is dropped and created empty;
 *   3. ALL migrations run on it (so every run also proves the migrations build the schema from nothing);
 *   4. the tables still empty after the migrations are handed to the tests (inject('dataTables')): resetDb() empties
 *      only those, so what the migrations seed (roles, team access, status lists) stays;
 *   5. test/.tmp (throwaway storage) is emptied.
 * The DB guard (config/data-source.ts) refuses anything but mcaff_postfg_test on 127.0.0.1 / localhost.
 */
type Conn = { query: (sql: string) => Promise<unknown>; end: () => Promise<void> };

const connect = async (database?: string): Promise<Conn> => {
  const mysql = (await import('mysql2/promise')).default;
  return mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
    ...(database ? { database } : {}), connectTimeout: 3000,
  });
};
const answers = async (): Promise<boolean> => {
  try {
    await (await connect()).end();
    return true;
  } catch {
    return false;
  }
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  loadTestEnv();
  let started = false;
  if (!(await answers())) {
    const bin = process.env.TEST_MYSQLD_BIN;
    const ini = process.env.TEST_MYSQLD_INI;
    if (process.env.CI === 'true' || !bin || !ini) {
      throw new Error(`Test MySQL not reachable on ${process.env.DB_HOST}:${process.env.DB_PORT} (laptop: set TEST_MYSQLD_BIN + TEST_MYSQLD_INI in .env.test)`);
    }
    spawn(bin, [`--defaults-file=${ini}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    started = true;
    for (let i = 0; i < 60 && !(await answers()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await answers())) throw new Error('Test MySQL did not start (see its mysqld.log)');
  }

  const name = process.env.DB_NAME!;
  if (name !== 'mcaff_postfg_test') throw new Error(`Refusing to reset ${name}: tests only use mcaff_postfg_test`);
  const c = await connect();
  await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await c.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await c.end();

  // the same command the dev deploy runs (TypeORM CLI, ts-node), on the empty test database
  const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['typeorm-ts-node-commonjs', 'migration:run', '-d', 'src/config/data-source.ts'], {
    cwd: ROOT, env: { ...process.env, TEST_MIGRATIONS: '1' }, encoding: 'utf8', shell: process.platform === 'win32',
  });
  if (run.status !== 0) throw new Error(`Migrations failed on the test database:
${(run.stdout ?? '').slice(-3000)}
${(run.stderr ?? '').slice(-3000)}`);

  const t = await connect(name);
  const tables = (await t.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`)) as [{ t: string }[]];
  const dataTables: string[] = [];
  for (const { t: table } of tables[0]) {
    if (table === 'migrations') continue;
    const [r] = (await t.query(`SELECT COUNT(*) AS n FROM \`${table}\``)) as [{ n: number }[]];
    if (Number(r[0].n) === 0) dataTables.push(table);
  }
  await t.end();
  project.provide('dataTables', dataTables);

  fs.rmSync(path.join(ROOT, 'test/.tmp'), { recursive: true, force: true });

  return async () => {
    if (!started) return;
    // we started it: stop it again (root, local only)
    try {
      const mysql = (await import('mysql2/promise')).default;
      const root = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: 'root' });
      await root.query('SHUTDOWN');
      await root.end();
    } catch {
      // already gone
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dataTables: string[];
  }
}
