/*
 * Hand a robot's saved login from this laptop to a server (user, 2026-10-29). Myntra's bot check (Akamai) blocks fresh
 * logins far more often from AWS than from the office, and every Flipkart login costs an OTP; a server with the S3
 * store keeps the robots' saved logins in app_state (s3/caches.ts), so it skips the login once one is stored there.
 *
 *   npm run intransit:fetch -- --source myntra --only grn                    log in here first (saves the session)
 *   npm run intransit:session -- --source myntra --scope test                then store it for the test machines (dev)
 *   npm run intransit:session -- --source myntra --scope prod                ... or for the live server
 *
 * --source flipkart | myntra; --scope test (INTRANSIT_TEST=true servers, e.g. dev) | prod (INTRANSIT_TEST=false).
 * The database is the one in this .env: the laptop and the dev EC2 share it. Prints only cookie counts, never values.
 * A saved login is as good as the password: it is written only to app_state, which only the servers read.
 */
import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { INTRANSIT_FOLDERS } from '../constants';
import { putCache, SESSION_FILES } from '../modules/intransit/s3/caches';
import { PROD_SCOPE, Scope, TEST_SCOPE } from '../modules/intransit/s3/scope';

const USAGE = 'usage: npm run intransit:session -- --source flipkart|myntra --scope test|prod';
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const source = arg('source') as keyof typeof SESSION_FILES | undefined;
  const scope = arg('scope') as Scope | undefined;
  if (!source || !(source in SESSION_FILES) || (scope !== TEST_SCOPE && scope !== PROD_SCOPE)) throw new Error(USAGE);
  const file = SESSION_FILES[source];
  const local = path.join(env.intransit.dir, INTRANSIT_FOLDERS.CACHE, file);
  const text = await fs.readFile(local, 'utf8').catch(() => {
    throw new Error(`no saved ${source} login at ${local}: run "npm run intransit:fetch -- --source ${source} --only grn" first`);
  });
  const state = JSON.parse(text) as { cookies?: unknown[]; origins?: unknown[] };
  if (!Array.isArray(state.cookies) || !state.cookies.length) throw new Error(`${local} holds no cookies: log in again first`);
  const age = (Date.now() - (await fs.stat(local)).mtimeMs) / 3_600_000;
  await AppDataSource.initialize();
  try {
    await putCache(file, text, scope);
  } finally {
    await AppDataSource.destroy();
  }
  console.log(`${source}: saved login (${state.cookies.length} cookies, ${Math.round(age * 10) / 10} h old) stored for the ${scope} servers - their next ${source} fetch uses it`);
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
