import supertest from 'supertest';
import app from '../../src/app';
import { AUTH, DEFAULT_ROLE_GRANTS, ROLES, USER_STATUS } from '../../src/constants';
import { forgetSessions, startSession } from '../../src/modules/auth/session.service';
import { forgetAccess } from '../../src/modules/auth/access.service';
import { User } from '../../src/entities';
import { db, insert } from './db';

/*
 * Logging in for API tests (2026-10-28): a real users row + roles + the REAL session code (startSession, the signed
 * cookie, authFromToken on every request), so login and page access are tested exactly as the app does them.
 *   loginAs('admin' | 'developer' | 'operations-executive' | ... | null)  -> { cookie, userId, email }
 *   api(cookie?)  -> supertest agent for app (GET / POST ... with the cookie)
 * Roles seeded by the migrations (RoleCatalog) bring their page grants; admin / developer get DEFAULT_ROLE_GRANTS.
 */
let seq = 0;

const ensureDefaultGrants = async () => {
  const ds = await db();
  for (const role of [ROLES.ADMIN, ROLES.DEVELOPER] as const) {
    for (const g of DEFAULT_ROLE_GRANTS[role]) {
      await ds.query('INSERT IGNORE INTO page_permissions (role, page_slug, access_level) VALUES (?, ?, ?)', [role, g.pageSlug, g.access]);
    }
  }
};

export interface TestLogin { cookie: string; userId: number; email: string }

export const loginAs = async (role: string | null, opts: { email?: string; status?: string } = {}): Promise<TestLogin> => {
  await ensureDefaultGrants();
  seq += 1;
  const email = opts.email ?? `test.${role ?? 'norole'}.${seq}@mcaffeine.com`;
  const userId = await insert('users', { name: `Test ${role ?? 'no role'} ${seq}`, email, status: opts.status ?? USER_STATUS.ACTIVE });
  if (role) await insert('user_roles', { user_id: userId, role });
  const user = await (await db()).getRepository(User).findOneByOrFail({ id: userId });
  const { token } = await startSession(user, { googleId: `g-${seq}`, email, name: user.name }, { ip: '127.0.0.1', userAgent: 'vitest' });
  forgetSessions();
  forgetAccess();
  return { cookie: `${AUTH.SESSION_COOKIE}=${token}`, userId, email };
};

export const api = () => supertest(app);
