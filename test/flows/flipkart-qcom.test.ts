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
