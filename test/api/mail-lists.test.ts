import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recipientsFor, sendToList } from '../../src/modules/mail/mail-lists.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Users & Roles -> Email (2026-10-30): who gets each mail the ERP sends. Admin / developer only. Any address, To / CC /
 * BCC, paused without being removed, a whole mail switched off; every change is in the mail's history. The sender is
 * replaced by a recorder (nothing is sent).
 */
covers([
  'GET /admin/mail-lists', 'PUT /admin/mail-lists/:key', 'POST /admin/mail-lists/:key/recipients',
  'PATCH /admin/mail-lists/:key/recipients/:id', 'DELETE /admin/mail-lists/:key/recipients/:id',
  'GET /admin/mail-lists/:key/history', 'POST /admin/mail-lists/:key/test',
]);

type Sent = { to: string | string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ sent: [] as Sent[] }));
vi.mock('../../src/modules/mail/mailer.service', async (orig) => ({
  ...(await orig<object>()),
  sendMail: vi.fn(async (m: Sent) => {
    mail.sent.push(m);
  }),
}));

const V = '/api/v1/admin/mail-lists';
const DAILY = 'intransit-daily';
let admin: TestLogin;

type List = { key: string; enabled: boolean; recipients: { id: number; email: string; kind: string; paused: boolean }[] };
const lists = async (): Promise<List[]> => (await api().get(V).set('Cookie', admin.cookie).expect(200)).body.data as List[];
const add = (email: string, kind?: string, key = DAILY) => api().post(`${V}/${key}/recipients`).set('Cookie', admin.cookie).send({ email, ...(kind ? { kind } : {}) });
const idOf = async (email: string, key = DAILY): Promise<number> => (await lists()).find((l) => l.key === key)!.recipients.find((r) => r.email === email)!.id;

beforeEach(async () => {
  await resetDb();
  admin = await loginAs('admin');
  mail.sent.length = 0;
});
afterAll(closeDb);

describe('who may manage the mailing lists', () => {
  it('401 without a login; 403 for anyone but admin / developer', async () => {
    expect((await api().get(V)).status).toBe(401);
    const manager = await loginAs('operations-manager');
    for (const res of await Promise.all([
      api().get(V).set('Cookie', manager.cookie),
      api().post(`${V}/${DAILY}/recipients`).set('Cookie', manager.cookie).send({ email: 'x@example.com' }),
      api().post(`${V}/${DAILY}/test`).set('Cookie', manager.cookie).send({ onlyMe: true }),
    ])) expect(res.status).toBe(403);
    expect(await count('mail_recipients')).toBe(0);
  });
});

describe('mailing lists', () => {
  it('lists every mail of the catalog, on and empty to start with', async () => {
    const all = await lists();
    expect(all.map((l) => l.key)).toEqual(expect.arrayContaining([DAILY, 'intransit-fetch-failure']));
    expect(all.every((l) => l.enabled && l.recipients.length === 0)).toBe(true);
  });

  it('adds any address (lower-cased), To by default; refuses a duplicate, a bad address, a bad kind, an unknown mail', async () => {
    await add('Planning@Partner.example.com').expect(200);
    await add('boss@mcaffeine.com', 'cc').expect(200);
    const daily = (await lists()).find((l) => l.key === DAILY)!;
    expect(daily.recipients.map((r) => [r.email, r.kind])).toEqual([['planning@partner.example.com', 'to'], ['boss@mcaffeine.com', 'cc']]);
    expect((await add('planning@partner.example.com')).body.error.code).toBe('MAIL_RECIPIENT_EXISTS');
    expect((await add('not-an-address')).body.error.code).toBe('MAIL_ADDRESS_INVALID');
    expect((await add('a@b.com', 'reply-to')).status).toBe(400);
    expect((await add('a@b.com', 'to', 'no-such-mail')).body.error.code).toBe('MAIL_LIST_UNKNOWN');
  });

  it('changes To/CC/BCC, pauses and removes; paused people and a switched-off mail get nothing', async () => {
    await add('a@example.com').expect(200);
    await add('b@example.com', 'bcc').expect(200);
    const a = await idOf('a@example.com');
    await api().patch(`${V}/${DAILY}/recipients/${a}`).set('Cookie', admin.cookie).send({ kind: 'cc' }).expect(200);
    expect(await recipientsFor(DAILY)).toEqual({ to: [], cc: ['a@example.com'], bcc: ['b@example.com'] });

    await api().patch(`${V}/${DAILY}/recipients/${a}`).set('Cookie', admin.cookie).send({ paused: true }).expect(200);
    expect(await recipientsFor(DAILY)).toEqual({ to: [], cc: [], bcc: ['b@example.com'] });

    await api().put(`${V}/${DAILY}`).set('Cookie', admin.cookie).send({ enabled: false }).expect(200);
    expect(await sendToList(DAILY, { subject: 's', text: 't', html: '<p>t</p>' })).toBeNull();
    expect(mail.sent).toHaveLength(0);
    await api().put(`${V}/${DAILY}`).set('Cookie', admin.cookie).send({ enabled: true }).expect(200);

    const b = await idOf('b@example.com');
    await api().delete(`${V}/${DAILY}/recipients/${b}`).set('Cookie', admin.cookie).expect(200);
    expect(await count('mail_recipients')).toBe(1);
    expect((await api().delete(`${V}/${DAILY}/recipients/${b}`).set('Cookie', admin.cookie)).body.error.code).toBe('MAIL_RECIPIENT_NOT_FOUND');
  });

  it('keeps every change in the mail history, newest first, with who', async () => {
    await add('a@example.com').expect(200);
    await api().patch(`${V}/${DAILY}/recipients/${await idOf('a@example.com')}`).set('Cookie', admin.cookie).send({ paused: true }).expect(200);
    const history = (await api().get(`${V}/${DAILY}/history`).set('Cookie', admin.cookie).expect(200)).body.data as { by: string; what: string }[];
    expect(history.map((h) => h.what)).toEqual(['paused a@example.com', 'added a@example.com as TO']);
    expect(history[0].by).toBeTruthy();
    expect(await rows("SELECT path FROM activity_log WHERE method = 'AUDIT' AND path LIKE 'mail-list:intransit-daily %'")).toHaveLength(2);
  });
});

describe('send test', () => {
  it('to me: one [Test] mail to the signed-in admin only', async () => {
    await add('a@example.com').expect(200);
    const res = await api().post(`${V}/${DAILY}/test`).set('Cookie', admin.cookie).send({ onlyMe: true }).expect(200);
    expect(res.body.data.to).toEqual([admin.email]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(admin.email);
    expect(mail.sent[0].subject).toMatch(/^\[Test\] /);
  });

  it('to the list: its active To / CC / BCC; refused when nobody is active', async () => {
    expect((await api().post(`${V}/${DAILY}/test`).set('Cookie', admin.cookie).send({ onlyMe: false })).body.error.code).toBe('MAIL_LIST_EMPTY');
    await add('a@example.com').expect(200);
    await add('b@example.com', 'cc').expect(200);
    await api().post(`${V}/${DAILY}/test`).set('Cookie', admin.cookie).send({ onlyMe: false }).expect(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: ['a@example.com'], cc: ['b@example.com'], bcc: [] });
  });
});
