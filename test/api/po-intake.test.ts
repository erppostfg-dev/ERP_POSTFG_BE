import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * PO intake (2026-10-28): Users & Roles -> Settings -> PO intake (switch per channel, daily limit, process from,
 * universal process from) and the email webhook every PO email goes through.
 * The one-time catch-ups a switch starts (Gmail for email channels, Amazon SP-API for amazon) are replaced by
 * recorders: the tests check WHAT was asked (channel + date), nothing calls Gmail or Amazon.
 */
covers(['GET /admin/po-intake', 'PATCH /admin/po-intake/:channel', 'PATCH /admin/po-intake/universal', 'POST /po-intake/email']);

const calls = vi.hoisted(() => ({ backfill: [] as [string, string][], rewind: [] as [string, string][], runNow: [] as string[] }));
// the Gmail catch-up itself (a saved row + one pass) is tested in test/flows/gmail-intake.test.ts
vi.mock('../../src/modules/email-intake/catchup.service', async (orig) => ({
  ...(await orig<object>()),
  requestCatchUp: vi.fn(async (channel: string, after: Date) => { calls.backfill.push([channel, after.toISOString()]); }),
}));
vi.mock('../../src/modules/channel-api/runner', async (orig) => ({
  ...(await orig<object>()),
  rewindTo: vi.fn(async (channel: string, from: Date) => { calls.rewind.push([channel, from.toISOString()]); }),
}));
vi.mock('../../src/modules/channel-api/scheduler', async (orig) => ({
  ...(await orig<object>()),
  runChannelNow: vi.fn(async (channel: string) => { calls.runNow.push(channel); }),
}));

const V = '/api/v1';
const SECRET = 'test-webhook-secret';
let admin: TestLogin;

const setChannel = (channel: string, body: object) => api().patch(`${V}/admin/po-intake/${channel}`).set('Cookie', admin.cookie).send(body);
const channelRow = async (channel: string) =>
  (await rows<{ enabled: number; daily_limit: number | null; process_from: Date | null }>('SELECT enabled, daily_limit, process_from FROM channel_intake_settings WHERE channel = ?', [channel]))[0];

/** A BigBasket PO email as the Gmail label router sends it. */
let seq = 0;
const sendEmail = (o: { po?: string; from?: string; receivedAt?: string; messageId?: string; files?: boolean; secret?: string; label?: string | null } = {}) => {
  seq += 1;
  const po = o.po ?? `IRA9100000${seq}`;
  const req = api().post(`${V}/po-intake/email`).set('X-Webhook-Secret', o.secret ?? SECRET)
    .field('from', o.from ?? 'alerts@bigbasket.com')
    .field('subject', `Big Basket WMS-Test-FC PO Details: PO No ${po} Pep Technologies Pvt Ltd`)
    .field('messageId', o.messageId ?? `<intake-${seq}-${po}@bigbasket.com>`)
    .field('provider', 'gmail-pubsub')
    .field('receivedAt', o.receivedAt ?? '2026-10-27T05:00:00.000Z');
  if (o.label !== null) req.field('label', o.label ?? 'Po-Intake');
  if (o.files !== false) req.attach('files', Buffer.from('fake xlsx'), `${po.replace(/^IRA/, '')}.xlsx`);
  return req;
};
const uploadsOf = async (po: string) => rows<{ status: string }>('SELECT status FROM po_uploads WHERE po_number = ? OR email_subject LIKE ?', [po, `%${po}%`]);

beforeEach(async () => {
  await resetDb();
  await seedMasters();
  admin = await loginAs('admin');
  calls.backfill.length = 0;
  calls.rewind.length = 0;
  calls.runNow.length = 0;
});
afterAll(closeDb);

describe('who may change PO intake', () => {
  it('401 without a login; 403 for anyone but admin / developer', async () => {
    expect((await api().get(`${V}/admin/po-intake`)).status).toBe(401);
    const manager = await loginAs('operations-manager');
    expect((await api().get(`${V}/admin/po-intake`).set('Cookie', manager.cookie)).status).toBe(403);
    expect((await setChannel('bigbasket', { enabled: true }).set('Cookie', manager.cookie)).status).toBe(403);
    expect(await count('channel_intake_settings')).toBe(0);
  });
});

describe('switch per channel', () => {
  it('every channel starts OFF (nothing comes in until switched on)', async () => {
    const res = await api().get(`${V}/admin/po-intake`).set('Cookie', admin.cookie).expect(200);
    const channels = res.body.data.channels as { channel: string; enabled: boolean; source: string }[];
    expect(channels.find((c) => c.channel === 'bigbasket')).toMatchObject({ enabled: false, source: 'email' });
    expect(channels.find((c) => c.channel === 'amazon')).toMatchObject({ enabled: false, source: 'api' });
    expect(channels.every((c) => !c.enabled)).toBe(true);
  });

  it('refuses bad values all at once; unknown channel -> 404', async () => {
    const res = await setChannel('bigbasket', { enabled: 'yes', dailyLimit: 1.5, processFrom: 'yesterday' }).expect(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['dailyLimit', 'enabled', 'processFrom']);
    expect((await setChannel('nochannel', { enabled: true })).status).toBe(404);
  });

  it('switching ON with a start asks for that channel\'s catch-up from that date, once', async () => {
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-25T18:30:00.000Z' }).expect(200);
    expect(calls.backfill).toEqual([['bigbasket', '2026-10-25T18:30:00.000Z']]);
    expect(await channelRow('bigbasket')).toMatchObject({ enabled: 1 });
    // saving again with the same date: no second catch-up
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-25T18:30:00.000Z' }).expect(200);
    expect(calls.backfill).toHaveLength(1);
    // an earlier start while ON: catch-up again from the earlier date
    await setChannel('bigbasket', { processFrom: '2026-10-20T00:00:00.000Z' }).expect(200);
    expect(calls.backfill).toEqual([['bigbasket', '2026-10-25T18:30:00.000Z'], ['bigbasket', '2026-10-20T00:00:00.000Z']]);
  });

  it('switching ON without a start = from now (never the whole history)', async () => {
    const before = Date.now();
    await setChannel('bigbasket', { enabled: true }).expect(200);
    const from = (await channelRow('bigbasket')).process_from!;
    expect(new Date(from).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(calls.backfill).toHaveLength(1);
  });

  it('switching OFF or changing only the limit asks for no catch-up', async () => {
    await setChannel('bigbasket', { enabled: false }).expect(200);
    await setChannel('bigbasket', { dailyLimit: 5 }).expect(200);
    expect(calls.backfill).toEqual([]);
    expect(await channelRow('bigbasket')).toMatchObject({ enabled: 0, daily_limit: 5 });
  });

  it('Amazon ON: its check point goes back to the start and one run starts now (no Gmail)', async () => {
    await setChannel('amazon', { enabled: true, processFrom: '2026-10-26T00:00:00.000Z' }).expect(200);
    await vi.waitFor(() => expect(calls.runNow).toEqual(['amazon']));
    expect(calls.rewind).toEqual([['amazon', '2026-10-26T00:00:00.000Z']]);
    expect(calls.backfill).toEqual([]);
  });

  it('every change is in the activity log (who changed intake)', async () => {
    await setChannel('bigbasket', { enabled: true, dailyLimit: 3, processFrom: '2026-10-25T18:30:00.000Z' }).expect(200);
    const [a] = await rows<{ user_id: number; path: string }>("SELECT user_id, path FROM activity_log WHERE method = 'AUDIT' ORDER BY id DESC LIMIT 1");
    expect(a.user_id).toBe(admin.userId);
    expect(a.path).toContain('bigbasket ON, limit 3');
  });
});

describe('universal "process from"', () => {
  it('sets the date on every channel; only channels already ON (start moved earlier) catch up', async () => {
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-27T00:00:00.000Z' }).expect(200);
    calls.backfill.length = 0;
    const res = await api().patch(`${V}/admin/po-intake/universal`).set('Cookie', admin.cookie).send({ processFrom: '2026-10-25T18:31:00.000Z' }).expect(200);
    expect(res.body.data.universal.processFrom).toBe('2026-10-25T18:31:00.000Z');
    expect(res.body.data.channels.every((c: { processFrom: string }) => c.processFrom === '2026-10-25T18:31:00.000Z')).toBe(true);
    expect(calls.backfill).toEqual([['bigbasket', '2026-10-25T18:31:00.000Z']]);
    // the same date again (what happened on dev at 10:25 on 28 Oct): no catch-up
    await api().patch(`${V}/admin/po-intake/universal`).set('Cookie', admin.cookie).send({ processFrom: '2026-10-25T18:31:00.000Z' }).expect(200);
    expect(calls.backfill).toHaveLength(1);
  });

  it('processFrom is required (ISO date or null)', async () => {
    await api().patch(`${V}/admin/po-intake/universal`).set('Cookie', admin.cookie).send({}).expect(400);
    await api().patch(`${V}/admin/po-intake/universal`).set('Cookie', admin.cookie).send({ processFrom: 'soon' }).expect(400);
  });
});

describe('the email webhook', () => {
  it('needs the webhook secret', async () => {
    expect((await sendEmail({ secret: '' })).status).toBe(401);
    expect((await sendEmail({ secret: 'wrong-secret-of-same-len' })).status).toBe(401);
    expect(await count('intake_emails')).toBe(0);
  });

  it('refuses a manual call without files and a bad sender / date', async () => {
    expect((await sendEmail({ label: null, files: false })).status).toBe(400);
    const res = await sendEmail({ from: 'not-an-email', receivedAt: 'today' }).expect(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['from', 'receivedAt']);
  });

  it('channel OFF: the PO email is stored and HELD (no OCR); a repeat is a duplicate', async () => {
    const res = await sendEmail({ po: 'IRA91000100', messageId: '<same@bigbasket.com>' }).expect(202);
    expect(res.body.data).toMatchObject({ status: 'stored', channel: 'bigbasket', duplicate: false });
    expect((await uploadsOf('IRA91000100')).map((u) => u.status)).toEqual(['held']);
    const again = await sendEmail({ po: 'IRA91000100', messageId: '<same@bigbasket.com>' }).expect(202);
    expect(again.body.data).toMatchObject({ status: 'duplicate', duplicate: true });
    expect(await count('po_uploads')).toBe(1);
  });

  it('channel ON: queued for OCR; held POs of that channel are released when it is switched on', async () => {
    await sendEmail({ po: 'IRA91000200' }).expect(202);
    expect((await uploadsOf('IRA91000200')).map((u) => u.status)).toEqual(['held']);
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-25T00:00:00.000Z' }).expect(200);
    // released one by one in the background; OCR is off in tests, so it waits as queued
    await vi.waitFor(async () => expect((await uploadsOf('IRA91000200')).map((u) => u.status)).toEqual(['queued']), { timeout: 10_000 });
    await sendEmail({ po: 'IRA91000201' }).expect(202);
    expect((await uploadsOf('IRA91000201')).map((u) => u.status)).toEqual(['queued']);
  });

  it('received before the channel\'s start: stored as files only, no row', async () => {
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-26T00:00:00.000Z' }).expect(200);
    await sendEmail({ po: 'IRA91000300', receivedAt: '2026-10-20T00:00:00.000Z' }).expect(202);
    expect(await uploadsOf('IRA91000300')).toEqual([]);
  });

  it('a PO number POST_FG already HAS (saved / OCR done) is not taken again', async () => {
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-25T00:00:00.000Z' }).expect(200);
    await insert('po_uploads', { source: 'email', channel: 'BigBasket', po_number: 'IRA91000450', status: 'completed', ocr_status: 'success', email_message_id: '<old@bigbasket.com>' });
    await sendEmail({ po: 'IRA91000450', messageId: '<new@bigbasket.com>' }).expect(202);
    expect((await uploadsOf('IRA91000450')).map((u) => u.status)).toEqual(['completed']);
  });

  // KNOWN GAP (backlog 4ae, found by this test 2026-10-28): a PO waiting for OCR has no po_number yet, so the same PO
  // in a second email (re-send, or a catch-up overlapping a live email) is queued and OCR'd twice (validation then
  // flags DUPLICATE_PO: no second sale order, but double OCR cost). `it.fails` passes while the gap exists and FAILS
  // once it is fixed: then turn it into a normal `it`.
  it.fails('KNOWN GAP: the same PO in a second email while the first waits for OCR is queued again', async () => {
    await setChannel('bigbasket', { enabled: true, processFrom: '2026-10-25T00:00:00.000Z' }).expect(200);
    await sendEmail({ po: 'IRA91000400' }).expect(202);
    await sendEmail({ po: 'IRA91000400', messageId: '<other-mail@bigbasket.com>' }).expect(202);
    expect((await uploadsOf('IRA91000400')).map((u) => u.status)).toEqual(['queued']);
  });

  it('daily limit: over today\'s limit the next PO is held', async () => {
    await setChannel('bigbasket', { enabled: true, dailyLimit: 1, processFrom: '2026-10-25T00:00:00.000Z' }).expect(200);
    await sendEmail({ po: 'IRA91000500' }).expect(202);
    await sendEmail({ po: 'IRA91000501' }).expect(202);
    expect((await uploadsOf('IRA91000500')).map((u) => u.status)).toEqual(['queued']);
    expect((await uploadsOf('IRA91000501')).map((u) => u.status)).toEqual(['held']);
  });

  it('not a PO (unknown sender): sorted out with a reason, no po_uploads row', async () => {
    const res = await sendEmail({ from: 'someone@example.com' }).expect(202);
    expect(res.body.data.status).toBe('not_po');
    expect(res.body.data.notPoReason).toContain('someone@example.com');
    expect(await count('po_uploads')).toBe(0);
    expect(await count('intake_emails', "kind = 'not_po'")).toBe(1);
  });

  it('the email and its files are recorded (intake_emails)', async () => {
    await sendEmail({ po: 'IRA91000600' }).expect(202);
    expect(await count('intake_emails', "kind = 'po' AND channel = 'bigbasket'")).toBe(1);
  });
});
