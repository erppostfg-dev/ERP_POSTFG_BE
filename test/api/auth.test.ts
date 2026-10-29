import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, USER_STATUS } from '../../src/constants';
import { api, loginAs } from '../helpers/auth';
import { closeDb, count, db, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Login, session and health (2026-10-28). Google itself is never called: the sign-in redirect is checked by its URL,
 * the callback's refusal paths need no Google answer; sessions are made with the real session code (helpers/auth).
 */
covers(['GET /health', 'GET /auth/google', 'GET /auth/google/callback', 'GET /auth/me', 'POST /auth/logout']);

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
