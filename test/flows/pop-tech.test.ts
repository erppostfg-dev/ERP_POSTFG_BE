import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { popTechHandler } from '../../src/modules/po-processing/channels/pop-tech/pop-tech.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters } from '../helpers/fixtures';

/*
 * Pop Tech by Manual Upload (2026-11-02): the Unicommerce PO PDF -> OCR PDF pipeline (tax cells split, unlabeled totals
 * row) -> pop-tech.handler -> processed.json -> validation (SKU by the EAN = Pop Tech's channel_code, location by the
 * Ship to pincode; anything missing in the masters -> review). Lines below = PO DL_MCFN004 (Downloads/POP TEch, 06-Jul-2026).
 */
const PT = CHANNEL_MASTER_IDS[CHANNELS.POP_TECH];
const line = (no: number, name: string, ean: string, qty: number, rate: number, mrp: number, taxable: string, tax: string, amount: string) => ({
  'SI No.': String(no), 'Product Name': name, 'EAN code': ean, QTY: String(qty), Rate: String(rate), MRP: mrp.toFixed(2),
  'Taxable Value': taxable, SGST: tax, 'SGST Rate': '9.000%', CGST: tax, 'CGST Rate': '9.000%', Amount: amount,
});
const raw: RawOcr = {
  header: {
    'PO Number': 'DL_MCFN004', 'PO Date': '06-Jul-2026', 'Expiry Date': '15-Aug-2026', 'Delivery Date': '14-Aug-2026',
    'Buyer Name': 'Curioso Fashions Pvt Ltd', 'Buyer GSTIN': '29AAKCC4371P1ZX', 'Vendor Name': 'PEP TECHNOLOGIES PRIVATE LIMITED',
    'Vendor GSTIN': '27AAICP2804J1ZC', 'Ship To Name': 'CURIOSO FASHIONS PRIVATE LIMITED-GGN',
    'Ship To Address': 'Delhivery Private Limited, Khasra No 14/24/212, 16/3/2, 4/2, 5/2/1, 6/2/7, Gurgoan - 122001 Haryana (06)',
    'Ship To Phone': '9999999999', 'Ship To GSTIN': '06AAKCC4371P1Z5', 'Payment Terms': 'As per Agreement',
    'Total QTY': '580', 'Total Taxable Value': '188177.80', 'Total SGST': '16936.01', 'Total CGST': '16936.01', 'Total Amount': '222049.82',
  },
  lines: [
    line(1, 'Summer Breeze Perfume Body Lotion - 300ml', '8906129575349', 50, 338.31, 499, '16915.50', '1522.40', '19960.30'),
    line(2, 'Guava Tini De-tan Body Wash - 300ml', '8906129575929', 290, 304.41, 449, '88278.90', '7945.10', '104169.10'),
    line(3, 'All I Need Sunscreen Spf 50 Pa ++++| Uva & Uvb Sun Protection & Blue Light Protection - 50ml', '8906171510039', 100, 304.41, 449, '30441.00', '2739.69', '35920.38'),
    line(4, '18% Brightening + 20% Collagen Face Serum - 50ml', '8906171510534', 100, 440, 649, '44000.00', '3960.00', '51920.00'),
    line(5, 'All I Need Sunscreen For All Skin Types Spf50 - 30ml', '8906171510558', 40, 213.56, 315, '8542.40', '768.82', '10080.04'),
  ],
  lineColumns: [], inputType: 'pdf', inputFiles: ['DL_MCFN004.pdf'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await popTechHandler.process({ folder: '/tmp/pop-tech-test', meta: {}, channel: CHANNELS.POP_TECH, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/**
 * POP TECH's master as on dev (2 Nov, read-only check): channel_code = EAN (ean_code too), rate = MRP x 0.8 with tax;
 * 8906129575929 on Mcaf396_WB AND Mcaf396 (both columns); 8906129570856 as channel_code on MTOOL7_NL_S + MTOOL7_NL, as
 * ean_code only on MTOOL7_NL_S; the locations keep their pincode only in final_shipping_address (consignee_pin_code NULL).
 */
const seedPopTech = async () => {
  await insert('master_channels', { id: PT, slug: 'pop-tech', display_name: 'POP TECH', db_aliases: ['POP TECH', 'pop-tech'], has_processor: 0, is_active: 1 });
  for (const [pep, code, ean, mrp, rate] of [
    ['MCaf371', '8906129575349', '8906129575349', 499, 399.2], ['Mcaf396_WB', '8906129575929', '8906129575929', 449, 359.2],
    ['Mcaf396', '8906129575929', '8906129575929', 449, 359.2], ['HYPMUBX004F050', '8906171510039', '8906171510039', 449, 359.2],
    ['HYPMUBX038F050', '8906171510534', '8906171510534', 649, 519.2], ['HYPMUBX004F030', '8906171510558', '8906171510558', 315, 252],
    ['MTOOL7_NL_S', '8906129570856', '8906129570856', 199, 159.2], ['MTOOL7_NL', '8906129570856', null, 199, 159.2],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'mCaffeine', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: PT, channel_name: 'POP TECH', channel_code: code, ean_code: ean, mrp, margin: 0.2, rate_after_margin: rate, is_active: 1 });
  }
  for (const [code, pin, address] of [
    ['BANGLORE', '562114', 'Delhivery Limited. Survey no. 221,Village Kolathur, Hobli, behind Satya Sai Public School, Kasaba, Taulka, Hoskote, Bengaluru -562114'],
    ['GURGOAN', '122001', 'Delhivery Private Limited, Khasra No 14/24/212, 16/3/2, 4/2, 5/2/1, 6/2/7, Gurgoan - 122001 Haryana 122001'],
  ]) {
    await insert('details_channels', {
      channel_id: PT, channel_name: 'POP TECH', channel_location_code: code, uniware_customer_code: `POP_TECH_${code}_${pin}`, channel_code: 'OTHER_B2B',
      facility_code: 'TEST_WH1', consignee_pin_code: null, final_shipping_address: address, is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.POP_TECH), new Date('2026-07-07T06:00:00Z'));

beforeEach(async () => {
  await resetDb();
  await seedMasters(); // BigBasket + the warehouse TEST_WH1
});
afterAll(closeDb);

describe('Pop Tech PDF -> processed.json (pop-tech.handler)', () => {
  it('reads the header, the lines (EAN = channel code, GST from the split cells, price with tax = Rate x 1.18) and the totals row', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'pop_tech', po_number: 'DL_MCFN004', po_date: '2026-07-06', expiry_date: '2026-08-15', expected_date: '2026-08-14',
      delivery_pincode: '122001', delivery_gstin: '06AAKCC4371P1Z5', vendor_gstin: '27AAICP2804J1ZC',
      total_line_items: 5, total_qty: 580, po_value: 222049.82, cart_discount: 0, net_amount: 222049.82,
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.ean, l.qty, l.unit_cost, l.gst, l.landing_rate, l.channel_mrp, l.line_total])).toEqual([
      [1, '8906129575349', '8906129575349', 50, 338.31, 18, 399.21, 499, 19960.3],
      [2, '8906129575929', '8906129575929', 290, 304.41, 18, 359.2, 449, 104169.1],
      [3, '8906171510039', '8906171510039', 100, 304.41, 18, 359.2, 449, 35920.38],
      [4, '8906171510534', '8906171510534', 100, 440, 18, 519.2, 649, 51920],
      [5, '8906171510558', '8906171510558', 40, 213.56, 18, 252, 315, 10080.04],
    ]);
    expect(po.line_items[0].unmapped).toMatchObject({ 'Taxable Value': '16915.50', SGST: '1522.40', CGST: '1522.40' });
    expect(po.unmapped).toMatchObject({ 'Buyer Name': 'Curioso Fashions Pvt Ltd', 'Total Taxable Value': '188177.80', 'Payment Terms': 'As per Agreement' });
    expect(po.warnings).toEqual([]);
  });

  it('no totals row: the lines\' sums; a Total Amount that differs: warning; IGST used on an inter-state PO; no EAN / GST: warnings', async () => {
    const { 'Total QTY': _q, 'Total Amount': _a, ...rest } = raw.header;
    const calc = await process({ header: rest });
    expect(calc).toMatchObject({ total_qty: 580, po_value: 222049.82 });
    expect(calc.field_sources).toMatchObject({ total_qty: 'calculated', po_value: 'calculated' });
    expect((await process({ header: { ...raw.header, 'Total Amount': '230000.00' } })).warnings.map((w) => w.code)).toContain('PO_VALUE_MISMATCH');
    const { SGST: _s, 'SGST Rate': _sr, CGST: _c, 'CGST Rate': _cr, ...noTax } = raw.lines[0];
    const igst = await process({ lines: [{ ...noTax, IGST: '3044.79', 'IGST Rate': '18.000%' }] });
    expect(igst.line_items[0]).toMatchObject({ gst: 18, landing_rate: 399.21 });
    expect((await process({ lines: [noTax] })).warnings.map((w) => w.code)).toContain('GST_COLUMNS_MISSING');
    const { 'EAN code': _e, ...noEan } = raw.lines[0];
    expect((await process({ lines: [noEan] })).warnings.map((w) => w.code)).toContain('RAW_FIELD_MISSING');
  });

  it('a Ship to box with no name or GSTIN (DL_MCFN002): the pincode still comes from the address', async () => {
    const { 'Ship To Name': _n, 'Ship To GSTIN': _g, ...rest } = raw.header;
    const po = await process({ header: rest });
    expect(po).toMatchObject({ delivery_pincode: '122001', delivery_gstin: '' });
  });
});

describe('Pop Tech checks (validation against the masters)', () => {
  it('as on dev: location by the pincode in its address, SKUs by EAN; an EAN on two of our codes -> review', async () => {
    await seedPopTech();
    const v = await validate(await process());
    expect(v.location).toMatchObject({ locationCode: 'GURGOAN', customerCode: 'POP_TECH_GURGOAN_122001', matchedBy: 'pincode' });
    expect(v.issues.map((i) => [i.type, i.lineNo])).toEqual([['SKU_NOT_MAPPED', 2]]);
    expect(v.issues[0].message).toContain('Mcaf396');
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([
      ['8906129575349', 'MCaf371', 399.2], ['8906129575929', '', ''], ['8906171510039', 'HYPMUBX004F050', 359.2],
      ['8906171510534', 'HYPMUBX038F050', 519.2], ['8906171510558', 'HYPMUBX004F030', 252],
    ]);
  });

  it('a channel_code on two of our codes: the one whose ean_code is the line’s EAN is taken (MTOOL7_NL_S)', async () => {
    await seedPopTech();
    const mtool = { ...raw.lines[0], 'EAN code': '8906129570856', QTY: '10', Rate: '134.92', MRP: '199.00', Amount: '1592.06' };
    const v = await validate(await process({ lines: [mtool] }));
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode])).toEqual([['8906129570856', 'MTOOL7_NL_S']]);
    expect(v.issues.filter((i) => i.type === 'SKU_NOT_MAPPED')).toEqual([]);
  });

  it('once Mcaf396_WB is off, the PO passes; a consignee_pin_code wins over the address; Bangalore by 562114', async () => {
    await seedPopTech();
    const conn = await db();
    await conn.query("UPDATE master_channel_skus SET is_active = 0 WHERE pep_code = 'Mcaf396_WB'");
    expect((await validate(await process())).issues).toEqual([]);
    const blr = { ...raw.header, 'Ship To Address': 'Delhivery Limited. Survey no. 221, Hoskote, Bengaluru - 562114 Karnataka (29)' };
    expect((await validate(await process({ header: blr }))).location).toMatchObject({ locationCode: 'BANGLORE' });
    // a location with its own consignee_pin_code is matched by that column only, never by its address
    await conn.query("UPDATE details_channels SET consignee_pin_code = '122002' WHERE channel_location_code = 'GURGOAN'");
    const v = await validate(await process());
    expect(v.issues.map((i) => i.type)).toContain('LOCATION_NOT_MAPPED');
  });

  it('a Rate that does not give our price with tax -> price issue', async () => {
    await seedPopTech();
    const v = await validate(await process({ lines: [{ ...raw.lines[0], Rate: '330.00', Amount: '19470.00' }] }));
    expect(v.issues.map((i) => i.type)).toContain('PRICE_MISMATCH');
  });
});

describe('Manual Upload offers Pop Tech', () => {
  it('in the Manual group, one PDF per PO; the PDF is stored and waits for Process', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedPopTech();
    const res = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'pop_tech', name: 'POP TECH', group: 'manual', twoFiles: false })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'pop_tech')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'DL_MCFN004.pdf');
    expect(up.status).toBeLessThan(300);
    expect((await rows<{ status: string }>('SELECT status FROM manual_uploads'))[0]).toMatchObject({ status: 'uploaded' });
    expect([...s3Objects().keys()].some((k) => k.includes('manual-upload') && k.endsWith('.pdf'))).toBe(true);
  });
});
