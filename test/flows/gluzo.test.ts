import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { gluzoHandler } from '../../src/modules/po-processing/channels/gluzo/gluzo.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters } from '../helpers/fixtures';

/*
 * Gluzo by Manual Upload (2026-11-02, option B: the EasyEcom PDF alone): the OCR PDF pipeline's raw output ->
 * gluzo.handler -> processed.json -> validation (SKU by Gluzo's SKU, location by the Shipping Address pincode; anything
 * missing in the masters -> review, user). Lines below are 3 of PO 2263773 (Downloads/GLUZO, 30-09-2026).
 */
const GZ = CHANNEL_MASTER_IDS[CHANNELS.GLUZO];
const line = (sku: string, name: string, ean: string, hsn: string, qty: number, base: number, tax: number, total: string) => ({
  SKU: sku, 'Product Name': name, 'Vendor SKU': sku, 'EAN/UPC': ean, 'Product Tax Code': hsn, Quantity: String(qty),
  'Tax Rate': '18%', 'Tax Type': 'IGST-18% CESS-0%', 'Base Price': String(base), 'Tax per Item': String(tax), 'Unit Total': total,
});
const raw: RawOcr = {
  header: {
    'PO Number': '2263773', 'PO Date': '2026-09-30', 'Buyer Name': 'GLUZO ECOMMERCE INDIA PRIVATE LIMITED', 'Buyer GSTIN': '07ABGCS3706D1ZL',
    'Vendor Code': 'PePTech123', 'Vendor GSTIN': '06AAICP2804J1ZG', 'Shipping Name': 'GLUZO ECOMMERCE INDIA PRIVATE LIMITED',
    'Shipping Address': '2, FIRST FLOOR, REAR PORTION, PARK END COLONY, VIKAS MARG, Preet Vihar, East Delhi, DELHI ,Delhi - 110092 India',
    'Total Quantity': '572', 'Item Total': '₹183027.24*', 'Total Tax Amount': '₹32990.60*', 'Grand Total': '₹217017.84*',
  },
  lines: [
    line('226648', 'mCaffeine Sweet Escape Perfume Body Lotion - 300 ml', '89061295 75332', '33049190', 500, 329.85, 59.37, '194,610.00'),
    line('226676', 'mCaffeine Brightening Body Wash - 300 ml', '8906129575646', '34013019', 60, 263.75, 47.47, '18,673.20'),
    line('119464', 'HYPHEN Tinted Lip Balm - Hazel.', '8906171510329', '', 12, 263.75, 47.47, '3,734.64'),
  ],
  lineColumns: [], inputType: 'pdf', inputFiles: ['2263773_244809_20260930102248.pdf'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await gluzoHandler.process({ folder: '/tmp/gluzo-test', meta: {}, channel: CHANNELS.GLUZO, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/** GLUZO's master as on dev (2 Nov): rate = Base + Tax; 226676 mapped to two of our codes; DELHI without a pincode. */
const seedGluzo = async (pincode: string | null) => {
  await insert('master_channels', { id: GZ, slug: 'gluzo', display_name: 'GLUZO', db_aliases: ['GLUZO', 'gluzo'], has_processor: 0, is_active: 1 });
  for (const [pep, sku, rate] of [['MCaf370', '226648', 389.22], ['MCaf383_WB', '226676', 311.22], ['MCaf383_WB_N1', '226676', 311.22], ['HYPMUBX022F010', '119464', 311.22]] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'mCaffeine', product_type: 'Main Unit', mrp: 499, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: GZ, channel_name: 'GLUZO', channel_code: sku, mrp: 499, margin: 0.22, rate_after_margin: rate, is_active: 1 });
  }
  await insert('details_channels', {
    channel_id: GZ, channel_name: 'GLUZO', channel_location_code: 'DELHI', uniware_customer_code: 'GLUZO_DELHI_110092', channel_code: 'GLUZO',
    facility_code: 'TEST_WH1', consignee_pin_code: pincode, is_active: 1, created_at: new Date(), updated_at: new Date(),
  });
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.GLUZO), new Date('2026-10-01T06:00:00Z'));

beforeEach(async () => {
  await resetDb();
  await seedMasters(); // BigBasket + the warehouse TEST_WH1
});
afterAll(closeDb);

describe('Gluzo PDF -> processed.json (gluzo.handler)', () => {
  it('reads the header, the lines (price with tax = Base + Tax per Item, Unit Total = the line total) and the ₹…* totals', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'gluzo', po_number: '2263773', po_date: '2026-09-30', delivery_pincode: '110092', delivery_gstin: '07ABGCS3706D1ZL',
      vendor_gstin: '06AAICP2804J1ZG', total_line_items: 3, total_qty: 572, po_value: 217017.84, cart_discount: 0, net_amount: 217017.84,
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.ean, l.hsn, l.qty, l.unit_cost, l.landing_rate, l.line_total, l.gst, l.channel_mrp])).toEqual([
      [1, '226648', '8906129575332', '33049190', 500, 329.85, 389.22, 194610, 18, ''],
      [2, '226676', '8906129575646', '34013019', 60, 263.75, 311.22, 18673.2, 18, ''],
      [3, '119464', '8906171510329', '', 12, 263.75, 311.22, 3734.64, 18, ''],
    ]);
    expect(po.unmapped).toMatchObject({ 'Vendor Code': 'PePTech123', 'Item Total': '₹183027.24*' });
    expect(po.warnings).toEqual([]);
  });

  it('no totals from the OCR: the lines\' sums ("calculated"); a Grand Total that differs: warning; no SKU: warning', async () => {
    const { 'Total Quantity': _q, 'Grand Total': _g, ...rest } = raw.header;
    const calc = await process({ header: rest });
    expect(calc).toMatchObject({ total_qty: 572, po_value: 217017.84 });
    expect(calc.field_sources).toMatchObject({ total_qty: 'calculated', po_value: 'calculated' });
    expect((await process({ header: { ...raw.header, 'Grand Total': '₹220000.00*' } })).warnings.map((w) => w.code)).toContain('PO_VALUE_MISMATCH');
    const { SKU: _s, 'Vendor SKU': _v, ...noSku } = raw.lines[0];
    expect((await process({ lines: [noSku] })).warnings.map((w) => w.code)).toContain('RAW_FIELD_MISSING');
  });
});

describe('Gluzo checks (validation against the masters)', () => {
  it('as on dev: DELHI has no pincode and 226676 maps to two of our codes -> review (the masters team fixes them)', async () => {
    await seedGluzo(null);
    const v = await validate(await process());
    expect(v.issues.map((i) => i.type).sort()).toEqual(['LOCATION_NOT_MAPPED', 'SKU_NOT_MAPPED']);
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([['226648', 'MCaf370', 389.22], ['226676', '', ''], ['119464', 'HYPMUBX022F010', 311.22]]);
  });

  it('DELHI without consignee_pin_code but 110092 in its address: matched by the address (every channel)', async () => {
    await seedGluzo(null);
    const conn = await db();
    await conn.query("UPDATE details_channels SET final_shipping_address = '2, FIRST FLOOR, PARK END COLONY, VIKAS MARG, Preet Vihar, Delhi - 110092' WHERE channel_location_code = 'DELHI'");
    const v = await validate(await process());
    expect(v.location).toMatchObject({ locationCode: 'DELHI', matchedBy: 'pincode' });
    expect(v.issues.map((i) => i.type)).toEqual(['SKU_NOT_MAPPED']);
    // another pincode in the address: still no location, and the issue says the address was searched too
    await conn.query("UPDATE details_channels SET final_shipping_address = 'Somewhere, Delhi - 110001' WHERE channel_location_code = 'DELHI'");
    const miss = await validate(await process());
    expect(miss.issues.find((i) => i.type === 'LOCATION_NOT_MAPPED')?.message).toContain('pincode in the location address');
  });

  it('once DELHI has 110092 (and 226676 one code), the PO passes: prices match Base + Tax, no MRP check', async () => {
    await seedGluzo('110092');
    await (await db()).query("UPDATE master_channel_skus SET is_active = 0 WHERE pep_code = 'MCaf383_WB_N1'");
    const v = await validate(await process());
    expect(v.issues).toEqual([]);
    expect(v.location).toMatchObject({ locationCode: 'DELHI', customerCode: 'GLUZO_DELHI_110092', matchedBy: 'pincode' });
  });
});

describe('Manual Upload offers Gluzo', () => {
  it('in the Manual group, one PDF per PO; the PDF is stored and waits for Process', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedGluzo('110092');
    const res = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'gluzo', name: 'GLUZO', group: 'manual', twoFiles: false })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'gluzo')
      .attach('files', Buffer.from('%PDF-1.4 test'), '2263773_244809_20260930102248.pdf');
    expect(up.status).toBeLessThan(300);
    expect((await rows<{ status: string }>('SELECT status FROM manual_uploads'))[0]).toMatchObject({ status: 'uploaded' });
    expect([...s3Objects().keys()].some((k) => k.includes('manual-upload') && k.endsWith('.pdf'))).toBe(true);
  });
});

/*
 * 2026-11-04: real OCR outputs whose line names changed (Downloads/Gluzo OCR Process Failed): before, qty / price were
 * dropped and every line went to review. The handler now reads the values by shape and arithmetic.
 */
describe('Gluzo lines whatever the OCR named the columns (value checks)', () => {
  it('1922973: Product Quantity / Base Price per Unit / Tax Amount / Total Item are read, no warning', async () => {
    const l = (sku: string, ean: string, qty: string, base: string, tax: string, total: string) => ({
      SKU: sku, Company: 'mCaffeine', 'Product Name': `p ${sku}`, 'Vendor SKU': sku, 'EAN/UPC': ean, 'Product Quantity': qty,
      'Tax Rate': '18%', 'Tax Type': 'IGST-18%', 'Base Price per Unit': base, 'Tax Amount': tax, 'Total Item': total,
    });
    const po = await process({
      header: { ...raw.header, 'PO Number': '1922973', 'Total Quantity': '54', 'Grand Total': '₹19368*' },
      lines: [l('226740', '8906129575639', '6', '296.61', '53.39', '2,100.00'), l('226661', '8906129575349', '12', '329.66', '59.34', '4,668.00'),
        l('226639', '8906129575929', '36', '296.61', '53.39', '12,600.00')],
    });
    expect(po.line_items.map((x) => [x.channel_sku_code, x.ean, x.qty, x.unit_cost, x.landing_rate, x.gst, x.line_total])).toEqual([
      ['226740', '8906129575639', 6, 296.61, 350, 18, 2100], ['226661', '8906129575349', 12, 329.66, 389, 18, 4668],
      ['226639', '8906129575929', 36, 296.61, 350, 18, 12600],
    ]);
    expect(po.warnings).toEqual([]);
  });

  it('2263773: SHIFTED names (Tax Code = 18%, Tax Rate = tax per unit, Product SKU = HSN, half EAN) -> right GST, price, HSN', async () => {
    const l = (sku: string, hsn: string, qty: string, base: string, tax: string, total: string) => ({
      SKU: sku, Company: 'mCaffeine', 'Product Name': `p ${sku}`, 'Vendor EAN/UPC': '89061295', 'Product SKU': hsn, Quantity: qty,
      'Tax Code': '18%', 'Tax Type': 'IGST-18%', 'Base Price per Item': base, 'Tax Rate': tax, 'Unit Total': total,
    });
    const po = await process({
      header: { ...raw.header, 'Total Quantity': '560', 'Grand Total': '₹213283.20*' },
      lines: [l('226648', '33049190', '500', '329.85', '59.37', '194,610.00'), l('226676', '34013019', '60', '263.75', '47.47', '18,673.20')],
    });
    expect(po.line_items.map((x) => [x.channel_sku_code, x.ean, x.hsn, x.qty, x.unit_cost, x.landing_rate, x.gst, x.line_total])).toEqual([
      ['226648', '', '33049190', 500, 329.85, 389.22, 18, 194610], ['226676', '', '34013019', 60, 263.75, 311.22, 18, 18673.2],
    ]);
    const fixes = po.warnings.filter((w) => w.code === 'LINE_VALUE_FIXED').map((w) => w.message);
    expect(fixes).toEqual(expect.arrayContaining([expect.stringContaining('"Tax Rate" 59.37 is not a GST rate: 18%'), expect.stringContaining('"89061295" is not an EAN')]));
    expect(po.warnings.filter((w) => w.code !== 'LINE_VALUE_FIXED')).toEqual([]);
  });

  it('price that does not add up -> price with tax = Unit Total / Quantity; missing qty -> Unit Total / price when whole', async () => {
    const po = await process({
      header: { ...raw.header, 'Total Quantity': '', 'Grand Total': '' },
      lines: [
        { SKU: '226648', Quantity: '500', 'Tax Rate': '18%', 'Base Price': '300', 'Tax per Item': '54', 'Unit Total': '194,610.00' },
        { SKU: '226676', 'Tax Rate': '18%', 'Base Price': '263.75', 'Tax per Item': '47.47', 'Unit Total': '18,673.20' },
      ],
    });
    expect(po.line_items.map((x) => [x.qty, x.unit_cost, x.landing_rate, x.line_total])).toEqual([[500, 329.85, 389.22, 194610], [60, 263.75, 311.22, 18673.2]]);
    const fixes = po.warnings.filter((w) => w.code === 'LINE_VALUE_FIXED').map((w) => w.message);
    expect(fixes).toEqual([expect.stringContaining('line 1: price Base 300 + Tax 54 = 354 does not give'), expect.stringContaining('line 2: qty not on the line')]);
  });

  it('as validated: the 1922973 names no longer give "no quantity" / "no unit price" issues', async () => {
    await seedGluzo('110092');
    const po = await process({
      lines: [{ SKU: '226648', 'Product Name': 'x', 'Product Quantity': '500', 'Tax Rate': '18%', 'Base Price per Unit': '329.85', 'Tax Amount': '59.37', 'Total Item': '194,610.00' }],
      header: { ...raw.header, 'Total Quantity': '500', 'Grand Total': '₹194610*' },
    });
    const v = await validate(po);
    expect(v.issues.map((x) => x.type)).not.toContain('QTY_MISMATCH');
    expect(v.issues.filter((x) => /unit price|quantity/i.test(x.message))).toEqual([]);
    expect(v.lines.map((x) => [x.channelSkuCode, x.poUnitPrice])).toEqual([['226648', 389.22]]);
  });
});
