import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { slikkHandler } from '../../src/modules/po-processing/channels/slikk/slikk.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { extractPo } from '../../src/modules/ocr/extract-po.service';
import { api, loginAs, type TestLogin } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';

/*
 * Slikk by Manual Upload (2026-11-02): PDF + its sheet only (OCR "slikk": header from the PDF, lines from the sheet; the PDF
 * alone is refused, user). Sale order when everything fits, else review with the reason (user). Values follow SLIKPO#679
 * (Downloads/slikk). The OCR itself is replaced by a recorder: only which OCR entry was asked for is checked here.
 */
const ocrCalls = vi.hoisted(() => [] as { channel: string; files: string[] }[]);
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async (channel: string, files: string[]) => {
    ocrCalls.push({ channel, files });
    return { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'OCR is off in tests' }, log: '' };
  }),
}));

const SK = CHANNEL_MASTER_IDS[CHANNELS.SLIKK];
const header = {
  'PO Number': 'SLIKPO#679', 'PO Date': '29 May 2026', 'PO Expiry Date': '15 Jun 2026', 'Nature Of Supply': 'FOB Purchase',
  'Billed By GSTIN': '27AAICP2804J1ZC', 'Billed To GSTIN': '29ABNCS2146N1ZN',
  'Shipped To Address': 'Shed No 2, Sy.No.88/2, Dodda Dasarahalli Village, Jadigenahalli Hobli, Hosakote Taluk, Bengaluru District, Karnataka – 562114 Tel: +91 80 2990 0201',
  'Total Quantity': '180', 'Taxable Value': '54255.00 INR', 'Tax Amount': '9730.85 INR', 'Total Amount': '67985.85 INR',
};
// The sheet's lines: our pep code, an EAN as Excel writes it, our pep code again.
const sheetLine = (sku: string, qty: number, mrp: number, pu: number, taxable: number, tax: number, total: number, order = 'SLIKPO#679') => ({
  Order: order, 'Product Name': `item ${sku}`, 'SKU Id': sku, 'Vendor Sku': sku, 'HSN Code': '33041000', MRP: mrp.toFixed(2), 'Expected Selling price/per pc': mrp.toFixed(2),
  'Allocate qty': String(qty), 'Expected GST rate on final sale': '18.00', 'Discount /Commission%': '25.00', 'Total Purchase Price': taxable.toFixed(2),
  'Purchase price/pu': pu.toFixed(2), 'Total GST Value': tax.toFixed(2), 'Total Purchase Price with GST': total.toFixed(2),
});
const sheet: RawOcr = {
  header,
  lines: [
    sheetLine('HYPMUBX042F010', 150, 399, 299.25, 44887.5, 8079.75, 52967.25),
    sheetLine('8.906129575349E12', 10, 499, 374.25, 3742.5, 673.7, 4416.2),
    sheetLine('Mcaf401', 20, 599, 449.25, 8985, 1617.4, 10602.4),
  ],
  lineColumns: [], inputType: 'pdf+sheet', inputFiles: ['0732ef90.pdf', 'orderItems (18).csv'], sourceFile: 'raw.json',
};
const process = async (raw: RawOcr) =>
  (await slikkHandler.process({ folder: '/tmp/slikk-test', meta: {}, channel: CHANNELS.SLIKK, raw, body: '', subject: '' })) as ProcessedPo;

/** SLIKK's master as on dev: channel_code = the EAN, our pep code on the same row; rates = Slikk's PO prices with GST. */
const seedSlikk = async (o: { pincode?: string | null; rate042?: number } = {}) => {
  await insert('master_channels', { id: SK, slug: 'slikk', display_name: 'SLIKK', db_aliases: ['SLIKK', 'slikk'], has_processor: 0, is_active: 1 });
  // As on dev (2 Nov): MCaf371's row carries HYPMUBX042F010's EAN as channel_code; its own EAN is only in ean_code.
  // 8906129575646 is the EAN of two of our codes (MCaf383_WB / _N1).
  for (const [pep, code, ean, mrp, rate] of [
    ['HYPMUBX042F010', '8906171510589', '8906171510589', 399, o.rate042 ?? 353.12],
    ['MCaf371', '8906171510589', '8906129575349', 499, 441.62],
    ['Mcaf401', '8906129576001', '8906129576001', 599, 530.12],
    ['MCaf383_WB', 'MCAF383', '8906129575646', 399, 311.22],
    ['MCaf383_WB_N1', 'MCAF383N1', '8906129575646', 399, 311.22],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'Hyphen', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: SK, channel_name: 'SLIKK', channel_code: code, ean_code: ean, mrp, margin: 0.25, rate_after_margin: rate, is_active: 1 });
  }
  await insert('details_channels', {
    channel_id: SK, channel_name: 'SLIKK', channel_location_code: 'BANGALORE_2', uniware_customer_code: 'SLIKK_BANGALORE_2_562114', channel_code: 'SLIKK',
    facility_code: 'TEST_WH1', consignee_pin_code: o.pincode === undefined ? '562114' : o.pincode, is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.SLIKK), new Date('2026-06-01T06:00:00Z'));

let reviewer: TestLogin;
beforeEach(async () => {
  await resetDb();
  await seedMasters(); // BigBasket + the warehouse TEST_WH1
  reviewer = await loginAs('operations-executive');
  ocrCalls.length = 0;
});
afterAll(closeDb);

describe('Slikk -> processed.json (slikk.handler)', () => {
  it('PDF + sheet: header from the PDF, lines from the sheet (EAN from Excel\'s 8.9…E12), price with GST, "… INR" totals', async () => {
    const po = await process(sheet);
    expect(po).toMatchObject({
      channel_name: 'slikk', po_number: 'SLIKPO#679', po_date: '2026-05-29', expiry_date: '2026-06-15', delivery_pincode: '562114',
      delivery_gstin: '29ABNCS2146N1ZN', vendor_gstin: '27AAICP2804J1ZC', total_line_items: 3, total_qty: 180, po_value: 67985.85, net_amount: 67985.85,
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.ean, l.hsn, l.qty, l.channel_mrp, l.unit_cost, l.landing_rate, l.line_total, l.gst])).toEqual([
      [1, 'HYPMUBX042F010', '', '33041000', 150, 399, 299.25, 353.12, 52967.25, 18],
      [2, '8906129575349', '8906129575349', '33041000', 10, 499, 374.25, 441.62, 4416.2, 18],
      [3, 'Mcaf401', '', '33041000', 20, 599, 449.25, 530.12, 10602.4, 18],
    ]);
    expect(po.needs_review).toBeFalsy();
    expect(po.warnings).toEqual([]);
  });

  it('a sheet of another PO than the PDF: marked for review with the reason', async () => {
    const po = await process({ ...sheet, lines: [sheet.lines[0], { ...sheet.lines[1], Order: 'SLIKPO#680' }] });
    expect(po.needs_review).toBe(true);
    expect(po.review_reasons?.[0]).toContain('SLIKPO#680');
  });
});

describe('Slikk checks (validation against the masters)', () => {
  it('everything fits -> no issue (a sale order): SKUs by EAN (channel code) or by our code, location by pincode', async () => {
    await seedSlikk();
    const v = await validate(await process(sheet));
    expect(v.issues).toEqual([]);
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode])).toEqual([['HYPMUBX042F010', 'HYPMUBX042F010'], ['8906129575349', 'MCaf371'], ['Mcaf401', 'Mcaf401']]);
    expect(v.location).toMatchObject({ locationCode: 'BANGALORE_2', matchedBy: 'pincode' });
  });

  it('an EAN the master gives to two of our codes is ambiguous (review); the duplicated channel_code is never matched by EAN', async () => {
    await seedSlikk();
    const v = await validate(await process({ ...sheet, lines: [sheetLine('8906129575646', 10, 399, 263.75, 2637.5, 474.75, 3112.25)], header: { ...header, 'Total Amount': '3112.25 INR', 'Total Quantity': '10' } }));
    expect(v.issues.map((i) => i.type)).toEqual(['SKU_NOT_MAPPED']);
    expect(v.issues[0].message).toContain('MCaf383_WB');
    // HYPMUBX042F010's EAN as SKU Id: two SLIKK rows carry it as channel_code -> ambiguous too (until the master is fixed)
    const w = await validate(await process({ ...sheet, lines: [sheetLine('8906171510589', 150, 399, 299.25, 44887.5, 8079.75, 52967.25)], header: { ...header, 'Total Amount': '52967.25 INR', 'Total Quantity': '150' } }));
    expect(w.issues.map((i) => i.type)).toEqual(['SKU_NOT_MAPPED']);
  });

  it('review with the reasons: our rate differs (price check), location without a pincode, unknown SKU, wrong sheet', async () => {
    await seedSlikk({ pincode: null, rate042: 284.29 });
    const po = await process({ ...sheet, lines: [...sheet.lines, sheetLine('HYPCOMB017003', 5, 999, 749.25, 3746.25, 674.33, 4420.58), { ...sheet.lines[2], Order: 'SLIKPO#680' }] });
    const v = await validate(po);
    expect(v.issues.map((i) => i.type).sort()).toEqual(['LOCATION_NOT_MAPPED', 'OTHER', 'PRICE_MISMATCH', 'SKU_NOT_MAPPED']);
  });
});

describe('Manual Upload + OCR entry for Slikk', () => {
  const upload = (files: [string, string][]) => {
    const req = api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'slikk');
    for (const [name, body] of files) req.attach('files', Buffer.from(body), name);
    return req;
  };
  const folders = async () => (await rows<{ folder: string }>('SELECT folder FROM manual_uploads ORDER BY id')).map((r) => r.folder);

  it('listed in the Manual group as PDF + sheet; the pair is one PO, run by OCR "slikk" with both files', async () => {
    await seedSlikk();
    const list = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(list.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'slikk', group: 'manual', twoFiles: true })]));
    expect((await upload([['0732ef90.pdf', '%PDF-1.4'], ['orderItems (18).csv', 'Order,SKU Id\nSLIKPO#679,HYPMUBX042F010']])).status).toBeLessThan(300);
    const [pair] = await folders();
    await extractPo(pair);
    expect(ocrCalls.map((c) => [c.channel, c.files.length])).toEqual([['slikk', 2]]);
  });

  it('refused (user: PDF + sheet only): the PDF alone, the sheet alone, several pairs whose names do not match', async () => {
    await seedSlikk();
    expect((await upload([['0732ef90.pdf', '%PDF-1.4']])).status).toBe(400);
    expect((await upload([['orderItems (18).csv', 'x']])).status).toBe(400);
    expect((await upload([['a.pdf', '%PDF'], ['b.pdf', '%PDF'], ['orderItems (18).csv', 'x'], ['orderItems (52).csv', 'x']])).status).toBe(400);
    expect(await rows('SELECT id FROM manual_uploads')).toEqual([]);
  });
});
