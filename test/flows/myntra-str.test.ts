import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStrEmail, strsOf } from '../../src/modules/channel-api/myntra/str-email';
import { strToProcessed } from '../../src/modules/channel-api/myntra/str.parse';
import { runStrRobot, setAfterStored, strBlocked, takeStrEmail, type StrFetcher } from '../../src/modules/channel-api/myntra/str.service';
import { MYNTRA_SESSION_NEEDED } from '../../src/modules/intransit/sources/myntra-partner-portal';
import { clearNoticeCache } from '../../src/modules/notices/notices.service';
import { loginAs } from '../helpers/auth';
import { closeDb, insert, resetDb, rows } from '../helpers/db';
import { clearS3, s3Objects } from '../helpers/fake-s3';

/*
 * Myntra STRs (2026-11-03): the STR list of a NEW "Request to Raise STRs" email (newest part only) -> waiting rows ->
 * the robot's CSVs -> S3 (CSV + processed.json), no PO yet. The robot is replaced by a fake fetcher here.
 */

// the alerts' emails are recorded, never sent
const mailbox = vi.hoisted(() => ({ sent: [] as { to: string[]; subject: string; text: string }[] }));
vi.mock('../../src/modules/mail/mailer.service', async (orig) => ({
  ...(await orig<object>()),
  sendMail: vi.fn(async (m: { to: string[]; subject: string; text: string }) => { mailbox.sent.push(m); }),
}));

const LIST = `Hi Reshma

Please find the STR Numbers listed below. Kindly book the slots.

NON TC
P0

STNCPWEBP271026-01
STNCPWEFKME271026-00
P1

STNCPWEMYNT271026-02
TC
P0

STNCPWEBW271026-05

* Thanks & Regards,*
* Md Abrar*


On Mon, Oct 26, 2026 at 2:57 PM Reshma Sawant <reshma@example.com>
wrote:

> Hi Abrar, please share the STRs.
> STNCPWEBP211026-09
`;
const REPLY = `Hi Reshma

Styles mentioned below cannot be raised due to price missmatch.

style_id Price PO MRP Remarks
22849932 375 374 FALSE

On Tue, Oct 27, 2026 at 10:39 AM Mahamad Abrar - Vendor <
abrar@example.com> wrote:

> Hi Reshma
>
> Please find the STR Numbers listed below. Kindly book the slots.
> STNCPWEBP271026-01
`;
const FORWARDED = `FYI

---------- Forwarded message ---------
From: Mahamad Abrar <abrar@example.com>
Date: Tue, Oct 27, 2026 at 10:39 AM
Subject: Re: MCaffeine | Request to Raise STRs for Shared Requirements | 21ST-Oct'26
To: Reshma <reshma@example.com>

${LIST}`;
const SUBJECT = "Re: MCaffeine | Request to Raise STRs for Shared Requirements | 21ST-Oct'26";
const CSV = `GTIN,GTINS,Style Id,SKU Code,Quantity,Vendor Article No,Vendor Article Name,Size,Gender,Brand Name,Article Type Name,HSN Code,Source WH,Destination WH,MRP,List Price,Landed Price,IGST Rate,IGST Amount
08906129573567,"[""08906129573567""]",26828554,MCFNFCWH86498566,102,MCaf270,2% SALICYLIC ACID FACE WASH,100 ml,Unisex,MCaffeine,Face Wash,33051090,Pep Technologies_SJIT_Bhiwandi_CPWE,Bilaspur Warehouse - Gurgaon,299.0,209.3,219.77,5.0,10.46
`;
const CSV_INTRA = `GTIN,SKU Code,Quantity,Vendor Article No,Source WH,Destination WH,MRP,SGST Rate,CGST Rate
8906129570016,MCFNX1,4,MCaf40,Pep Technologies_SJIT_Bhiwandi_CPWE,Myntra warehouse ( Mumbai ),499,9,9
`;

let tmp: string;
const emailFolder = async (subject: string, body: string, receivedAt = '2026-11-03T05:00:00.000Z') => {
  const dir = await fs.mkdtemp(path.join(tmp, 'mail-'));
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ subject, receivedAt, from: 'abrar@myntra.com' }));
  await fs.writeFile(path.join(dir, 'body.txt'), body);
  return dir;
};
const items = () => rows<{ external_id: string; status: string | null; created_on: string; data: string | Record<string, unknown> }>(
  'SELECT external_id, status, created_on, data FROM channel_pull_items WHERE source_system = ? ORDER BY id', ['myntra_str']);
const dataOf = (v: string | Record<string, unknown>) => (typeof v === 'string' ? JSON.parse(v) as Record<string, unknown> : v);
const myntraOn = async () => {
  const admin = await loginAs('admin');
  await insert('channel_intake_settings', { channel: 'myntra', enabled: 1, process_from: new Date('2026-11-01T00:00:00Z'), updated_by: admin.userId, updated_at: new Date() });
};

beforeEach(async () => {
  // the process run after storing is tested in myntra-str-po.test.ts
  setAfterStored(() => undefined);
  await resetDb();
  clearS3();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'myntra-str-test-'));
});
afterAll(closeDb);

describe('the email', () => {
  it('STRs of the newest part only, in order, with their group and priority; quoted lists never taken', () => {
    expect(isStrEmail(SUBJECT, LIST)).toBe(true);
    expect(strsOf(LIST).map((s) => [s.str, s.order, s.group, s.priority, s.destination, s.date])).toEqual([
      ['STNCPWEBP271026-01', 1, 'NON TC', 'P0', 'BP', '2026-10-27'],
      ['STNCPWEFKME271026-00', 2, 'NON TC', 'P0', 'FKME', '2026-10-27'],
      ['STNCPWEMYNT271026-02', 3, 'NON TC', 'P1', 'MYNT', '2026-10-27'],
      ['STNCPWEBW271026-05', 4, 'TC', 'P0', 'BW', '2026-10-27'],
    ]);
    // a reply whose newest part is something else: its quoted STR list is not read
    expect(isStrEmail(SUBJECT, REPLY)).toBe(false);
    expect(strsOf(REPLY)).toEqual([]);
    // forwarded to Po-Intake by a colleague: read from the forwarded message
    expect(strsOf(FORWARDED).map((s) => s.str)).toEqual(['STNCPWEBP271026-01', 'STNCPWEFKME271026-00', 'STNCPWEMYNT271026-02', 'STNCPWEBW271026-05']);
    expect(isStrEmail('Invoices required for dispatches', LIST)).toBe(false);
  });

  it('Myntra intake OFF -> nothing taken; ON -> waiting rows once (a repeat adds none); not an STR email -> null', async () => {
    const started: string[] = [];
    const start = (t: string) => void started.push(t);
    expect(await takeStrEmail(await emailFolder(SUBJECT, LIST), start)).toMatchObject({ gate: 'off', strs: 4, added: 0 });
    expect(await items()).toHaveLength(0);
    await myntraOn();
    expect(await takeStrEmail(await emailFolder(SUBJECT, LIST), start)).toMatchObject({ gate: 'take', strs: 4, added: 4 });
    expect(await takeStrEmail(await emailFolder(SUBJECT, FORWARDED), start)).toMatchObject({ added: 0 });
    expect(await takeStrEmail(await emailFolder(SUBJECT, REPLY), start)).toBeNull();
    expect(await takeStrEmail(await emailFolder(SUBJECT, LIST, '2026-10-20T00:00:00Z'), start)).toMatchObject({ gate: 'before', added: 0 });
    const r = await items();
    expect(r.map((i) => [i.external_id, i.status])).toEqual([
      ['STNCPWEBP271026-01', null], ['STNCPWEFKME271026-00', null], ['STNCPWEMYNT271026-02', null], ['STNCPWEBW271026-05', null],
    ]);
    expect(started).toEqual(['email']);
  });
});

describe('the CSV', () => {
  it('-> processed.json: STR = PO number, its date = PO date, SKU Code = channel SKU, EAN without the leading 0, GST %; no price', () => {
    const { po, summary } = strToProcessed({ str: 'STNCPWEBP271026-01', date: '2026-10-27', destination: 'BP', group: 'NON TC', priority: 'P0' }, CSV);
    expect(po).toMatchObject({ channel_name: 'myntra', po_number: 'STNCPWEBP271026-01', po_date: '2026-10-27', delivery_facility_code: 'Gurgaon', total_qty: 102, po_value: '' });
    // Myntra's prices + GST: information only (ours are used)
    expect(po.line_items[0].unmapped).toMatchObject({ myntra_list_price: '209.3', myntra_landed_price: '219.77', myntra_gst: '5' });
    expect(po.unmapped).toMatchObject({ myntra_landed_total: '22416.54', destination_code: 'BP' });
    expect(po.line_items[0]).toMatchObject({ channel_sku_code: 'MCFNFCWH86498566', ean: '8906129573567', qty: 102, channel_mrp: 299, gst: '', landing_rate: '', listing_sku_code: 'MCaf270' });
    expect(summary).toMatchObject({ rows: 1, units: 102, source: 'Pep Technologies_SJIT_Bhiwandi_CPWE', destination: 'Bilaspur Warehouse - Gurgaon', missingColumns: [] });
    // intra-state: SGST + CGST
    expect(strToProcessed({ str: 'STNCPWEMW271026-01', date: '2026-10-27', destination: 'MW', group: '', priority: '' }, CSV_INTRA).po.line_items[0].unmapped.myntra_gst).toBe('18');
  });
});

describe('the robot run', () => {
  it('CSV + processed.json to S3 per STR; a failed STR is failed at once and never tried again by itself; nothing in po_uploads', async () => {
    await myntraOn();
    await takeStrEmail(await emailFolder(SUBJECT, LIST), () => undefined);
    const asked: string[][] = [];
    const fetcher: StrFetcher = async (strs) => {
      asked.push(strs);
      return strs.map((str) => (str === 'STNCPWEMYNT271026-02' ? { str, csv: null, error: 'not found on the Myntra portal' } : { str, csv: CSV }));
    };
    const run = await runStrRobot('test', fetcher);
    expect(run).toMatchObject({ ok: true, listed: 4, stored: 3 });
    expect(asked[0]).toEqual(['STNCPWEBP271026-01', 'STNCPWEFKME271026-00', 'STNCPWEMYNT271026-02', 'STNCPWEBW271026-05']);
    const objects = s3Objects();
    const folder = [...objects.keys()].find((k) => k.endsWith('/STNCPWEBP271026-01/processed.json'))!;
    expect(folder).toMatch(/channel-api\/FY\d{4}\/[A-Za-z]+\/myntra\/STNCPWEBP271026-01\/processed\.json$/);
    expect(JSON.parse(objects.get(folder)!)).toMatchObject({ po_number: 'STNCPWEBP271026-01', channel_name: 'myntra' });
    // the same files as an Amazon / Flipkart PO folder: metadata.json, api-raw.json, the original CSV, processed.json
    const files = [...objects.keys()].filter((k) => k.includes('/STNCPWEBP271026-01/')).map((k) => k.split('/').pop()).sort();
    expect(files).toEqual(['STNCPWEBP271026-01-summary.csv', 'api-raw.json', 'metadata.json', 'processed.json']);
    const meta = JSON.parse(objects.get(folder.replace('processed.json', 'metadata.json'))!);
    expect(meta).toMatchObject({ provider: 'channel-api', channel: 'myntra', poNumber: 'STNCPWEBP271026-01', sourceSystem: 'myntra_str', sourceFile: 'STNCPWEBP271026-01-summary.csv', strEmail: { subject: SUBJECT } });
    const r = await items();
    // 2026-11-27 (user: "don't keep on trying if it fails"): the one that did not download is failed at once (was 3 runs)
    expect(r.map((i) => i.status)).toEqual(['stored', 'stored', 'failed', 'stored']);
    expect(dataOf(r[0].data)).toMatchObject({ summary: { units: 102 } });
    expect(dataOf(r[2].data)).toMatchObject({ runs: 1, lastError: 'not found on the Myntra portal' });
    // the next run has nothing to ask for: a failed STR is never asked again (Manual Upload by hand)
    expect((await runStrRobot('again', fetcher)).listed).toBe(0);
    expect(asked).toHaveLength(1);
    expect(await rows('SELECT id FROM po_uploads')).toHaveLength(0);
  });

  it('login not working: STRs stay waiting (not counted), the Myntra STRs list hears it ONCE (bell from POST_FG + email); a good run clears it and tells what came in', async () => {
    await myntraOn();
    const reshma = await loginAs('operations-executive');
    const other = await loginAs('operations-executive');
    await insert('mail_recipients', { list_key: 'myntra-str', email: reshma.email, kind: 'to', paused: false, created_by: reshma.userId, created_at: new Date(), updated_by: reshma.userId, updated_at: new Date() });
    await insert('mail_recipients', { list_key: 'myntra-str', email: 'ops.lead@example.com', kind: 'cc', paused: false, created_by: reshma.userId, created_at: new Date(), updated_by: reshma.userId, updated_at: new Date() });
    mailbox.sent.length = 0;
    clearNoticeCache();
    await takeStrEmail(await emailFolder(SUBJECT, LIST), () => undefined);
    const noLogin: StrFetcher = () => Promise.reject(new Error(MYNTRA_SESSION_NEEDED));
    const run = await runStrRobot('email', noLogin);
    expect(run).toMatchObject({ ok: false, listed: 4, stored: 0, error: MYNTRA_SESSION_NEEDED });
    expect((await items()).map((i) => [i.status, dataOf(i.data).runs])).toEqual([[null, 0], [null, 0], [null, 0], [null, 0]]);
    expect(await strBlocked()).toMatchObject({ kind: 'login', waiting: 4 });
    const notices = () => rows<{ from_user_id: number; to_user_id: number; text: string; link: string }>('SELECT from_user_id, to_user_id, text, link FROM notices ORDER BY id');
    let n = await notices();
    // the bell: only the POST_FG person on the list, from the app itself (0 = POST_FG), with the Channel Pulls link
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ from_user_id: 0, to_user_id: reshma.userId, link: '/operations/amazon-inbound?tab=channels' });
    expect(n[0].text).toMatch(/Myntra login needed: 4 STR\(s\) are waiting.*Connect & run/);
    expect(n.some((x) => x.to_user_id === other.userId)).toBe(false);
    await vi.waitFor(() => expect(mailbox.sent).toHaveLength(1));
    expect(mailbox.sent[0]).toMatchObject({ to: [reshma.email], cc: ['ops.lead@example.com'], subject: 'POST_FG: Myntra login needed (4 STR(s) waiting)' });
    // the next STR email's run fails the same way: no second alert
    await runStrRobot('email', noLogin);
    expect(await notices()).toHaveLength(1);
    expect(mailbox.sent).toHaveLength(1);
    // the login works again: everything downloads, the block is gone, one 'done' notice
    const run2 = await runStrRobot('connect & run', async (strs) => strs.map((str) => ({ str, csv: CSV })));
    expect(run2).toMatchObject({ ok: true, stored: 4 });
    expect(await strBlocked()).toBeNull();
    n = await notices();
    expect(n).toHaveLength(2);
    expect(n[1].text).toMatch(/^Myntra STRs: 4 downloaded and being made into POs/);
  });

  it('the whole run failing otherwise (the browser): STRs stay waiting, alerted once as "could not run"', async () => {
    await myntraOn();
    await takeStrEmail(await emailFolder(SUBJECT, LIST), () => undefined);
    const run = await runStrRobot('test', () => Promise.reject(new Error('browser closed')));
    expect(run).toMatchObject({ ok: false, error: 'browser closed' });
    expect((await items()).map((i) => [i.status, dataOf(i.data).runs])).toEqual([[null, 0], [null, 0], [null, 0], [null, 0]]);
    expect(await strBlocked()).toMatchObject({ kind: 'failed', waiting: 4, error: 'browser closed' });
  });
});
