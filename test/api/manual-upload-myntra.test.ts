import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { seedMyntra, strCsv } from '../helpers/myntra';

/*
 * Manual Upload of a Myntra STR CSV (2026-11-03): the STR + its date from the file name, the location from the Destination
 * WH, the same processed.json + chain as the robot's STRs (our price, MRP checked), a channel_pull_items row (stored,
 * taken) so an STR email never takes it again; refused: a wrong file, an STR already taken from an email / a PO / queued.
 */

vi.mock('../../src/modules/ocr/extract-po.service', async (orig) => ({ ...(await orig<object>()), extractPo: vi.fn(async () => ({ status: 'failed', reason: 'OCR is off' })) }));

const V = '/api/v1/manual-uploads';
let m: Masters;
let reviewer: TestLogin;

const upload = (files: [string, string][]) => {
  const req = api().post(V).set('Cookie', reviewer.cookie).field('channel', 'myntra');
  for (const [name, body] of files) req.attach('files', Buffer.from(body), name);
  return req;
};
const statusOf = async (id: string) => (await rows<{ status: string; note: string | null }>('SELECT status, note FROM manual_uploads WHERE id = ?', [id]))[0];
const runIt = async (ids: string[]) => {
  await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids }).expect(200);
  for (const id of ids) await vi.waitFor(async () => expect((await statusOf(id)).status).toMatch(/done|failed/), { timeout: 15_000 });
};

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  await seedMyntra(m);
  reviewer = await loginAs('operations-executive');
});
afterAll(closeDb);

describe('Myntra STR by Manual Upload', () => {
  it('offered in the API / robot group; an STR CSV -> PO + sale order at our price; never taken twice', async () => {
    const ch = (await api().get(`${V}/channels`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(ch).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'myntra', name: 'Myntra STR', group: 'api', twoFiles: false })]));

    const [id] = (await upload([['STNCPWEBP271026-01-summary.csv', strCsv()]]).expect(201)).body.data.ids as string[];
    expect((await statusOf(id)).note).toBe('Myntra STR: Bilaspur Warehouse - Gurgaon -> Gurgaon');
    await runIt([id]);
    expect((await statusOf(id)).status).toBe('done');
    const [u] = await rows<{ status: string; po_number: string; source_system: string; po_uid: string }>("SELECT status, po_number, source_system, po_uid FROM po_uploads WHERE external_id = 'STNCPWEBP271026-01'");
    expect(u).toMatchObject({ po_number: 'STNCPWEBP271026-01', status: 'completed', source_system: 'myntra_str' });
    const lines = await rows<{ poValue: string }>('SELECT poValue FROM details_purchase_orders WHERE shipmentOrderId = ?', [u.po_uid]);
    expect(lines.map((l) => Number(l.poValue))).toEqual([448.5]);
    const processed = JSON.parse([...s3Objects().entries()].find(([k]) => k.endsWith('/STNCPWEBP271026-01/processed.json'))?.[1] ?? '{}') as Record<string, unknown>;
    expect(processed).toMatchObject({ po_date: '2026-10-27', delivery_facility_code: 'Gurgaon', input_type: 'myntra_str_manual' });
    // Channel Pulls shows it (stored, taken); an STR email / a second upload never takes it again
    const [pull] = await rows<{ status: string; taken_at: Date | null; label: string }>("SELECT status, taken_at, label FROM channel_pull_items WHERE source_system = 'myntra_str'");
    expect(pull).toMatchObject({ status: 'stored', label: `STNCPWEBP271026-01 · manual upload · BP · manual upload #${id}` });
    expect(pull.taken_at).not.toBeNull();
    expect((await upload([['STNCPWEBP271026-01-summary.csv', strCsv()]])).body.error.code).toBe('MANUAL_DUPLICATE');
  });

  it('an STR the robot gave up on (failed) may be uploaded by hand: processed, keeps its email + group, Channel Pulls shows it stored', async () => {
    await insert('channel_pull_items', {
      source_system: 'myntra_str', external_id: 'STNCPWEBP271026-04', status: 'failed', warehouse: 'BP', created_on: '2026-10-27', label: 'STNCPWEBP271026-04 · NON TC P3 · BP',
      data: JSON.stringify({ email: { folder: 'f', subject: 'Re: Request to Raise STRs', receivedAt: '2026-10-27T05:09:20.000Z' }, order: 21, group: 'NON TC', priority: 'P3', destination: 'BP', runs: 3, lastError: 'not found on the Myntra portal' }),
      fetched_at: new Date(),
    });
    // the team's list: GET /channel-pulls/myntra_str/items?status=failed
    const failed = (await api().get('/api/v1/channel-pulls/myntra_str/items?status=failed').set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(failed).toEqual([expect.objectContaining({ externalId: 'STNCPWEBP271026-04', status: 'failed', runs: 3, error: 'not found on the Myntra portal', email: { subject: 'Re: Request to Raise STRs', receivedAt: '2026-10-27T05:09:20.000Z' } })]);
    expect((await api().get('/api/v1/channel-pulls/myntra_str/items?status=nope').set('Cookie', reviewer.cookie)).status).toBe(400);

    const [id] = (await upload([['STNCPWEBP271026-04-summary.csv', strCsv()]]).expect(201)).body.data.ids as string[];
    await runIt([id]);
    expect((await statusOf(id)).status).toBe('done');
    const [u] = await rows<{ status: string }>("SELECT status FROM po_uploads WHERE external_id = 'STNCPWEBP271026-04'");
    expect(u.status).toBe('completed');
    const [pull] = await rows<{ status: string; label: string; data: string | Record<string, unknown> }>("SELECT status, label, data FROM channel_pull_items WHERE external_id = 'STNCPWEBP271026-04'");
    const d = typeof pull.data === 'string' ? JSON.parse(pull.data) as Record<string, unknown> : pull.data;
    expect(pull.status).toBe('stored');
    expect(pull.label).toBe(`STNCPWEBP271026-04 · NON TC P3 · BP · manual upload #${id}`);
    expect(d).toMatchObject({ group: 'NON TC', priority: 'P3', email: { subject: 'Re: Request to Raise STRs' }, manualUploadId: id, lastError: null });
    expect((await api().get('/api/v1/channel-pulls/myntra_str/items?status=failed').set('Cookie', reviewer.cookie)).body.data).toEqual([]);
  });

  it('refused: a wrong name or columns, the same STR twice in one upload, an STR already taken from an email', async () => {
    expect((await upload([['report.csv', strCsv()]])).body.error.code).toBe('MANUAL_MYNTRA_FILE');
    expect((await upload([['STNCPWEBP271026-02-summary.csv', 'a,b\n1,2\n']])).body.error.code).toBe('MANUAL_MYNTRA_FILE');
    expect((await upload([['STNCPWEBP271026-02-summary.csv', strCsv()], ['STNCPWEBP271026-02-summary (1).csv', strCsv()]])).body.error.code).toBe('MANUAL_DUPLICATE');
    await insert('channel_pull_items', { source_system: 'myntra_str', external_id: 'STNCPWEBP271026-03', status: null, warehouse: 'BP', created_on: '2026-10-27', label: 'x', data: JSON.stringify({ runs: 0 }), fetched_at: new Date() });
    const r = await upload([['STNCPWEBP271026-03-summary.csv', strCsv()]]);
    expect(r.body.error.code).toBe('MANUAL_DUPLICATE');
    expect(r.body.error.message).toContain('STR email');
    expect(await count('manual_uploads')).toBe(0);
  });
});
