import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * Users & Roles (2026-10-28): admin / developer only. Adding a person sends a welcome email: the sender is replaced
 * by a recorder (nothing is sent; a test can make it fail). A change to someone's roles / status, or to a role's page
 * access, must take effect at once (the 30 s login caches are cleared), and nobody can lock themselves out.
 */
covers([
  'GET /admin/users', 'GET /admin/users/options', 'POST /admin/users', 'PATCH /admin/users/:id', 'POST /admin/users/:id/welcome-email',
  'GET /admin/roles', 'GET /admin/roles/pages', 'PATCH /admin/roles/:key',
]);

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string; html: string }[], fail: false }));
vi.mock('../../src/modules/mail/mailer.service', async (orig) => ({
  ...(await orig<object>()),
  sendMail: vi.fn(async (m: { to: string; subject: string; text: string; html: string }) => {
    if (mail.fail) throw Object.assign(new Error('Gmail said no (test)'), { code: 'MAIL_SEND_FAILED', final: true });
    mail.sent.push(m);
  }),
}));

const V = '/api/v1/admin';
let admin: TestLogin;
let m: Masters;
const addUser = (body: object) => api().post(`${V}/users`).set('Cookie', admin.cookie).send(body);

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  admin = await loginAs('admin');
  mail.sent.length = 0;
  mail.fail = false;
});
afterAll(closeDb);

describe('who may manage users and roles', () => {
  it('401 without a login; 403 for anyone but admin / developer (even an Operations Manager)', async () => {
    expect((await api().get(`${V}/users`)).status).toBe(401);
    const manager = await loginAs('operations-manager');
    for (const res of await Promise.all([
      api().get(`${V}/users`).set('Cookie', manager.cookie), api().get(`${V}/roles`).set('Cookie', manager.cookie),
      api().post(`${V}/users`).set('Cookie', manager.cookie).send({ email: 'x@mcaffeine.com', roles: ['viewer'] }),
      api().patch(`${V}/roles/viewer`).set('Cookie', manager.cookie).send({ grants: { '/masters': 'editor' } }),
    ])) expect(res.status).toBe(403);
    expect(await count('users', "email = 'x@mcaffeine.com'")).toBe(0);
  });
});

describe('users', () => {
  it('lists people and the form options (roles, teams, warehouses)', async () => {
    const users = await api().get(`${V}/users`).set('Cookie', admin.cookie).expect(200);
    expect(users.body.data.map((u: { email: string }) => u.email)).toContain(admin.email);
    const opts = await api().get(`${V}/users/options`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(opts.body.data)).toContain('operations-executive');
    expect(JSON.stringify(opts.body.data)).toContain(m.facilityCode);
  });

  it('adds a person with roles, team and warehouses, and sends the welcome email with the app link and their pages', async () => {
    const res = await addUser({ email: 'New.Person@mcaffeine.com', roles: ['operations-executive'], team: 'warehouse', facilities: [m.facilityCode] });
    expect(res.status).toBeLessThan(300);
    expect(res.body.data).toMatchObject({ email: 'new.person@mcaffeine.com', roles: ['operations-executive'], team: 'warehouse', facilities: [m.facilityCode] });
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
    expect(mail.sent[0].to).toBe('new.person@mcaffeine.com');
    expect(mail.sent[0].text).toContain('http://localhost:5173');
    expect(mail.sent[0].text).toContain('Operations Executive');
    expect(mail.sent[0].text).toContain('B2B/B2C Operations › PO Processing & Review (can edit)');
    expect(mail.sent[0].text).toContain('Masters › PEP SKU Master (view only)');
    expect(mail.sent[0].text).not.toContain('Users & Roles');
    await vi.waitFor(async () => expect(await count('users', "email = 'new.person@mcaffeine.com' AND welcome_sent_at IS NOT NULL")).toBe(1));
    const [a] = await rows<{ path: string }>("SELECT path FROM activity_log WHERE method = 'AUDIT' ORDER BY id DESC LIMIT 1");
    expect(a.path).toContain('users: added new.person@mcaffeine.com');
  });

  it('sendEmail: false adds without an email', async () => {
    await addUser({ email: 'quiet@mcaffeine.com', roles: ['viewer'], sendEmail: false }).expect((r) => expect(r.status).toBeLessThan(300));
    await new Promise((r) => setTimeout(r, 300));
    expect(mail.sent).toEqual([]);
  });

  it('refuses another domain, a duplicate, an unknown role or warehouse; nothing added', async () => {
    expect((await addUser({ email: 'someone@gmail.com', roles: ['viewer'] })).body.error.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    expect((await addUser({ email: admin.email, roles: ['viewer'] })).body.error.code).toBe('USER_EXISTS');
    expect((await addUser({ email: 'a1@mcaffeine.com', roles: ['superuser'] })).body.error.code).toBe('ROLE_NOT_FOUND');
    expect((await addUser({ email: 'a2@mcaffeine.com', roles: ['viewer'], facilities: ['NO_WH'] })).body.error.code).toBe('FACILITY_NOT_FOUND');
    expect(await count('users', "email IN ('someone@gmail.com', 'a1@mcaffeine.com', 'a2@mcaffeine.com')")).toBe(0);
    expect(mail.sent).toEqual([]);
  });

  it('a failed welcome email is recorded; "send again" works', async () => {
    mail.fail = true;
    const res = await addUser({ email: 'later@mcaffeine.com', roles: ['viewer'] });
    const id = res.body.data.id;
    await vi.waitFor(async () => expect(await count('users', 'id = ? AND welcome_error IS NOT NULL', [id])).toBe(1));
    mail.fail = false;
    const again = await api().post(`${V}/users/${id}/welcome-email`).set('Cookie', admin.cookie).expect(200);
    expect(again.body.data).toMatchObject({ sent: true, error: null });
    expect(mail.sent.map((x) => x.to)).toEqual(['later@mcaffeine.com']);
  });

  it('new roles apply at once (no waiting for the login cache)', async () => {
    const person = await loginAs('viewer');
    expect((await api().get('/api/v1/auth/me').set('Cookie', person.cookie).expect(200)).body.data.access['/operations/po-review']).toBe('viewer');
    await api().patch(`${V}/users/${person.userId}`).set('Cookie', admin.cookie).send({ roles: ['operations-executive'] }).expect(200);
    expect((await api().get('/api/v1/auth/me').set('Cookie', person.cookie).expect(200)).body.data.access['/operations/po-review']).toBe('editor');
  });

  it('switched off: their open session stops working at once; switched on again: it works', async () => {
    const person = await loginAs('viewer');
    await api().patch(`${V}/users/${person.userId}`).set('Cookie', admin.cookie).send({ status: 'inactive' }).expect(200);
    expect((await api().get('/api/v1/auth/me').set('Cookie', person.cookie)).status).toBe(401);
    await api().patch(`${V}/users/${person.userId}`).set('Cookie', admin.cookie).send({ status: 'active' }).expect(200);
    expect((await api().get('/api/v1/auth/me').set('Cookie', person.cookie)).status).toBe(200);
  });

  it('nobody can switch themselves off or drop their own admin role; unknown id -> 404', async () => {
    expect((await api().patch(`${V}/users/${admin.userId}`).set('Cookie', admin.cookie).send({ status: 'inactive' })).body.error.code).toBe('CANNOT_CHANGE_OWN_ACCESS');
    expect((await api().patch(`${V}/users/${admin.userId}`).set('Cookie', admin.cookie).send({ roles: ['viewer'] })).body.error.code).toBe('CANNOT_CHANGE_OWN_ACCESS');
    expect((await api().patch(`${V}/users/999999`).set('Cookie', admin.cookie).send({ name: 'x' })).status).toBe(404);
    expect((await api().get('/api/v1/auth/me').set('Cookie', admin.cookie)).body.data.user.roles).toEqual(['admin']);
  });
});

describe('roles', () => {
  it('lists the fixed roles with their page access and the pages', async () => {
    const res = await api().get(`${V}/roles`).set('Cookie', admin.cookie).expect(200);
    expect(res.body.data.map((r: { key: string }) => r.key).sort()).toEqual(['admin', 'demand-planner', 'developer', 'operations-executive', 'operations-manager', 'viewer']);
    const pages = await api().get(`${V}/roles/pages`).set('Cookie', admin.cookie).expect(200);
    expect(JSON.stringify(pages.body.data)).toContain('/masters/pep-skus');
  });

  it("changing a role's page access applies to its people at once", async () => {
    const exec = await loginAs('operations-executive');
    await api().get('/api/v1/masters/pep-skus').set('Cookie', exec.cookie).expect(200);
    await api().patch(`${V}/roles/operations-executive`).set('Cookie', admin.cookie).send({ grants: { '/masters': 'none', '/masters/pep-skus': 'none' } }).expect(200);
    expect((await api().get('/api/v1/masters/pep-skus').set('Cookie', exec.cookie)).status).toBe(403);
  });

  it('admin / developer cannot be changed; unknown role or access value refused', async () => {
    expect((await api().patch(`${V}/roles/admin`).set('Cookie', admin.cookie).send({ grants: { '/admin': 'none' } })).body.error.code).toBe('ROLE_IS_SYSTEM');
    expect((await api().patch(`${V}/roles/nope`).set('Cookie', admin.cookie).send({ grants: {} })).body.error.code).toBe('ROLE_NOT_FOUND');
    expect((await api().patch(`${V}/roles/viewer`).set('Cookie', admin.cookie).send({ grants: { '/masters': 'owner' } })).status).toBe(400);
  });
});
