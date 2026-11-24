import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, USER_STATUS } from '../../src/constants';
import { api, loginAs } from '../helpers/auth';
import { closeDb, count, db, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Login, session and health (2026-10-28). Google itself is never called: the sign-in redirect is checked by its URL,
 * the callback's refusal paths need no Google answer; sessions are made with the real session code (helpers/auth).
 */
covers(['GET /health', 'GET /auth/google', 'GET /auth/google/callback', 'GET /auth/me', 'POST /auth/logout']);

// The one Google step (code -> profile) is a stand-in for the successful sign-in tests; everything after it is real.
const google = vi.hoisted(() => ({ email: '' }));
vi.mock('../../src/modules/auth/session.service', async (orig) => ({
  ...(await orig<object>()),
  profileFromCode: vi.fn(async () => ({ googleId: `g-${google.email}`, email: google.email, name: 'Test person' })),
}));

const P = '/api/v1';
beforeEach(resetDb);
afterAll(closeDb);

describe('health', () => {
  it('answers without a login and says whether the DB is up', async () => {
    await db();
    const res = await api().get(`${P}/health`).expect(200);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'up', emailListener: 'disabled' });
  });
});

describe('Google sign-in', () => {
  it('redirects to Google with a state cookie', async () => {
    const res = await api().get(`${P}/auth/google`).expect(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    const state = new URL(res.headers.location).searchParams.get('state');
    expect(String(res.headers['set-cookie'])).toContain(`${AUTH.STATE_COOKIE}=${state}`);
  });

  it('callback with a wrong / missing state goes back to the app with an error, no session', async () => {
    const res = await api().get(`${P}/auth/google/callback?state=forged&code=x`).set('Cookie', `${AUTH.STATE_COOKIE}=real`).expect(302);
    expect(res.headers.location).toContain('error=OAUTH_STATE_INVALID');
    const none = await api().get(`${P}/auth/google/callback?code=x`).expect(302);
    expect(none.headers.location).toContain('error=OAUTH_STATE_INVALID');
    expect(await count('sessions')).toBe(0);
  });

  it('a sign-in started from the Bulk Orders portal (?app=bulk) goes back to the portal; a POST_FG one to POST_FG', async () => {
    const start = await api().get(`${P}/auth/google?app=bulk`).expect(302);
    const cookies = ([] as string[]).concat(start.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith(`${AUTH.APP_COOKIE}=${AUTH.APP_BULK}`))).toBe(true);
    const back = await api().get(`${P}/auth/google/callback?state=forged&code=x`).set('Cookie', `${AUTH.STATE_COOKIE}=real; ${AUTH.APP_COOKIE}=${AUTH.APP_BULK}`).expect(302);
    expect(back.headers.location).toBe('http://localhost:5174/?error=OAUTH_STATE_INVALID');
    const plain = await api().get(`${P}/auth/google/callback?state=forged&code=x`).set('Cookie', `${AUTH.STATE_COOKIE}=real`).expect(302);
    expect(plain.headers.location).toBe('http://localhost:5173/?error=OAUTH_STATE_INVALID');
    // CORS lets the portal call the API with its cookie
    const pre = await api().options(`${P}/auth/me`).set('Origin', 'http://localhost:5174').set('Access-Control-Request-Method', 'GET');
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });

  it('callback without a code is refused', async () => {
    const res = await api().get(`${P}/auth/google/callback?state=s`).set('Cookie', `${AUTH.STATE_COOKIE}=s`).expect(302);
    expect(res.headers.location).toContain('error=GOOGLE_TOKEN_INVALID');
  });
});

describe('/auth/me', () => {
  it('401 without a cookie or with a forged one', async () => {
    expect((await api().get(`${P}/auth/me`)).status).toBe(401);
    expect((await api().get(`${P}/auth/me`).set('Cookie', `${AUTH.SESSION_COOKIE}=not.a.jwt`)).status).toBe(401);
  });

  it('admin: roles, label and access to every page', async () => {
    const admin = await loginAs('admin');
    const res = await api().get(`${P}/auth/me`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.data.user).toMatchObject({ id: String(admin.userId), email: admin.email, roles: ['admin'], roleLabels: { admin: 'Admin' } });
    expect(res.body.data.access['/masters']).toBe('editor');
    expect(res.body.data.access['/admin']).toBe('editor');
  });

  it('operations-executive: Masters view-only, no Users & Roles', async () => {
    const exec = await loginAs('operations-executive');
    const res = await api().get(`${P}/auth/me`).set('Cookie', exec.cookie).expect(200);
    expect(res.body.data.access['/masters/pep-skus']).toBe('viewer');
    expect(res.body.data.access['/admin']).toBe('none');
  });

  it('an inactive user is refused even with a valid session', async () => {
    const u = await loginAs('admin', { status: USER_STATUS.INACTIVE });
    expect((await api().get(`${P}/auth/me`).set('Cookie', u.cookie)).status).toBe(401);
  });
});

describe('logout', () => {
  it('ends the session (cookie no longer works) and writes a logout history row', async () => {
    const u = await loginAs('developer');
    await api().post(`${P}/auth/logout`).set('Cookie', u.cookie).expect(204);
    expect((await api().get(`${P}/auth/me`).set('Cookie', u.cookie)).status).toBe(401);
    const events = await rows<{ event: string }>('SELECT event FROM session_history WHERE user_id = ? ORDER BY id', [u.userId]);
    expect(events.map((e) => e.event)).toEqual(['login', 'logout']);
  });

  it('401 when not logged in', async () => {
    expect((await api().post(`${P}/auth/logout`)).status).toBe(401);
  });
});

describe('after a successful sign-in (2026-11-24, portal-only people)', () => {
  const signIn = async (email: string, app?: string) => {
    google.email = email;
    return api().get(`${P}/auth/google/callback?state=s&code=c`).set('Cookie', `${AUTH.STATE_COOKIE}=s${app ? `; ${AUTH.APP_COOKIE}=${app}` : ''}`).expect(302);
  };
  it('a person with bulk roles only lands on the Bulk Orders portal even when they started on POST_FG; others on POST_FG', async () => {
    const bulk = await loginAs('bulk-marketing');
    const res = await signIn(bulk.email);
    expect(res.headers.location).toBe('http://localhost:5174');
    expect(String(res.headers['set-cookie'])).toContain(`${AUTH.SESSION_COOKIE}=`);
    const ops = await loginAs('operations-executive');
    expect((await signIn(ops.email)).headers.location).toBe('http://localhost:5173');
    expect((await signIn(ops.email, AUTH.APP_BULK)).headers.location).toBe('http://localhost:5174'); // started on the portal
  });
});
