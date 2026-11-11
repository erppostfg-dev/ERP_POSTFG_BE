import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { amazonRkWorldHandler } from '../../src/modules/po-processing/channels/amazon-rk-world/amazon-rk-world.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';

/*
 * Amazon RK World by Manual Upload (2026-11-06): the Vendor Central "PO Item Export" (.xls, several POs) -> our sheet
 * reader (no OCR; the Excel rows come from ocr-service sheet_rows.py, replaced here by rows of the real sample
 * POItemExport_2026-09-22.xls, trimmed) -> amazon-rk-world.handler (one PO per "PO") -> validation (SKU by ASIN, then
 * EAN, then Model number; Cost before GST + our GST; FC code = location) -> one PO per PO number.
 * Unconfirmed counts as Confirmed for now (user 2026-11-06): qty = requested - cancelled; CA / OS / R2 / CP lines left out.
 */
const H = ['PO', 'Vendor code', 'Order date', 'Status', 'Product name', 'ASIN', 'External ID type', 'External ID', 'Model number', 'Merchant SKU',
  'Catalog number', 'Availability', 'Requested quantity', 'Accepted quantity', 'ASN quantity', 'Received quantity', 'Cancelled quantity',
  'Remaining quantity', 'Ship-to location', 'Window start', 'Window end', 'Case size', 'Cost', 'Currency', 'Total requested cost',
  'Total accepted cost', 'Total received cost', 'Total cancelled cost', 'Expected date', 'Freight terms', 'Consolidation ID', 'Cancellation deadline'];
const row = (po: string, asin: string, idType: string, id: string, model: string, qty: string, fc: string, cost: string, extra: { status?: string; availability?: string; cancelled?: string } = {}) => [
  po, 'XN8TZ', '2026-09-22', extra.status ?? 'Unconfirmed', `${model} product`, asin, idType, id, model, '', '', extra.availability ?? 'AC - Accepted: In stock',
  qty, '0', '0', '0', extra.cancelled ?? '0', '0', fc, '2026-09-23', '2026-10-07', '1', cost, 'INR', '', '0', '0', '0', '2026-09-23', 'Prepaid', '', '',
];
const GRID = [
  H,
  row('5F5AJUWB', 'B0FH2Q8PT3', 'EAN', '8906129575929', 'MCaf396_WB', '24', 'HKA2', '245.81'),
  row('5F5AJUWB', 'B0DP6DJFZD', 'EAN', '8906129575332', 'MCaf370', '36', 'HKA2', '240.88'),
  row('81U8GGMU', 'B09X6SQ6VW', 'SKU', '55MCaf40', '55MCaf40', '60', 'HNR4', '161.66'),
  row('81U8GGMU', 'B0DP6DJFZD', 'EAN', '8906129575332', 'MCaf370', '36', 'HNR4', '240.88'),
];
const sheet = vi.hoisted(() => ({ rows: [] as string[][] }));
vi.mock('../../src/modules/ocr/excel-rows', () => ({ excelRows: vi.fn(async () => sheet.rows) }));
const ocrCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async () => { ocrCalls.n++; return { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'no OCR for sheets' }, logTail: '' }; }),
}));

const RK = CHANNEL_MASTER_IDS[CHANNELS.AMAZON_RK_WORLD];
const rawOf = (grid: string[][]): RawOcr => ({
  header: {}, lines: grid.slice(1).map((r) => Object.fromEntries(grid[0].map((h, i) => [h, r[i]]))),
  lineColumns: grid[0], inputType: 'sheet', inputFiles: ['POItemExport_2026-09-22.xls'], sourceFile: 'raw.json',
});
const process = async (grid = GRID) =>
  (await amazonRkWorldHandler.process({ folder: '/tmp/rk-test', meta: {}, channel: CHANNELS.AMAZON_RK_WORLD, raw: rawOf(grid), body: '', subject: '' })) as ProcessedPo[];

/** AMAZON RK WORLD with SKU rows keyed as `codeBy` says (asin / ean / none), rate = Cost x 1.18, FCs HKA2 + HNR4. */
const seedRk = async (codeBy: 'asin' | 'ean' | 'none') => {
  await insert('master_channels', { id: RK, slug: 'amazon-rk-world', display_name: 'AMAZON RK WORLD', db_aliases: ['AMAZON RK WORLD', 'amazon-rk-world'], has_processor: 0, is_active: 1 });
  for (const [pep, asin, ean, mrp, rate] of [
    ['Mcaf396_WB', 'B0FH2Q8PT3', '8906129575929', 449, 290.06], ['MCaf370', 'B0DP6DJFZD', '8906129575332', 499, 284.24], ['55MCaf40', 'B09X6SQ6VW', '', 279, 190.76],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'mCaffeine', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    if (codeBy === 'none') continue;
    await insert('master_channel_skus', {
      pep_code: pep, pep_sku_id: pepSkuId, channel_id: RK, channel_name: 'AMAZON RK WORLD', channel_code: codeBy === 'asin' ? asin : `RK-${pep}`,
      ean_code: ean || null, mrp, margin: 0.43, rate_after_margin: rate, is_active: 1,
    });
  }
  for (const [code, pin] of [['HKA2', '562122'], ['HNR4', '124103']]) {
    await insert('details_channels', {
      channel_id: RK, channel_name: 'AMAZON RK WORLD', channel_location_code: code, uniware_customer_code: `AMAZON_RK_WORLD_${code}_${pin}`, channel_code: 'OTHER_B2B',
      facility_code: 'TEST_WH1', consignee_pin_code: null, final_shipping_address: `Amazon ${code}`, is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};
/** Before the window ends (7 Oct): the sample is not expired. */
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.AMAZON_RK_WORLD), new Date('2026-09-24T06:00:00Z'));

beforeEach(async () => {
  sheet.rows = GRID;
  ocrCalls.n = 0;
  await resetDb();
  await seedMasters();
});
afterAll(closeDb);

describe('Vendor Central export -> one processed.json per PO (amazon-rk-world.handler)', () => {
  it('splits by PO; header from the first line; ASIN / EAN (only when its type is EAN) / Model number; qty = requested; Cost before GST', async () => {
    const pos = await process();
    expect(pos.map((p) => [p.channel_name, p.po_number, p.po_date, p.expiry_date, p.delivery_facility_code, p.total_line_items, p.total_qty])).toEqual([
      ['amazon_rk_world', '5F5AJUWB', '2026-09-22', '2026-10-07', 'HKA2', 2, 60],
      ['amazon_rk_world', '81U8GGMU', '2026-09-22', '2026-10-07', 'HNR4', 2, 96],
    ]);
    expect(pos[1].line_items.map((l) => [l.channel_sku_code, l.ean, l.pep_sku_code, l.qty, l.unit_cost, l.line_total, l.gst, l.landing_rate])).toEqual([
      ['B09X6SQ6VW', '', '55MCaf40', 60, 161.66, 9699.6, '', ''], ['B0DP6DJFZD', '8906129575332', 'MCaf370', 36, 240.88, 8671.68, '', ''],
    ]);
    expect(pos[0].unmapped).toMatchObject({ Status: 'Unconfirmed', 'Vendor code': 'XN8TZ' });
    expect(pos.flatMap((p) => p.warnings)).toEqual([]);
  });

  it('cancelled availability (CA / OS / R2 / CP) and nothing left after cancellations are left out, with why; a closed PO keeps no lines', async () => {
    const pos = await process([
      H,
      row('P1', 'A1', 'EAN', '1', 'X1', '10', 'HKA2', '100', { availability: 'CA - Cancelled: Not available' }),
      row('P1', 'A2', 'EAN', '2', 'X2', '10', 'HKA2', '100', { availability: 'OS - Cancelled: Out of stock' }),
      row('P1', 'A3', 'EAN', '3', 'X3', '10', 'HKA2', '100', { cancelled: '4' }),
      row('P1', 'A4', 'EAN', '4', 'X4', '10', 'HKA2', '100', { cancelled: '10' }),
      row('P2', 'A5', 'EAN', '5', 'X5', '10', 'HKA2', '100', { status: 'Closed' }),
    ]);
    expect(pos[0].line_items.map((l) => [l.channel_sku_code, l.qty])).toEqual([['A3', 6]]);
    expect(pos[0].warnings.map((w) => w.code)).toEqual(['LINE_SKIPPED', 'LINE_SKIPPED', 'LINE_SKIPPED']);
    expect(pos[0].warnings[0].message).toContain('CA - Cancelled');
    expect(pos[1].line_items).toEqual([]);
    expect(pos[1].warnings.map((w) => w.code)).toEqual(['PO_STATUS_NOT_TAKEN']);
  });
});

describe('Amazon RK World checks', () => {
  it('SKU by ASIN, Cost + our 18% GST vs our rate, FC code = location: valid', async () => {
    await seedRk('asin');
    const [p1, p2] = await process();
    const v = await validate(p1);
    expect(v.location).toMatchObject({ locationCode: 'HKA2', matchedBy: 'code' });
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([['B0FH2Q8PT3', 'Mcaf396_WB', 290.06], ['B0DP6DJFZD', 'MCaf370', 284.24]]);
    expect(v.issues).toEqual([]);
    expect((await validate(p2)).issues).toEqual([]);
  });

  it('master keyed by another code: found by the line EAN, else by the Model number (our code)', async () => {
    await seedRk('ean');
    const [, p2] = await process();
    const v = await validate(p2);
    // 55MCaf40 has no EAN in the export: found by Model number; MCaf370 by EAN
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode])).toEqual([['B09X6SQ6VW', '55MCaf40'], ['B0DP6DJFZD', 'MCaf370']]);
    expect(v.issues).toEqual([]);
  });

  it('no SKU rows yet (as on dev, 6 Nov): review, SKU not mapped with the Model number as the hint; after the window: expired', async () => {
    await seedRk('none');
    const [p1] = await process();
    const v = await validate(p1);
    expect([...new Set(v.issues.map((i) => i.type))]).toEqual(['SKU_NOT_MAPPED']);
    expect(v.issues[0].message).toContain('Mcaf396_WB');
    const late = await validatePo(p1, await new MasterDataReader(await db()).forChannel(CHANNELS.AMAZON_RK_WORLD), new Date('2026-11-06T06:00:00Z'));
    expect(late.issues.map((i) => i.type)).toContain('PO_EXPIRED');
  });
});

describe('Manual Upload: the whole Amazon RK World flow (no OCR)', () => {
  it('one .xls -> 2 POs, each its own sale order; no OCR call', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-24T06:00:00Z') });
    try {
      const reviewer = await loginAs('operations-executive');
      await seedRk('asin');
      const list = (await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200)).body.data;
      expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'amazon_rk_world', name: 'AMAZON RK WORLD', group: 'manual', manyPos: true })]));
      const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'amazon_rk_world')
        .attach('files', Buffer.from('xls bytes'), 'POItemExport_2026-09-22.xls').expect(201);
      const [id] = up.body.data.ids as string[];
      await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
      await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
      expect(ocrCalls.n).toBe(0);
      const made = await rows<{ status: string; po_number: string }>('SELECT status, po_number FROM po_uploads WHERE email_message_id = ? ORDER BY po_number', [`manual-upload:${id}`]);
      expect(made).toEqual([{ status: 'completed', po_number: '5F5AJUWB' }, { status: 'completed', po_number: '81U8GGMU' }]);
      const pos = await rows<{ poNumber: string; location: string }>("SELECT poNumber, location FROM master_purchase_orders WHERE poNumber IN ('5F5AJUWB', '81U8GGMU') ORDER BY poNumber");
      expect(pos.map((p) => [p.poNumber, p.location])).toEqual([['5F5AJUWB', 'HKA2'], ['81U8GGMU', 'HNR4']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('another sheet (no ASIN / Requested quantity columns): the upload fails with why', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedRk('asin');
    sheet.rows = [['Instructions'], ['a', 'b']];
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'amazon_rk_world')
      .attach('files', Buffer.from('xls'), 'POItemExport_other.xls').expect(201);
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('failed'), { timeout: 20_000 });
    expect((await rows<{ note: string }>('SELECT note FROM manual_uploads WHERE id = ?', [id]))[0].note).toContain('no row with the column names');
  });
});
