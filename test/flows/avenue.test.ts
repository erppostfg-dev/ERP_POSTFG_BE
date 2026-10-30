import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { avenueHandler } from '../../src/modules/po-processing/channels/avenue/avenue.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters } from '../helpers/fixtures';

/*
 * Avenue E-Commerce (DMart) by Manual Upload (2026-10-30): the PO PDF is read by the OCR, avenue.handler turns its raw
 * output into processed.json, validation finds the SKU by the Article No and the location by the Ship To pincode.
 * The raw output below follows PO 4502349805 (Documents/POs, 16.09.2026); the OCR's exact names are not known yet, so
 * one line uses the stacked "EAN/Article No" cell and the other separate cells with other spellings.
 */
const AV = CHANNEL_MASTER_IDS[CHANNELS.AVENUE];

const raw: RawOcr = {
  header: {
    'PO Number': '4502349805',
    'Purchase Order Date': '16.09.2026',
    'PO Validity': '16.09.2026 to 31.10.2026',
    'Ship To': 'IFC- Kukse Bhiwandi Avenue E-Commerce Limited Building No. B, Sai Krishna Co Village Mouje Borivali,Tarfe Sonale, Kharbav, Thane,, Maharashtra 421302',
    'Ship To GSTIN': '27AANCA0090J1ZK',
    'Vendor GSTIN': '27AAICP2804J1ZC',
    'Buyer CIN': 'U74120MH2014PLC259234',
    'Total Qty': '60.00',
    'Total Value': '18,324.00',
  },
  lines: [
    {
      'Sr No.': '1', 'EAN/Article No': '8906171510275 / 140007264', 'HSN Code': '3401 / 3019', Description: 'Hyphen Rice Water Br tng Dly Clensr 100ml',
      UOM: 'EA', Clot: '1.00', 'PO Qty': '24', MRP: '299.00', 'Basic Price': '152.03', 'CGST%': '9.00', 'SGST%': '9.00', 'CESS%': '-', 'IGST%': '-', 'UGST%': '-',
      'CGST V': '328.39', 'SGST V': '328.39', 'Landed Price': '179.40', 'Total Value': '4,305.60',
    },
    {
      Sr: '2', EAN: '8906171510534', 'Article No.': '140007268', HSN: '33049990', 'Item Description': 'Hyphen Double Shot Radince-Lft Serm 50ml',
      'PO  Qty': '36', MRP: '649.00', Basic: '330.00', 'CGST %': '9.00', 'SGST %': '9.00', 'IGST %': '-', Landed: '389.40', 'Total Value': '14,018.40',
    },
  ],
  lineColumns: [], inputType: 'pdf', inputFiles: ['4502349805.pdf'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await avenueHandler.process({ folder: '/tmp/avenue-test', meta: {}, channel: CHANNELS.AVENUE, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/** Avenue's master: the two SKUs of the PO (rate = Landed Price), and locations (two share 421302, as on dev). */
const seedAvenue = async (locations: { code: string; pin: string }[]) => {
  await insert('master_channels', { id: AV, slug: 'avenue-ecommerce', display_name: 'Avenue E-Commerce', db_aliases: ['Avenue E-Commerce', 'avenue'], has_processor: 0, is_active: 1 });
  for (const [pep, article, mrp, rate] of [['HYPMUBX001F100', '140007264', 299, 179.4], ['HYPMUBX038F050', '140007268', 649, 389.4]] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: `Hyphen ${pep}`, brand_name: 'Hyphen', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: AV, channel_name: 'Avenue E-Commerce', channel_code: article, mrp, margin: 0.4, rate_after_margin: rate, is_active: 1 });
  }
  for (const l of locations) {
    await insert('details_channels', {
      channel_id: AV, channel_name: 'Avenue E-Commerce', channel_location_code: l.code, uniware_customer_code: `AVENUE_${l.code}`, channel_code: 'AVENUE_B2B',
      facility_code: 'TEST_WH1', consignee_pin_code: l.pin, is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.AVENUE), new Date('2026-09-17T06:00:00Z'));

beforeEach(async () => {
  await resetDb();
  await seedMasters(); // BigBasket + the warehouse TEST_WH1
});
afterAll(closeDb);

describe('Avenue PDF -> processed.json (avenue.handler)', () => {
  it('reads the header, both line layouts (stacked EAN/Article cell or separate cells) and the totals', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'avenue', po_number: '4502349805', po_date: '2026-09-16', expiry_date: '2026-10-31', delivery_pincode: '421302',
      delivery_gstin: '27AANCA0090J1ZK', vendor_gstin: '27AAICP2804J1ZC', total_line_items: 2, total_qty: 60, po_value: 18324, cart_discount: 0, net_amount: 18324,
    });
    expect(po.line_items.map((l) => [l.line_no, l.ean, l.channel_sku_code, l.hsn, l.qty, l.channel_mrp, l.unit_cost, l.landing_rate, l.line_total, l.gst])).toEqual([
      [1, '8906171510275', '140007264', '34013019', 24, 299, 152.03, 179.4, 4305.6, 18],
      [2, '8906171510534', '140007268', '33049990', 36, 649, 330, 389.4, 14018.4, 18],
    ]);
    expect(po.unmapped).toMatchObject({ 'Buyer CIN': 'U74120MH2014PLC259234' });
    expect(po.warnings).toEqual([]);
  });

  it('no Total row from the OCR: totals from the lines ("calculated"); a Total row that differs is a warning', async () => {
    const { 'Total Qty': _q, 'Total Value': _v, ...noTotals } = raw.header;
    const calc = await process({ header: noTotals });
    expect(calc).toMatchObject({ total_qty: 60, po_value: 18324 });
    expect(calc.field_sources).toMatchObject({ total_qty: 'calculated', po_value: 'calculated' });
    const off = await process({ header: { ...raw.header, 'Total Value': '19,000.00' } });
    expect(off.warnings.map((w) => w.code)).toContain('PO_VALUE_MISMATCH');
  });

  it('IGST on an inter-state PO; a line without its Article No is a warning (the SKU then waits in review)', async () => {
    const po = await process({ lines: [{ ...raw.lines[0], 'EAN/Article No': '8906171510275', 'CGST%': '-', 'SGST%': '-', 'IGST%': '18.00' }] });
    expect(po.line_items[0]).toMatchObject({ ean: '8906171510275', channel_sku_code: '', gst: 18 });
    expect(po.warnings.map((w) => w.code)).toContain('RAW_FIELD_MISSING');
  });
});

describe('Avenue checks (validation against the masters)', () => {
  it('SKU by the Article No, price = Landed Price; one location at the pincode -> the PO passes', async () => {
    await seedAvenue([{ code: 'Thane 2 (Kukse)', pin: '421302' }, { code: 'Mazgaon', pin: '400010' }]);
    const v = await validate(await process());
    expect(v.issues).toEqual([]);
    expect(v.location).toMatchObject({ locationCode: 'Thane 2 (Kukse)', customerCode: 'AVENUE_Thane 2 (Kukse)', matchedBy: 'pincode' });
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([['140007264', 'HYPMUBX001F100', 179.4], ['140007268', 'HYPMUBX038F050', 389.4]]);
  });

  it('two locations at the Ship To pincode (as on dev for 421302) -> review, the reviewer picks one', async () => {
    await seedAvenue([{ code: 'Thane 2 (Kukse)', pin: '421302' }, { code: 'Mouje Borivali', pin: '421302' }]);
    const v = await validate(await process());
    expect(v.issues.map((i) => i.type)).toEqual(['LOCATION_NOT_MAPPED']);
    expect(v.issues[0].message).toContain('421302');
  });
});

describe('Manual Upload offers Avenue', () => {
  it('in the Manual group, one PDF per PO, once its master exists; the PDF is stored and waits for Process', async () => {
    const reviewer = await loginAs('operations-executive');
    const before = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(before.body.data.map((c: { channel: string }) => c.channel)).not.toContain('avenue');
    await seedAvenue([{ code: 'Thane 2 (Kukse)', pin: '421302' }]);
    const res = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'avenue', name: 'Avenue E-Commerce', group: 'manual', twoFiles: false })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'avenue').attach('files', Buffer.from('%PDF-1.4 test'), 'Hyphen AE00 16.09.2026.pdf');
    expect(up.status).toBeLessThan(300);
    const [row] = await rows<{ status: string; channel: string }>('SELECT status, channel FROM manual_uploads');
    expect(row).toMatchObject({ status: 'uploaded' });
    expect([...s3Objects().keys()].some((k) => k.includes('manual-upload') && k.endsWith('.pdf'))).toBe(true);
  });
});
