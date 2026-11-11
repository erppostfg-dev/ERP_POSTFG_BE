import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearNoticeCache } from '../../src/modules/notices/notices.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { covers } from '../helpers/routes';

/*
 * Notices (2026-11-10): one-way notes in the bell, kept 2 days. Everyone sends to ONE person; admin / developer also to
 * everyone (ONE row); reply goes to the sender only (not to an "everyone" notice); seen = one row per person; the
 * admin switch; 20 a day; notices older than 2 days are never shown and are deleted.
 */
covers(['GET /notices', 'POST /notices', 'POST /notices/seen', 'GET /notices/people', 'GET /notices/settings', 'PUT /notices/settings']);

const V = '/api/v1/notices';
let admin: TestLogin;
let a: TestLogin;
let b: TestLogin;

const bell = async (who: TestLogin) => (await api().get(V).set('Cookie', who.cookie).expect(200)).body.data as {
  enabled: boolean; canSendEveryone: boolean; unread: number;
  items: { id: string; text: string; sent: boolean; canReply: boolean; read: boolean; to: unknown; from: { id: number }; replyQuote: string | null; link: string | null }[];
};
const post = (who: TestLogin, body: Record<string, unknown>) => api().post(V).set('Cookie', who.cookie).send(body);

beforeEach(async () => {
  await resetDb();
  clearNoticeCache();
  admin = await loginAs('admin');
  a = await loginAs('viewer');
  b = await loginAs('viewer');
});
afterAll(closeDb);

describe('notices', () => {
  it('needs a login', async () => {
    await api().get(V).expect(401);
    await api().post(V).send({ to: 1, text: 'x' }).expect(401);
  });

  it('one person to one person: shows in their bell (unread), in my Sent, not in a third person\'s', async () => {
    const res = await post(a, { to: b.userId, text: '  Please check PO 123  ', link: '/operations/po-review?tab=processed' }).expect(201);
    expect(res.body.data.items[0]).toMatchObject({ text: 'Please check PO 123', sent: true, read: true, canReply: false });
    const mine = await bell(b);
    expect(mine.unread).toBe(1);
    expect(mine.items[0]).toMatchObject({ text: 'Please check PO 123', sent: false, read: false, canReply: true, link: '/operations/po-review?tab=processed' });
    expect(mine.items[0].from.id).toBe(a.userId);
    expect((await bell(admin)).items).toHaveLength(0);
  });

  it('everyone: admin / developer only, ONE row, every other person sees it, nobody can reply', async () => {
    await post(a, { to: 'everyone', text: 'hi all' }).expect(403);
    const dev = await loginAs('developer');
    await post(dev, { to: 'everyone', text: 'deploy at 6 pm' }).expect(201);
    expect(await count('notices')).toBe(1);
    for (const who of [a, b, admin]) {
      const mine = await bell(who);
      expect(mine.unread).toBe(1);
      expect(mine.items[0]).toMatchObject({ text: 'deploy at 6 pm', to: 'everyone', canReply: false });
    }
    expect((await bell(admin)).canSendEveryone).toBe(true);
    expect((await bell(a)).canSendEveryone).toBe(false);
    const id = (await bell(a)).items[0].id;
    await post(a, { replyToId: id, text: 'ok' }).expect(400);
  });

  it('reply goes to the sender only and quotes the start of the notice', async () => {
    await post(a, { to: b.userId, text: 'Can you verify the Blinkit POs today?' }).expect(201);
    const id = (await bell(b)).items[0].id;
    await post(b, { replyToId: id, text: 'done', to: admin.userId }).expect(201);
    const back = (await bell(a)).items.find((i) => !i.sent)!;
    expect(back).toMatchObject({ text: 'done', replyQuote: 'Can you verify the Blinkit POs today?', canReply: true });
    expect((await bell(admin)).items).toHaveLength(0);
    // my own notice: no reply
    await post(a, { replyToId: id, text: 'again' }).expect(400);
  });

  it('seen: opening the bell reads everything so far (one row per person); a newer one is unread again', async () => {
    await post(a, { to: b.userId, text: 'one' }).expect(201);
    await post(a, { to: b.userId, text: 'two' }).expect(201);
    expect((await bell(b)).unread).toBe(2);
    const after = (await api().post(`${V}/seen`).set('Cookie', b.cookie).send({}).expect(200)).body.data;
    expect(after.unread).toBe(0);
    await api().post(`${V}/seen`).set('Cookie', b.cookie).send({}).expect(200);
    expect(await count('notice_seen')).toBe(1);
    await post(a, { to: b.userId, text: 'three' }).expect(201);
    expect((await bell(b)).unread).toBe(1);
  });

  it('checks the fields together with the rules', async () => {
    await post(a, { to: b.userId, text: '   ' }).expect(400);
    await post(a, { to: b.userId, text: 'x'.repeat(501) }).expect(400);
    await post(a, { to: a.userId, text: 'me' }).expect(400);
    await post(a, { to: 999999, text: 'nobody' }).expect(400);
    const off = await loginAs('viewer', { status: 'inactive' });
    await post(a, { to: off.userId, text: 'gone' }).expect(400);
    await post(a, { to: b.userId, text: 'x', link: 'https://evil.example' }).expect(400);
    await post(a, { to: b.userId, text: 'x', link: '//evil.example' }).expect(400);
    await post(a, { replyToId: 'abc', text: 'x' }).expect(400);
    expect(await count('notices')).toBe(0);
  });

  it('at most 20 in 24 hours per person (429)', async () => {
    for (let i = 0; i < 20; i += 1) await insert('notices', { from_user_id: a.userId, to_user_id: b.userId, text: `n${i}` });
    const res = await post(a, { to: b.userId, text: 'one more' }).expect(429);
    expect(res.body.error.code).toBe('NOTICE_DAILY_LIMIT');
    await post(b, { to: a.userId, text: 'b is fine' }).expect(201);
  });

  it('older than 2 days: never shown, deleted on the next send', async () => {
    await insert('notices', { from_user_id: a.userId, to_user_id: b.userId, text: 'old', created_at: new Date(Date.now() - 49 * 3600_000) });
    expect((await bell(b)).items).toHaveLength(0);
    await post(a, { to: b.userId, text: 'new' }).expect(201);
    expect((await rows<{ text: string }>('SELECT text FROM notices')).map((r) => r.text)).toEqual(['new']);
  });

  it('people: active people, not me', async () => {
    const people = (await api().get(`${V}/people`).set('Cookie', a.cookie).expect(200)).body.data as { id: number }[];
    expect(people.map((p) => p.id)).toEqual(expect.arrayContaining([b.userId, admin.userId]));
    expect(people.map((p) => p.id)).not.toContain(a.userId);
  });

  it('admin switch: admin / developer only; OFF = no sends (409) and an empty bell; ON again shows them', async () => {
    await post(a, { to: b.userId, text: 'before' }).expect(201);
    await api().get(`${V}/settings`).set('Cookie', a.cookie).expect(403);
    await api().put(`${V}/settings`).set('Cookie', a.cookie).send({ enabled: false }).expect(403);
    await api().put(`${V}/settings`).set('Cookie', admin.cookie).send({ enabled: 'no' }).expect(400);
    expect((await api().get(`${V}/settings`).set('Cookie', admin.cookie).expect(200)).body.data).toEqual({ enabled: true });
    await api().put(`${V}/settings`).set('Cookie', admin.cookie).send({ enabled: false }).expect(200);
    const res = await post(a, { to: b.userId, text: 'blocked' }).expect(409);
    expect(res.body.error.code).toBe('NOTICES_OFF');
    expect(await bell(b)).toMatchObject({ enabled: false, unread: 0, items: [] });
    await api().put(`${V}/settings`).set('Cookie', admin.cookie).send({ enabled: true }).expect(200);
    expect((await bell(b)).items.map((i) => i.text)).toEqual(['before']);
  });
});
