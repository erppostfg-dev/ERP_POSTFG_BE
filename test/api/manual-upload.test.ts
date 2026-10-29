import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, count, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters, type Masters } from '../helpers/fixtures';
import { covers } from '../helpers/routes';

/*
 * Manual Upload (2026-10-28): PO files uploaded by hand on Processed & Review -> Manual Upload, queued with Process,
 * run one at a time through the same chain as email. The OCR step is replaced by a recorder (answers ok / failed, no
 * OCR cost); Amazon's status check at upload is replaced too (answers per shipment). The Amazon .tsv needs no OCR, so it
 * runs end to end for real.
 */
covers(['GET /manual-uploads/channels', 'GET /manual-uploads', 'POST /manual-uploads', 'POST /manual-uploads/process', 'POST /manual-uploads/:id/cancel', 'POST /manual-uploads/:id/retry']);

interface Fakes { ocr: string[]; ocrAnswer: { status: string; reason?: string }; amazon: Record<string, string> }
const fake = vi.hoisted((): Fakes => ({ ocr: [], ocrAnswer: { status: 'failed', reason: 'OCR is off in tests' }, amazon: {} }));
vi.mock('../../src/modules/ocr/extract-po.service', async (orig) => ({
  ...(await orig<object>()),
  extractPo: vi.fn(async (folder: string) => { fake.ocr.push(folder); return fake.ocrAnswer; }),
}));
vi.mock('../../src/modules/channel-api/amazon/inbound-api', async (orig) => ({
  ...(await orig<object>()),
  shipmentsByIds: vi.fn(async (ids: string[]) => ids.filter((i) => fake.amazon[i]).map((i) => ({ ShipmentId: i, ShipmentStatus: fake.amazon[i] }))),
}));

const V = '/api/v1/manual-uploads';
let m: Masters;
let reviewer: TestLogin;

const upload = (channel: string, files: [string, string][], who = reviewer) => {
  const req = api().post(V).set('Cookie', who.cookie).field('channel', channel);
  for (const [name, body] of files) req.attach('files', Buffer.from(body), name);
  return req;
};
const statusOf = async (id: string) => (await rows<{ status: string; note: string | null }>('SELECT status, note FROM manual_uploads WHERE id = ?', [id]))[0];
const tsv = (shipmentId: string, fnsku: string, units = 24, msku = 'MCAFF_TEST_001') => [
  `Shipment ID\t${shipmentId}`, 'Name\tFBA STA (26/10/2026 10:00)-IDX2', 'Plan ID\tPLN-TEST', 'Ship To\tIDX2', 'Total SKUs\t1', `Total Units\t${units}`, '',
  'Merchant SKU\tTitle\tASIN\tFNSKU\texternal-id\tCondition\tWho will prep?\tPrep Type\tWho will label?\tShipped',
  `${msku}\tTest scrub\tB0TEST\t${fnsku}\tEAN: 8906000000017\tNewItem\tSeller\tNone\tSeller\t${units}`,
].join('\n');

beforeEach(async () => {
  await resetDb();
  m = await seedMasters();
  reviewer = await loginAs('operations-executive');
  fake.ocr.length = 0;
  fake.ocrAnswer = { status: 'failed', reason: 'OCR is off in tests' };
  fake.amazon = {};
});
afterAll(closeDb);

describe('who may upload', () => {
  it('401 / 403 for no page; a viewer sees the queue but cannot upload or process', async () => {
    expect((await api().get(V)).status).toBe(401);
    const viewer = await loginAs('viewer');
    expect((await api().get(V).set('Cookie', viewer.cookie)).status).toBe(200);
    expect((await upload('bigbasket', [['1.xlsx', 'x']], viewer)).status).toBe(403);
    expect((await api().post(`${V}/process`).set('Cookie', viewer.cookie).send({ ids: ['1'] })).status).toBe(403);
    expect(await count('manual_uploads')).toBe(0);
  });
});

describe('upload', () => {
  it('lists only channels it can read AND that have their masters', async () => {
    const res = await api().get(`${V}/channels`).set('Cookie', reviewer.cookie).expect(200);
    // seeded: BigBasket only (Amazon, Zepto ... have no master_channels row in this test)
    expect(res.body.data.map((c: { channel: string }) => c.channel)).toEqual(['bigbasket']);
  });

  it('stores the file + metadata, copies it to S3, waits as "uploaded" (no OCR yet)', async () => {
    const res = await upload('bigbasket', [['91000001.xlsx', 'fake sheet']]).expect((r) => expect(r.status).toBeLessThan(300));
    const [id] = res.body.data.ids as string[];
    expect(await statusOf(id)).toMatchObject({ status: 'uploaded' });
    expect([...s3Objects().keys()].some((k) => k.includes('manual-upload') && k.endsWith('91000001.xlsx'))).toBe(true);
    const list = await api().get(V).set('Cookie', reviewer.cookie).expect(200);
    expect(list.body.data[0]).toMatchObject({ id, channel: 'bigbasket', status: 'uploaded' });
    expect(fake.ocr).toEqual([]);
  });

  it('refuses a channel it cannot read, no files, or a file type it cannot read', async () => {
    expect((await upload('nochannel', [['a.pdf', 'x']])).body.error.code).toBe('MANUAL_CHANNEL_NOT_READABLE');
    expect((await upload('bigbasket', [])).status).toBe(400);
    expect((await upload('bigbasket', [['virus.exe', 'x']])).body.error.code).toBe('MANUAL_FILE_TYPE');
    expect(await count('manual_uploads')).toBe(0);
  });

  it('the same file twice is kept, with a note naming the earlier upload', async () => {
    const first = (await upload('bigbasket', [['a.xlsx', 'same bytes']])).body.data.ids[0];
    const second = (await upload('bigbasket', [['b.xlsx', 'same bytes']])).body.data.ids[0];
    expect((await statusOf(second)).note).toBe(`Same file as manual upload #${first}`);
  });
});

describe('process, cancel, retry', () => {
  it('Process -> queued -> OCR step -> failed with its reason; Retry -> runs again -> done', async () => {
    const [id] = (await upload('bigbasket', [['91000002.xlsx', 'sheet']])).body.data.ids as string[];
    await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await statusOf(id)).status).toBe('failed'), { timeout: 10_000 });
    expect((await statusOf(id)).note).toBe('OCR is off in tests');
    expect(fake.ocr).toHaveLength(1);
    fake.ocrAnswer = { status: 'ok' };
    await api().post(`${V}/${id}/retry`).set('Cookie', reviewer.cookie).send({}).expect(200);
    await vi.waitFor(async () => expect((await statusOf(id)).status).toBe('done'), { timeout: 10_000 });
    expect(fake.ocr).toHaveLength(2);
  });

  it('only "uploaded" can be processed or cancelled, only "failed" retried; cancelled ones are kept', async () => {
    const [id] = (await upload('bigbasket', [['91000003.xlsx', 'sheet']])).body.data.ids as string[];
    expect((await api().post(`${V}/${id}/retry`).set('Cookie', reviewer.cookie).send({})).body.error.code).toBe('MANUAL_UPLOAD_WRONG_STATE');
    await api().post(`${V}/${id}/cancel`).set('Cookie', reviewer.cookie).send({}).expect(200);
    expect((await statusOf(id)).status).toBe('cancelled');
    expect((await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: [id] })).body.error.code).toBe('MANUAL_UPLOAD_WRONG_STATE');
    expect((await api().post(`${V}/${id}/cancel`).set('Cookie', reviewer.cookie).send({})).body.error.code).toBe('MANUAL_UPLOAD_WRONG_STATE');
    expect(await count('manual_uploads')).toBe(1);
    expect(fake.ocr).toEqual([]);
  });

  it('Process needs ids; unknown ids are refused', async () => {
    expect((await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: [] })).status).toBe(400);
    expect((await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: ['999999'] })).status).toBe(404);
    expect((await api().post(`${V}/999999/cancel`).set('Cookie', reviewer.cookie).send({})).status).toBe(404);
  });
});

describe('Amazon shipment file (.tsv, no OCR)', () => {
  const amazonMasters = async () => {
    const id = CHANNEL_MASTER_IDS[CHANNELS.AMAZON];
    await insert('master_channels', { id, slug: 'amazon', display_name: 'Amazon', db_aliases: ['Amazon', 'amazon'], has_processor: 1, is_active: 1 });
    await insert('master_channel_skus', { pep_code: m.pepCode, pep_sku_id: m.pepSkuId, channel_id: id, channel_name: 'Amazon', channel_code: 'X00TEST001', mrp: 499, rate_after_margin: 349.3, is_active: 1 });
    await insert('details_channels', {
      channel_id: id, channel_name: 'Amazon', channel_location_code: 'IDX2', uniware_customer_code: 'AMZ_IDX2', channel_code: 'AMAZON_TEST',
      facility_code: m.facilityCode, facility_id: m.facilityId, consignee_pin_code: '110001', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  };

  it('a shipment file runs through the real chain (no OCR): mapped SKU -> PO + sale order with OUR rate', async () => {
    await amazonMasters();
    fake.amazon = { FBA15TEST0001: 'WORKING' };
    const res = await upload('amazon', [['FBA15TEST0001.tsv', tsv('FBA15TEST0001', 'X00TEST001')]]).expect((r) => expect(r.status).toBeLessThan(300));
    const [id] = res.body.data.ids as string[];
    expect((await statusOf(id)).note).toBe('Amazon: WORKING');
    await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await statusOf(id)).status).toBe('done'), { timeout: 15_000 });
    expect(fake.ocr).toEqual([]);
    const [u] = await rows<{ id: string; status: string; po_number: string }>("SELECT id, status, po_number FROM po_uploads WHERE external_id = 'FBA15TEST0001'");
    expect(u).toMatchObject({ po_number: 'FBA15TEST0001', status: 'completed' });
    const csv = [...s3Objects().entries()].find(([k]) => k.endsWith('.csv') && k.includes('FBA15TEST0001'))?.[1] ?? '';
    expect(csv).toContain('AMZ_IDX2');
    expect(csv).toContain('349.3');
  });

  it('FNSKU unknown but the Merchant SKU is our PEP code: matched by the PEP code (fallback) and completed', async () => {
    await amazonMasters();
    const res = await upload('amazon', [['FBA15TEST0006.tsv', tsv('FBA15TEST0006', 'X00NOTINMASTER')]]);
    await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: res.body.data.ids }).expect(200);
    await vi.waitFor(async () => expect((await statusOf(res.body.data.ids[0])).status).toBe('done'), { timeout: 15_000 });
    expect((await rows<{ status: string }>("SELECT status FROM po_uploads WHERE external_id = 'FBA15TEST0006'"))[0].status).toBe('completed');
  });

  it('an Amazon SKU we cannot match at all waits in review without a price (Amazon sends none; backlog 4ad)', async () => {
    await amazonMasters();
    const res = await upload('amazon', [['FBA15TEST0005.tsv', tsv('FBA15TEST0005', 'X00UNKNOWN', 24, 'SOME_OTHER_SKU')]]);
    await api().post(`${V}/process`).set('Cookie', reviewer.cookie).send({ ids: res.body.data.ids }).expect(200);
    await vi.waitFor(async () => expect((await statusOf(res.body.data.ids[0])).status).toBe('done'), { timeout: 15_000 });
    const [u] = await rows<{ id: string; status: string }>("SELECT id, status FROM po_uploads WHERE external_id = 'FBA15TEST0005'");
    expect(u.status).toBe('needs_review');
    const issues = (await rows<{ issue_type: string }>('SELECT issue_type FROM po_issues WHERE upload_id = ? ORDER BY id', [u.id])).map((i) => i.issue_type);
    expect(issues).toEqual(expect.arrayContaining(['SKU_NOT_MAPPED', 'OTHER']));
  });

  it('refuses a cancelled / closed shipment, a broken file, and a shipment POST_FG already has', async () => {
    await amazonMasters();
    fake.amazon = { FBA15TEST0002: 'CANCELLED' };
    expect((await upload('amazon', [['FBA15TEST0002.tsv', tsv('FBA15TEST0002', 'X00TEST001')]])).body.error.code).toBe('MANUAL_AMAZON_STATUS');
    expect((await upload('amazon', [['notes.tsv', 'hello\tworld']])).body.error.code).toBe('MANUAL_AMAZON_FILE');
    expect((await upload('amazon', [['a.pdf', 'x']])).body.error.code).toBe('MANUAL_AMAZON_FILE');
    await upload('amazon', [['FBA15TEST0003.tsv', tsv('FBA15TEST0003', 'X00TEST001')]]).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await upload('amazon', [['again.tsv', tsv('FBA15TEST0003', 'X00TEST001')]])).body.error.code).toBe('MANUAL_DUPLICATE');
    expect(await count('manual_uploads')).toBe(1);
  });

  it('Amazon status cannot be read: the upload is allowed with a note', async () => {
    await amazonMasters();
    const res = await upload('amazon', [['FBA15TEST0004.tsv', tsv('FBA15TEST0004', 'X00TEST001')]]);
    expect((await statusOf(res.body.data.ids[0])).note).toContain('not found at Amazon');
  });
});
