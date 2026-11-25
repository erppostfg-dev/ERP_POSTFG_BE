import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { flipkartQcomHandler } from '../../src/modules/po-processing/channels/flipkart-qcom/flipkart-qcom.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { dmy, FUTURE_EXPIRY } from '../helpers/dates';
import { seedMasters } from '../helpers/fixtures';

/*
 * Flipkart Quick Commerce by Manual Upload (2026-10-30): purchase_order_<PO>.xls read by the OCR sheet pipeline (lines
 * and footer by Python with the sheet's names; header labels by its model), flipkart-qcom.handler -> processed.json,
 * validation by FSN (Flipkart Qcom channel SKUs) and the SHIPPED TO ADDRESS pincode. The raw output below is
 * FASWN08497679 (Documents/POs, 17-09-26) as the pipeline returns it: amounts without INR, footer totals merged in.
 */
const QC = CHANNEL_MASTER_IDS[CHANNELS.FLIPKART_QCOM];
const SHIP_TO = 'Flipkart India Pvt. Ltd., Hillway Industrial and logistics Park, Survey No.672, Village Hariyala NH -8,Vadala Road Near BPCL Gas Plant Tehsil,District Kheda Gujarat,Nadiad Kheda Gujarat -387570 nadiad 387570';
const line = (n: number, fsn: string, qty: number, mrp: number, price: number, total: number) => ({
  'S. no.': String(n), 'HSN/SA Code': '33049190', 'FSN/ISBN13': fsn, Quantity: String(qty), 'Pending Quantity': String(qty), UOM: 'pcs',
  Title: `mCaffeine item ${n}`, Brand: 'mCaffeine', Ean: `890612957${n}000`, Vertical: 'moisturizer_cream', 'Required by Date': '2026-10-06',
  'Supplier MRP': String(mrp), 'Supplier Price': String(price), 'Taxable Value': '0', 'IGST Rate': '18.0%', 'IGST Amount(per unit)': '0',
  'SGST/UTGST Rate': '0.0%', 'CGST Rate': '0.0%', 'CESS Rate': '0.0%', 'Tax Amount': '0', 'Total Amount': String(total),
});
const raw: RawOcr = {
  header: {
    'PO#': 'FASWN08497679', 'ORDER DATE': '17-09-26', 'PO Expiry': '06-10-26', 'Nature of Transaction': 'Inter-State',
    GSTIN: '27AAICP2804J1ZC', 'GSTIN 2': '24AABCF8078M2Z6', 'SHIPPED TO ADDRESS': SHIP_TO,
    'Total Quantity': '756', 'Total Taxable Value': '310559.76', 'Total Tax Amount': '55902.24', 'Total Amount': '366462',
  },
  lines: [
    line(1, 'MSCH6ZWCGRG5V3SP', 36, 499, 249.5, 8982),
    line(2, 'MSCHD2RYSTXG3GGA', 648, 998, 499, 323352),
    line(3, 'CBKHGGYAH97MGAUH', 72, 948, 474, 34128),
  ],
  lineColumns: [], inputType: 'sheet', inputFiles: ['purchase_order_FASWN08497679.xls'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await flipkartQcomHandler.process({ folder: '/tmp/fkqc-test', meta: {}, channel: CHANNELS.FLIPKART_QCOM, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/** Flipkart Qcom's master: the PO's three FSNs at the Qcom rates (= Supplier Price), Hillway at 387570. */
const seedQcom = async () => {
  await insert('master_channels', { id: QC, slug: 'flipkart-qcomm', display_name: 'Flipkart Qcom', db_aliases: ['Flipkart Qcom', 'flipkart_qcom'], has_processor: 0, is_active: 1 });
  for (const [pep, fsn, mrp, rate] of [['MCaf370', 'MSCH6ZWCGRG5V3SP', 499, 249.5], ['CMB554_S', 'MSCHD2RYSTXG3GGA', 998, 499], ['CMB560_S', 'CBKHGGYAH97MGAUH', 948, 474]] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'mCaffeine', product_type: 'Combo', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: QC, channel_name: 'Flipkart Qcom', channel_code: fsn, mrp, margin: 0.5, rate_after_margin: rate, is_active: 1 });
  }
  await insert('details_channels', {
    channel_id: QC, channel_name: 'Flipkart Qcom', channel_location_code: 'Ahmedabad', uniware_customer_code: 'FLIPKART_QCOM_AHMEDABAD', channel_code: 'FLIPKART_QCOM',
    facility_code: 'TEST_WH1', consignee_pin_code: '387570', is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
};

beforeEach(async () => {
  await resetDb();
  await seedMasters(); // BigBasket + the warehouse TEST_WH1
});
afterAll(closeDb);

describe('Flipkart Qcom sheet -> processed.json (flipkart-qcom.handler)', () => {
  it('reads the header (two-digit-year dates, Flipkart\'s GSTIN, Ship To pincode), the lines and the footer', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'flipkart_qcom', po_number: 'FASWN08497679', po_date: '2026-09-17', expiry_date: '2026-10-06', expected_date: '2026-10-06',
      delivery_pincode: '387570', delivery_gstin: '24AABCF8078M2Z6', total_line_items: 3, total_qty: 756, po_value: 366462, net_amount: 366462,
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.qty, l.channel_mrp, l.landing_rate, l.line_total, l.gst])).toEqual([
      [1, 'MSCH6ZWCGRG5V3SP', 36, 499, 249.5, 8982, 18],
      [2, 'MSCHD2RYSTXG3GGA', 648, 998, 499, 323352, 18],
      [3, 'CBKHGGYAH97MGAUH', 72, 948, 474, 34128, 18],
    ]);
    expect(po.line_items[0].unmapped).toMatchObject({ 'Pending Quantity': '36', Vertical: 'moisturizer_cream' });
    expect(po.unmapped).toMatchObject({ 'Nature of Transaction': 'Inter-State', 'Total Taxable Value': '310559.76' });
    expect(po.warnings).toEqual([]);
  });

  it('other header spellings from the model; no footer -> the lines\' sums; a footer that differs -> warning', async () => {
    const { 'Total Quantity': _q, 'Total Amount': _a, 'PO#': _p, ...rest } = raw.header;
    const po = await process({ header: { ...rest, 'PO Number': 'FASWN08497679', 'Order Date': '17-09-26' } });
    expect(po).toMatchObject({ po_number: 'FASWN08497679', po_date: '2026-09-17', total_qty: 756, po_value: 366462 });
    expect(po.field_sources).toMatchObject({ total_qty: 'calculated', po_value: 'calculated' });
    const off = await process({ header: { ...raw.header, 'Total Amount': '366999' } });
    expect(off.warnings.map((w) => w.code)).toContain('PO_VALUE_MISMATCH');
  });
});

/*
 * Flipkart's NEW sheet (first seen 2026-11-23, FLSZ5YI9E7FE .xlsx) as the OCR sheet pipeline returns it: two-row line
 * header ("Product Details <name>"), FSN = "Product ID", price = "Supplier Unit Price", amounts "224.50 (INR)", rates
 * "18.00 %", 4-digit dates, footer with Total Quantity only. Before the fix every line came out with no SKU and no price.
 */
const NEW_SHIP_TO = 'Prime space industrial park, # 125, Orakkadu Village, Ponneri Taluk Sholavaram Panchayat, Tiruvallur District, Tamil Nadu 600067 Chennai Tamil Nadu 600067 India';
const newLine = (n: number, fsn: string, qty: number, mrp: string, price: string, total: string) => ({
  'S. no.': String(n), 'HSN/SAC Code': '33049990', 'Product ID': fsn, Quantity: String(qty), 'Approved Units': '0', UOM: 'pcs', 'Pending Quantity': '0',
  'Product Details Title': `mCaffeine Body Wash ${n}`, 'Product Details Ean': '8906129575929', 'Product Details Brand': 'mCaffeine',
  'Product Details Color': '', 'Product Details Vertical': 'BodyWash', 'Product Details Required by Date': '',
  'Product Details Supplier Unit Price': price, 'Product Details IGST Rate': '18.00 %', 'Product Details IGST Amount(per unit)': '34.25 (INR)',
  'Product Details SGST/UTGST Rate': '0.00 %', 'Product Details CGST Rate': '0.00 %', 'Product Details CESS Rate': '',
  'Product Details Supplier MRP': mrp, 'Product Details Taxable Value': '9132.20 (INR)', 'Product Details Tax Amount': '1643.80 (INR)',
  'Product Details Total Amount': total,
});
const newRaw: Partial<RawOcr> = {
  header: {
    'Buyer Name': 'FLIPKART INDIA PRIVATE LIMITED', 'Purchase Order Number': 'FLSZ5YI9E7FE', 'Expiry Date': dmy(FUTURE_EXPIRY, '/'), 'Order Date': '22/11/2026',
    'Billed From GSTIN': '27AAICP2804J1ZC', 'Billed To GSTIN': '33AABCF8078M1Z8', 'Shipped To Address': NEW_SHIP_TO, 'Shipped To GSTIN': '33AABCF8078M1Z8',
    Currency: 'INR', 'Total Quantity': '76', 'Total Approved Units': '0', 'Total Pending Quantity': '0',
  },
  lines: [newLine(1, 'BWSHDUMZJAUCUHUR', 48, '449.00 (INR)', '224.50 (INR)', '10776.00 (INR)'), newLine(2, 'BWSHJYA2VSNKVZXW', 28, '499.00 (INR)', '249.50 (INR)', '6986.00 (INR)')],
  inputFiles: ['purchase_order_FLSZ5YI9E7FE.xlsx'],
};

describe('Flipkart Qcom NEW sheet (2026-11-23: Product ID, Product Details ..., amounts with (INR))', () => {
  it('reads FSN, price, MRP, total and GST from the new columns; no missing-field warnings', async () => {
    const po = await process(newRaw);
    expect(po).toMatchObject({
      po_number: 'FLSZ5YI9E7FE', po_date: '2026-11-22', expiry_date: FUTURE_EXPIRY, delivery_pincode: '600067', delivery_gstin: '33AABCF8078M1Z8',
      total_line_items: 2, total_qty: 76, po_value: 17762,
    });
    expect(po.line_items.map((l) => [l.channel_sku_code, l.hsn, l.ean, l.qty, l.channel_mrp, l.landing_rate, l.line_total, l.gst])).toEqual([
      ['BWSHDUMZJAUCUHUR', '33049990', '8906129575929', 48, 449, 224.5, 10776, 18],
      ['BWSHJYA2VSNKVZXW', '33049990', '8906129575929', 28, 499, 249.5, 6986, 18],
    ]);
    expect(po.line_items[0].description).toBe('mCaffeine Body Wash 1');
    expect(po.line_items[0].unmapped).toMatchObject({ Brand: 'mCaffeine', Vertical: 'BodyWash', 'Approved Units': '0' });
    expect(po.warnings).toEqual([]);
  });

  it('passes the checks: SKU by Product ID (= FSN) at the Qcom rate, location by the Shipped To pincode', async () => {
    await seedQcom();
    for (const [pep, fsn, mrp, rate] of [['Mcaf396_WB', 'BWSHDUMZJAUCUHUR', 449, 224.5], ['Mcaf408_WB', 'BWSHJYA2VSNKVZXW', 499, 249.5]] as const) {
      const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'mCaffeine', product_type: 'Body Wash', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
      await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: QC, channel_name: 'Flipkart Qcom', channel_code: fsn, mrp, margin: 0.5, rate_after_margin: rate, is_active: 1 });
    }
    await insert('details_channels', {
      channel_id: QC, channel_name: 'Flipkart Qcom', channel_location_code: 'Chennai', uniware_customer_code: 'FLIPKART_QCOM_CHENNAI', channel_code: 'FLIPKART_QCOM',
      facility_code: 'TEST_WH1', consignee_pin_code: '600067', is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
    const v = await validatePo(await process(newRaw), await new MasterDataReader(await db()).forChannel(CHANNELS.FLIPKART_QCOM), new Date('2026-11-23T06:00:00Z'));
    expect(v.issues).toEqual([]);
    expect(v.location).toMatchObject({ locationCode: 'Chennai', matchedBy: 'pincode' });
    expect(v.lines.map((l) => [l.pepCode, l.ourRate])).toEqual([['Mcaf396_WB', 224.5], ['Mcaf408_WB', 249.5]]);
  });
});

describe('Flipkart Qcom checks (validation against the masters)', () => {
  it('SKU by FSN at the Qcom rate (= Supplier Price), location by the Ship To pincode -> the PO passes', async () => {
    await seedQcom();
    const v = await validatePo(await process(), await new MasterDataReader(await db()).forChannel(CHANNELS.FLIPKART_QCOM), new Date('2026-09-18T06:00:00Z'));
    expect(v.issues).toEqual([]);
    expect(v.location).toMatchObject({ locationCode: 'Ahmedabad', matchedBy: 'pincode' });
    expect(v.lines.map((l) => [l.pepCode, l.ourRate])).toEqual([['MCaf370', 249.5], ['CMB554_S', 499], ['CMB560_S', 474]]);
  });
});

describe('Manual Upload offers Flipkart Qcom', () => {
  it('in the Manual group, one sheet per PO, once its master exists; the .xls is stored and waits for Process', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedQcom();
    const res = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'flipkart_qcom', name: 'Flipkart Qcom', group: 'manual', twoFiles: false })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'flipkart_qcom')
      .attach('files', Buffer.from('not a real xls'), 'purchase_order_FASWN08497679.xls');
    expect(up.status).toBeLessThan(300);
    expect((await rows<{ status: string }>('SELECT status FROM manual_uploads'))[0]).toMatchObject({ status: 'uploaded' });
    expect([...s3Objects().keys()].some((k) => k.includes('manual-upload') && k.endsWith('.xls'))).toBe(true);
  });
});
