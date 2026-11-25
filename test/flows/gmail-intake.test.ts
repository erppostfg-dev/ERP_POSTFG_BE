import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kickCatchUps, requestCatchUp, resumeCatchUps } from '../../src/modules/email-intake/catchup.service';
import { labelSafetyPass, processGmailChanges } from '../../src/modules/email-intake/label-router.service';
import { startSafetyNet } from '../../src/modules/email-intake/safety-net';
import { writeState } from '../../src/modules/email-intake/gmail-watch.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';

/*
 * Gmail intake load (2026-10-29, backlog B1): a fake mailbox counts every Gmail call.
 *   - catch-ups of several channels = one pass; every email looked at once (headers), only the taken ones downloaded;
 *   - an email once read is never read again (gmail_messages): a later catch-up of its channel needs no headers call;
 *   - Pub/Sub reads the whole email at once and remembers emails of OFF channels for their catch-up;
 *   - a rate limit (429) waits and retries; a failed catch-up is saved as failed and tried again by itself.
 * The intake POST (our own endpoint) is a recorder.
 */

const LABEL = { label: 'Po-Intake', endpoint: '/po-intake/email', labelId: 'L_INTAKE' };
vi.mock('../../src/modules/email-intake/gmail-watch.service', async (orig) => ({
  ...(await orig<object>()),
  resolveRoutes: vi.fn(async () => [LABEL]),
}));

interface FakeEmail { id: string; from: string; subject: string; at: string }
const box = vi.hoisted(() => ({
  emails: [] as { id: string; from: string; subject: string; at: string }[],
  history: [] as string[],
  calls: { list: 0, meta: 0, full: 0, history: 0 },
  fail: { meta429: 0, list403: 0 },
}));
const gmailError = (status: number, reason: string) =>
  Object.assign(new Error(reason), { response: { status, headers: {}, data: { error: { errors: [{ reason }] } } } });
const fake = {
  users: {
    messages: {
      list: async ({ q }: { q?: string }) => {
        box.calls.list++;
        if (box.fail.list403 > 0) { box.fail.list403--; throw gmailError(403, 'insufficientPermissions'); }
        const after = q ? Number(/after:(\d+)/.exec(q)?.[1]) * 1000 : 0;
        // Gmail lists newest first
        return { data: { messages: box.emails.filter((e) => Date.parse(e.at) > after).map((e) => ({ id: e.id })).reverse() } };
      },
      get: async ({ id, format }: { id: string; format: string }) => {
        if (format === 'metadata') {
          box.calls.meta++;
          if (box.fail.meta429 > 0) { box.fail.meta429--; throw gmailError(429, 'rateLimitExceeded'); }
        } else box.calls.full++;
        const e = box.emails.find((x) => x.id === id)!;
        const headers = [{ name: 'From', value: e.from }, { name: 'Subject', value: e.subject }, { name: 'Message-ID', value: `<${e.id}@test>` }];
        return { data: { id, labelIds: [LABEL.labelId], internalDate: String(Date.parse(e.at)), payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from('PO').toString('base64url') } } } };
      },
      attachments: { get: async () => ({ data: {} }) },
    },
    history: {
      list: async () => {
        box.calls.history++;
        return { data: { historyId: '200', history: box.history.map((id) => ({ messagesAdded: [{ message: { id, labelIds: [LABEL.labelId] } }] })) } };
      },
    },
    getProfile: async () => ({ data: { historyId: '200' } }),
  },
};
vi.mock('../../src/modules/email-intake/gmail.client', async (orig) => ({ ...(await orig<object>()), getGmail: () => fake }));

const posted: string[] = [];
const bb = (n: number, at: string): FakeEmail => ({ id: `bb${n}`, from: 'alerts@bigbasket.com', subject: `Big Basket Mumbai PO Details: PO No IRA${9000 + n} mCaffeine`, at });
const zepto = (n: number, at: string): FakeEmail => ({ id: `ze${n}`, from: 'po_fulfilment@zeptonow.com', subject: `Purchase Order for [Kiranakart and P${7000 + n}]`, at });
const fc = (n: number, at: string): FakeEmail => ({ id: `fc${n}`, from: 'noreply@firstcry.com', subject: `Brainbees PONO pin${100000000 + n}ABCDEFG for PEP`, at });

let admin: TestLogin;
/** Channels whose catch-up a switch asked for, with their row's requested time before the switch (settle waits for them). */
const asked = new Map<string, number>();
const switchOn = async (channel: string, processFrom: string) => {
  const before = await catchUp(channel);
  asked.set(channel, before ? new Date(before.requested_at as string).getTime() : 0);
  return api().patch(`/api/v1/admin/po-intake/${channel}`).set('Cookie', admin.cookie).send({ enabled: true, processFrom }).expect(200);
};
/**
 * Lets every catch-up asked so far finish: the switch API saves the request in the background (not awaited), so wait
 * until every switched channel's NEW request row is there (a slow CI run saved it after the old 3-tick wait: flake
 * 2026-11-17) and none is running or due (a failed one with a later retry time counts as finished here).
 */
const settle = async () => {
  for (let i = 0; i < 250; i++) {
    await kickCatchUps();
    await new Promise((r) => setTimeout(r, 20));
    let saved = true;
    for (const [channel, before] of asked) {
      const row = await catchUp(channel);
      if (!row || new Date(row.requested_at as string).getTime() <= before) saved = false;
    }
    const open = await count('intake_catchups', "status = 'running' OR (status IN ('waiting', 'failed') AND next_try_at <= NOW(6))");
    if (saved && !open && i > 1) {
      asked.clear();
      return;
    }
  }
  throw new Error('catch-ups did not settle');
};
const catchUp = async (channel: string) => (await rows<Record<string, unknown>>('SELECT * FROM intake_catchups WHERE channel = ?', [channel]))[0];

beforeEach(async () => {
  await resetDb();
  admin = await loginAs('admin');
  box.emails = [
    bb(1, '2026-10-26T05:00:00Z'), fc(1, '2026-10-26T06:00:00Z'), zepto(1, '2026-10-26T07:00:00Z'), bb(2, '2026-10-27T05:00:00Z'),
    fc(2, '2026-10-27T06:00:00Z'), zepto(2, '2026-10-27T07:00:00Z'), bb(3, '2026-10-28T05:00:00Z'), fc(3, '2026-10-28T06:00:00Z'),
  ];
  box.history = [];
  box.calls = { list: 0, meta: 0, full: 0, history: 0 };
  box.fail = { meta429: 0, list403: 0 };
  posted.length = 0;
  asked.clear();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: FormData }) => {
    posted.push(init.body.get('gmailId') as string);
    return new Response('{"data":{}}', { status: 201 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

describe('catch-ups: one pass, each email read once', () => {
  it('two channels switched on together: one list, every email looked at once, only theirs downloaded', async () => {
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await switchOn('zepto', '2026-10-25T00:00:00Z');
    await settle();
    expect(posted.sort()).toEqual(['bb1', 'bb2', 'bb3', 'ze1', 'ze2']);
    // each email's headers once at most (the 2nd channel's request may be its own pass: then known emails are skipped)
    expect(box.calls.meta).toBe(8);
    expect(box.calls.full).toBe(5);
    expect(await catchUp('bigbasket')).toMatchObject({ status: 'done', sent: 3, attempts: 0 });
    expect(await catchUp('zepto')).toMatchObject({ status: 'done', sent: 2 });
    // FirstCry (OFF) is remembered, not taken
    expect(await count('gmail_messages', "channel = 'firstcry' AND done_at IS NULL")).toBe(3);
    expect(await count('gmail_messages', 'done_at IS NOT NULL')).toBe(5);

    // FirstCry on later: its 3 emails come from the DB, no headers call; only the list + their downloads
    const before = { ...box.calls };
    await switchOn('firstcry', '2026-10-25T00:00:00Z');
    await settle();
    expect(box.calls.meta - before.meta).toBe(0);
    expect(box.calls.full - before.full).toBe(3);
    expect(box.calls.list - before.list).toBe(1);
    await expect.poll(() => posted.filter((id) => id.startsWith('fc')).length, { timeout: 5000 }).toBe(3);
  });

  it('a channel whose start is later than an email leaves it in Gmail (read once); an earlier start takes it', async () => {
    await switchOn('bigbasket', '2026-10-27T00:00:00Z');
    await settle();
    expect(posted.sort()).toEqual(['bb2', 'bb3']);
    const meta = box.calls.meta;
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await settle();
    expect(posted.sort()).toEqual(['bb1', 'bb2', 'bb3']);
    // only the 3 emails of 26 Oct are new (the 1st pass started at 27 Oct); the 5 known ones need no call
    expect(box.calls.meta).toBe(meta + 3);
  });

  it('Pub/Sub reads the whole email at once; an OFF channel email is remembered for its catch-up', async () => {
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await settle();
    // the catch-up row can read done while its last posts are still on the way (slow CI): wait for all 3
    await expect.poll(() => posted.filter((id) => id.startsWith('bb')).sort(), { timeout: 5000 }).toEqual(['bb1', 'bb2', 'bb3']);
    box.emails.push(bb(4, '2026-10-29T05:00:00Z'), zepto(3, '2026-10-29T06:00:00Z'));
    box.history = ['bb4', 'ze3'];
    await writeState({ historyId: '100' });
    const before = { ...box.calls };
    posted.length = 0;
    await processGmailChanges([LABEL]);
    expect(posted).toEqual(['bb4']);
    expect(box.calls.meta - before.meta).toBe(0);
    expect(box.calls.full - before.full).toBe(2);
    expect(await count('gmail_messages', "gmail_id = 'ze3' AND channel = 'zepto' AND done_at IS NULL")).toBe(1);
  });
});

describe('rate limits and failures heal by themselves', () => {
  it('a 429 waits and tries again: nothing is skipped', async () => {
    box.fail.meta429 = 2;
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await settle();
    expect(posted.sort()).toEqual(['bb1', 'bb2', 'bb3']);
    expect(await catchUp('bigbasket')).toMatchObject({ status: 'done', attempts: 0 });
  });

  it('a failed catch-up is saved with its reason and a retry time, and runs again by itself', async () => {
    box.fail.list403 = 1;
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await settle();
    const failed = await catchUp('bigbasket');
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(String(failed.last_error)).toContain('ACCESS_DENIED');
    const wait = new Date(failed.next_try_at as string).getTime() - Date.now();
    expect(wait).toBeGreaterThan(60_000); // about 2 minutes
    // the PO intake page shows it
    const list = (await api().get('/api/v1/admin/po-intake').set('Cookie', admin.cookie).expect(200)).body.data.channels;
    expect(list.find((c: { channel: string }) => c.channel === 'bigbasket').catchUp).toMatchObject({ status: 'failed', attempts: 1 });
    expect(list.find((c: { channel: string }) => c.channel === 'amazon').catchUp).toBeNull();

    // its retry time comes: it runs by itself (here: the timer's run, called directly)
    await rows('UPDATE intake_catchups SET next_try_at = NOW(6) - INTERVAL 1 SECOND');
    await settle();
    expect(await catchUp('bigbasket')).toMatchObject({ status: 'done', attempts: 0, sent: 3, last_error: null });
  });

  it('a catch-up a stop left running runs again on start; a new request keeps the earlier unfinished start', async () => {
    await insert('channel_intake_settings', { channel: 'bigbasket', enabled: 1, process_from: new Date('2026-10-20T00:00:00Z'), updated_by: admin.userId, updated_at: new Date() });
    await insert('intake_catchups', { channel: 'bigbasket', from_at: new Date('2026-10-20T00:00:00Z'), status: 'running', attempts: 0, requested_at: new Date() });
    await resumeCatchUps();
    await settle();
    expect(await catchUp('bigbasket')).toMatchObject({ status: 'done', sent: 3 });

    await rows("UPDATE intake_catchups SET status = 'failed', attempts = 2, from_at = '2026-10-20', next_try_at = NOW(6) + INTERVAL 1 HOUR");
    box.fail.list403 = 1;
    await requestCatchUp('bigbasket', new Date('2026-10-26T00:00:00Z'));
    await settle();
    const row = await catchUp('bigbasket');
    expect(new Date(row.from_at as string).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(row).toMatchObject({ status: 'failed', attempts: 1 }); // asked again = counted from the start
  });
});

/*
 * Safety net for missed Pub/Sub notifications (2026-11-23): a notification that never reached this server (prod's
 * listener shared the subscription: Zepto P6336538 waited 2 h) must not leave its email waiting for the next one.
 * User: "no unnecessary Gmail calls, a delay is fine".
 */
describe('safety net: an email whose notification never came is still taken', () => {
  const MIN = 60_000;
  const recent = (minAgo: number) => new Date(Date.now() - minAgo * MIN).toISOString();

  it('label check: takes the email no one has taken; known and OFF-channel emails need no Gmail read the next time', async () => {
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await settle();
    await expect.poll(() => posted.filter((id) => id.startsWith('bb')).length, { timeout: 5000 }).toBe(3);
    // two emails whose notifications never came: BigBasket (ON) and Zepto (OFF)
    box.emails.push(bb(5, recent(60)), zepto(5, recent(50)));
    posted.length = 0;
    let before = { ...box.calls };
    expect(await labelSafetyPass([LABEL], 4 * 60 * MIN)).toBe(1);
    expect(posted).toEqual(['bb5']);
    expect(box.calls.list - before.list).toBe(1); // one list for the label (last 4 h only: the old emails are not looked at)
    expect(box.calls.full - before.full).toBe(2); // only the two unknown emails read
    expect(await count('gmail_messages', "gmail_id = 'ze5' AND channel = 'zepto' AND done_at IS NULL")).toBe(1);

    // the next check: nothing new -> one list, no read, nothing sent
    posted.length = 0;
    before = { ...box.calls };
    expect(await labelSafetyPass([LABEL], 4 * 60 * MIN)).toBe(0);
    expect(posted).toEqual([]);
    expect(box.calls.list - before.list).toBe(1);
    expect(box.calls.full + box.calls.meta - before.full - before.meta).toBe(0);
  });

  it('quiet check: no Gmail call while notifications keep coming; after 15 quiet minutes one history read takes the missed email', async () => {
    await switchOn('bigbasket', '2026-10-25T00:00:00Z');
    await settle();
    await expect.poll(() => posted.filter((id) => id.startsWith('bb')).length, { timeout: 5000 }).toBe(3);
    await writeState({ historyId: '100' });
    box.emails.push(bb(6, recent(5)));
    box.history = ['bb6']; // in the mailbox history, but its notification went elsewhere
    posted.length = 0;
    const jobs: (() => Promise<void>)[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const net = startSafetyNet([LABEL], (job) => jobs.push(job), { quietMs: 15 * MIN, labelMs: 0 });
      await vi.advanceTimersByTimeAsync(14 * MIN);
      expect(jobs).toHaveLength(0);
      net.markRead(); // a notification was handled at minute 14: quiet again from here
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(jobs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(6 * MIN); // 16 quiet minutes
      expect(jobs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5 * MIN); // the check itself counts as a read: not again at once
      expect(jobs).toHaveLength(1);
      net.stop();
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(jobs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    const before = { ...box.calls };
    await jobs[0]();
    expect(posted).toEqual(['bb6']);
    expect(box.calls.history - before.history).toBe(1);
    expect(box.calls.list - before.list).toBe(0);
  });

  it('label check runs every LABEL_CHECK_HOURS; 0 turns a check off', async () => {
    const jobs: (() => Promise<void>)[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const net = startSafetyNet([LABEL], (job) => jobs.push(job), { quietMs: 0, labelMs: 120 * MIN });
      await vi.advanceTimersByTimeAsync(119 * MIN);
      expect(jobs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1 * MIN);
      expect(jobs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(240 * MIN);
      expect(jobs).toHaveLength(3);
      net.stop();
      const off = startSafetyNet([LABEL], (job) => jobs.push(job), { quietMs: 0, labelMs: 0 });
      await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
      expect(jobs).toHaveLength(3);
      off.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
