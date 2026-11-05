import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { nobleChemistHandler } from '../../src/modules/po-processing/channels/noble-chemist/noble-chemist.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters } from '../helpers/fixtures';

/*
 * Noble Chemist by Manual Upload (2026-11-05): its order form (.xls) -> our sheet reader (no OCR; the Excel rows come
 * from ocr-service sheet_rows.py, replaced here by the rows that script gives for the sample "Order No 88699.xls") ->
 * noble-chemist.handler -> processed.json -> validation (SKU by EAN, no price on the form = our rate, MRP checked, the
 * channel's only location) -> PO + sale order + Uniware CSV.
 */
const GRID = [
  ['NEW WELCOME AGENCIES PRIVATE LIMITED', '', '', '', '', '', '', ''],
  ['TENEMENT NO. 2/7,2/8,2/9,2/10, GRD AND FIRST FLOOR SWEEPERS COLONY,MOTILAL NAGAR NO-1,GOREGOAN WEST \r\n  DL No. : 20-MH-MZ6-566993  Email : info@nwapl.com', '', '', '', '', '', '', ''],
  ['ORDER FORM', '', '', '', '', '', '', ''],
  ['DATE : 15 Oct 2026 Order No :88699  Order Remarks : ', '', '', '', '', '', '', ''],
  ['NAME : PEP TECHNOLOGIES PVT. LTD.', '', '', '', '', '', '', ''],
  ['COMPANY', 'COMP UPC', 'ITEM NAME', 'PACK', 'QTY.', 'FREE', 'MRP', 'REMARKS'],
  ['', '', '', '', '', '', '', ''],
  ['NP KREATIVE BEAUTY PVT LTD', '8906171510039', 'HYPHEN ALL I NEED SPF 50 PA++++ SUNSCREEN', '50ML', '12', '-', '449', ''],
  ['NP KREATIVE BEAUTY PVT LTD', '8906171510534', 'HYPHEN DOUBLE SHOT RADIANCE LIFT SERUM', '50ML', '24', '-', '649', ''],
  ['NP KREATIVE BEAUTY PVT LTD', '8906171510480', 'HYPHEN GOLDEN HOUR GLOW SPF 50PA+ SUNSCREEN', '40GM', '24', '2', '549', ''],
];
const sheet = vi.hoisted(() => ({ rows: [] as string[][] }));
vi.mock('../../src/modules/ocr/excel-rows', () => ({ excelRows: vi.fn(async () => sheet.rows) }));
// the chain never calls the OCR for a sheet channel: any call is a mistake
const ocrCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async () => { ocrCalls.n++; return { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'no OCR for sheets' }, logTail: '' }; }),
}));

const NC = CHANNEL_MASTER_IDS[CHANNELS.NOBLE_CHEMIST];
const raw: RawOcr = {
  header: {
    'Line 1': GRID[0][0], 'Line 2': GRID[1][0].replace(/\s+/g, ' '), 'Line 3': 'ORDER FORM', 'Line 4': GRID[3][0].trim(), 'Line 5': GRID[4][0],
  },
  lines: GRID.slice(7).map((r) => Object.fromEntries(GRID[5].map((h, i) => [h, r[i]]))),
  lineColumns: GRID[5], inputType: 'sheet', inputFiles: ['Order No 88699.xls'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await nobleChemistHandler.process({ folder: '/tmp/noble-test', meta: {}, channel: CHANNELS.NOBLE_CHEMIST, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/** NOBLE CHEMIST as on dev (5 Nov): channel_code = EAN, rate = MRP x 0.70 with tax, ONE location GOREGOAN_WEST. */
const seedNoble = async (extraLocation = false) => {
  await insert('master_channels', { id: NC, slug: 'noble-chemist', display_name: 'NOBLE CHEMIST', db_aliases: ['NOBLE CHEMIST', 'noble-chemist'], has_processor: 0, is_active: 1 });
  for (const [pep, ean, mrp, rate] of [
    ['HYPMUBX004F050', '8906171510039', 449, 314.3], ['HYPMUBX038F050', '8906171510534', 649, 454.3], ['HYPMUBX033F040', '8906171510480', 549, 384.3],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'Hyphen', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: NC, channel_name: 'NOBLE CHEMIST', channel_code: ean, ean_code: ean, mrp, margin: 0.3, rate_after_margin: rate, is_active: 1 });
  }
  for (const code of extraLocation ? ['GOREGOAN_WEST', 'ANDHERI'] : ['GOREGOAN_WEST']) {
    await insert('details_channels', {
      channel_id: NC, channel_name: 'NOBLE CHEMIST', channel_location_code: code, uniware_customer_code: `NOBLE_CHEMIST_${code}_400104`, channel_code: 'OTHER_B2B',
      facility_code: 'TEST_WH1', consignee_pin_code: null, final_shipping_address: 'TENEMENT NO. 2/7, GOREGOAN WEST, Mumbai', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.NOBLE_CHEMIST), new Date('2026-10-16T06:00:00Z'));

beforeEach(async () => {
  sheet.rows = GRID;
  ocrCalls.n = 0;
  await resetDb();
  await seedMasters();
});
afterAll(closeDb);

describe('Noble Chemist order form -> processed.json (noble-chemist.handler)', () => {
  it('order no. + date from the title rows, the buyer + address, lines by EAN (QTY. + FREE on top), no price', async () => {
    const po = await process();
    expect(po).toMatchObject({ channel_name: 'noble_chemist', po_number: '88699', po_date: '2026-10-15', total_line_items: 3, total_qty: 62 });
    expect(po['shipping address']).toBe('NEW WELCOME AGENCIES PRIVATE LIMITED, TENEMENT NO. 2/7,2/8,2/9,2/10, GRD AND FIRST FLOOR SWEEPERS COLONY,MOTILAL NAGAR NO-1,GOREGOAN WEST');
    expect(po.line_items.map((l) => [l.channel_sku_code, l.qty, l.free_qty, l.channel_mrp, l.unit_cost, l.landing_rate])).toEqual([
      ['8906171510039', 12, '', 449, '', ''], ['8906171510534', 24, '', 649, '', ''], ['8906171510480', 26, 2, 549, '', ''],
    ]);
    expect(po.line_items[0].unmapped).toMatchObject({ COMPANY: 'NP KREATIVE BEAUTY PVT LTD', PACK: '50ML' });
    expect(po.warnings).toEqual([]);
    expect((await process({ header: { 'Line 1': 'X' } })).warnings.map((w) => w.code)).toContain('RAW_FIELD_MISSING');
  });
});

describe('Noble Chemist checks', () => {
  it('the only location; SKUs by EAN at OUR rate (no price on the form = no price issue); no issues', async () => {
    await seedNoble();
    const v = await validate(await process());
    expect(v.location).toMatchObject({ locationCode: 'GOREGOAN_WEST', matchedBy: 'only' });
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([
      ['8906171510039', 'HYPMUBX004F050', 314.3], ['8906171510534', 'HYPMUBX038F050', 454.3], ['8906171510480', 'HYPMUBX033F040', 384.3],
    ]);
    expect(v.issues).toEqual([]);
  });

  it('review with the reasons: an MRP that differs, an EAN not in our master, a second location (which one?)', async () => {
    await seedNoble(true);
    const lines = [{ ...raw.lines[0], MRP: '499' }, { ...raw.lines[1], 'COMP UPC': '8906171599999' }];
    const v = await validate(await process({ lines }));
    expect(v.issues.map((i) => i.type).sort()).toEqual(['LOCATION_NOT_MAPPED', 'MRP_MISMATCH', 'SKU_NOT_MAPPED']);
  });
});

describe('Manual Upload: the whole Noble Chemist flow (no OCR)', () => {
  it('.xls -> sheet reader -> PO 88699 + sale order + CSV at our rates; the same order again (its file name) is refused', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedNoble();
    const list = (await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'noble_chemist', name: 'NOBLE CHEMIST', group: 'manual', twoFiles: false })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'noble_chemist')
      .attach('files', Buffer.from('xls bytes'), 'Order No 88699.xls').expect(201);
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
    expect(ocrCalls.n).toBe(0);
    const [u] = await rows<{ status: string; po_number: string }>('SELECT status, po_number FROM po_uploads WHERE email_message_id = ?', [`manual-upload:${id}`]);
    expect(u).toMatchObject({ status: 'completed', po_number: '88699' });
    const [po] = await rows<{ orderNo1: string }>("SELECT orderNo1 FROM master_purchase_orders WHERE poNumber = '88699'");
    const csv = [...s3Objects().entries()].find(([k]) => k.endsWith('.csv') && k.includes('88699_final_'))?.[1] ?? '';
    expect(csv).toContain(po.orderNo1);
    expect(csv).toContain('NOBLE_CHEMIST_GOREGOAN_WEST_400104');
    expect(csv).toContain('314.3');
    const again = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'noble_chemist')
      .attach('files', Buffer.from('xls bytes, saved again'), 'Order No 88699 (1).xls').expect(409);
    expect(again.body.error.code).toBe('MANUAL_ALREADY_BLOCKED');
  });

  it('a form without the column-names row: the upload fails with why (nothing made)', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedNoble();
    sheet.rows = [['something else'], ['a', 'b']];
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'noble_chemist')
      .attach('files', Buffer.from('xls'), 'Order No 90001.xls').expect(201);
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('failed'), { timeout: 20_000 });
    expect((await rows<{ note: string }>('SELECT note FROM manual_uploads WHERE id = ?', [id]))[0].note).toContain('no row with the column names');
  });
});
