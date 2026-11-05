import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { firstClubHandler } from '../../src/modules/po-processing/channels/first-club/first-club.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters } from '../helpers/fixtures';

/*
 * First Club by Manual Upload (2026-11-05): its PO PDF -> OCR PDF pipeline (fixed header / line names, tax cells split)
 * -> first-club.handler -> processed.json -> validation (SKU by First Club's SKU Code = its channel_code, a code on
 * several of our codes told apart by the item description; location by the Shipping Address pincode). The lines below
 * follow the layout of the samples (Downloads/First club, PO-199751: Hyderabad, 6 lines, IGST 18%).
 */
const FC = CHANNEL_MASTER_IDS[CHANNELS.FIRST_CLUB];
/** The OCR itself (Python + model) is replaced: it answers with `ocr.answer` (the OCR team's raw JSON) and records the entry asked for. */
const ocr = vi.hoisted(() => ({ calls: [] as { channel: string; files: string[] }[], answer: null as Record<string, unknown> | null }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async (channel: string, files: string[]) => {
    ocr.calls.push({ channel, files });
    return ocr.answer
      ? { exitCode: 0, timedOut: false, durationMs: 1, result: ocr.answer, log: '' }
      : { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'OCR is off in tests' }, log: '' };
  }),
}));
const line = (no: number, desc: string, sku: string, hsn: string, qty: number, mrp: number, unit: number, taxable: string, igst: string, total: string) => ({
  Sr: String(no), 'Item Description': desc, 'SKU Code': sku, HSN: hsn, COO: 'Nil', Qty: qty.toFixed(2), MRP: mrp.toFixed(2),
  'Unit Cost': String(unit), 'Taxable Value': taxable, CGST: '0.00', 'CGST Rate': '0.00%', SGST: '0.00', 'SGST Rate': '0.00%',
  IGST: igst, 'IGST Rate': '18.00%', CESS: '0.00', 'CESS Rate': '0.00%', Total: total,
});
const HYD = '1-8/74/3, MEDCHAL MALKAJGIRI THUMKUNTA MUNICIPALITY DEVRAYAMJAL- YAMJAL HYDERABAD TELANGANA Pin code- 500078';
const raw: RawOcr = {
  header: {
    'PO Number': 'PO-199751-FRHHYDMDL01', 'PO Date': '2026-10-18', 'PO Release Date': '2026-10-18', 'Expected Delivery Date': '2026-11-17',
    'PO Expiry Date': '2026-11-22', 'Payment Terms': 'As per agreed terms', Status: 'APPROVED',
    'Vendor Name': 'PEP TECHNOLOGIES PRIVATE LIMITED', 'Vendor GSTIN': '27AAICP2804J1ZC',
    'Billing Name': 'Firstclub Technology PVT. LTD', 'Billing GSTIN': '36AAGCF0834Q1Z9', 'Billing Address': HYD,
    'Shipping Name': 'Firstclub Technology PVT. LTD', 'Shipping GSTIN': '36AAGCF0834Q1Z9', 'Shipping Address': HYD,
    'Total Amount': '88312.47', 'Grand Total': '88312.47',
  },
  lines: [
    line(1, 'mCaffeine Take A Dip Triple-Action Deo Body Wash 250 ml', 'SKU263395210', '34013019', 48, 499, 283.33, '13599.84', '2447.97', '16047.81'),
    line(2, 'mCaffeine Guava Tini De-Tan Body Wash 300 ml', 'SKU263395212', '33049990', 80, 449, 254.94, '20395.20', '3671.14', '24066.34'),
    line(3, 'mCaffeine Sweet Escape Perfume Body Lotion 300 ml', 'SKU263395209', '33049190', 32, 499, 283.33, '9066.56', '1631.98', '10698.54'),
    line(4, 'mCaffeine Brightening Raspberry Rush Body Wash 300 ml', 'SKU263395202', '34013019', 48, 399, 226.55, '10874.40', '1957.39', '12831.79'),
    line(5, 'mCaffeine Caramel Crunch Exfoliating Body Wash 300 ml', 'SKU263395211', '33049990', 52, 449, 254.94, '13256.88', '2386.24', '15643.12'),
    line(6, 'mCaffeine Naked & Raw Coffee Body Scrub 100 g', 'SKU263395214', '33049990', 30, 449, 254.94, '7648.20', '1376.68', '9024.88'),
  ],
  lineColumns: [], inputType: 'pdf', inputFiles: ['PO-199751.pdf'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await firstClubHandler.process({ folder: '/tmp/first-club-test', meta: {}, channel: CHANNELS.FIRST_CLUB, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/**
 * FIRST CLUB's master as on dev (5 Nov, read-only check): channel_code = First Club's SKU Code, rate_after_margin = MRP x
 * 0.67 with tax; SKU263395202 on FOUR of our codes (only MCaf383_WB_N1 is the Raspberry Rush body wash; the channel row
 * of 55MCaf40 has its own long name); the 2 locations keep their pincode only in final_shipping_address.
 */
const seedFirstClub = async () => {
  await insert('master_channels', { id: FC, slug: 'first-club', display_name: 'FIRST CLUB', db_aliases: ['FIRST CLUB', 'first-club'], has_processor: 0, is_active: 1 });
  for (const [pep, code, mrp, rate, ourName, channelName] of [
    ['MCaf398', 'SKU263395210', 499, 334.33, 'Take A Dip Triple Action Deo Body Wash', null],
    ['MCaf401', 'SKU263395212', 449, 300.83, 'Guava Tini De-Tan Body Wash', null],
    ['MCaf370', 'SKU263395209', 499, 334.33, 'Sweet Escape Perfume Body Lotion', null],
    ['MCaf383_WB_N1', 'SKU263395202', 399, 267.33, 'Brightening Raspberry Rush Body Wash', 'Brightening Raspberry Rush Body Wash'],
    ['MCaf369', 'SKU263395202', 249, 166.83, 'Berries Brightening Coffee Face Scrub', 'Berries Brightening Coffee Face Scrub'],
    ['MCaf87', 'SKU263395202', 229, 153.43, 'Naked & Raw Espresso Coffee Face Scrub', 'Naked & Raw Espresso Coffee Face Scrub'],
    ['55MCaf40', 'SKU263395202', 279, 186.93, 'Naked & Raw Coffee Body Scrub (55 g)', 'mCaffeine Exfoliating Coffee Body Scrub For Tan Removal &amp; Soft-Smooth Skin'],
    ['MCaf392', 'SKU263395211', 449, 300.83, 'Caramel Crunch Exfoliating Body Wash', null],
    ['MCaf40', 'SKU263395214', 449, 300.83, 'Naked & Raw Coffee Body Scrub', null],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: ourName, brand_name: 'mCaffeine', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: FC, channel_name: 'FIRST CLUB', channel_code: code, product_name: channelName, mrp, margin: 0.33, rate_after_margin: rate, is_active: 1 });
  }
  for (const [code, pin, address] of [
    ['BENGALURU', '562123', 'Sy No. 23/1, 23/2, 23/6, 24/1, 24/2, 24/6, Yantaganahalli Village, Kasaba Hobli, Nelamangala, Bengaluru Rural - 562123'],
    ['HYDERABAD', '500078', '1-8/74/3, MEDCHAL MALKAJGIRI THUMKUNTA MUNICIPALITY DEVRAYAMJAL- YAMJAL HYDERABAD TELANGANA 500078'],
  ]) {
    await insert('details_channels', {
      channel_id: FC, channel_name: 'FIRST CLUB', channel_location_code: code, uniware_customer_code: `FIRST_CLUB_${code}_${pin}`, channel_code: 'OTHER_B2B',
      facility_code: 'TEST_WH1', consignee_pin_code: null, final_shipping_address: address, is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.FIRST_CLUB), new Date('2026-10-19T06:00:00Z'));
const lineWith = (over: Record<string, string>) => ({ ...raw.lines[3], ...over });

beforeEach(async () => {
  ocr.calls.length = 0;
  ocr.answer = null;
  await resetDb();
  await seedMasters(); // BigBasket + the warehouse TEST_WH1
});
afterAll(closeDb);

describe('First Club PDF -> processed.json (first-club.handler)', () => {
  it('reads the header (PO No. as printed), the lines (SKU Code = channel code, IGST %, price with tax = Unit Cost x 1.18) and the Grand Total', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'first_club', po_number: 'PO-199751-FRHHYDMDL01', po_date: '2026-10-18', expected_date: '2026-11-17', expiry_date: '2026-11-22',
      delivery_pincode: '500078', delivery_gstin: '36AAGCF0834Q1Z9', vendor_gstin: '27AAICP2804J1ZC',
      total_line_items: 6, total_qty: 290, po_value: 88312.47, cart_discount: 0, net_amount: 88312.47,
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.hsn, l.qty, l.channel_mrp, l.unit_cost, l.gst, l.landing_rate, l.line_total])).toEqual([
      [1, 'SKU263395210', '34013019', 48, 499, 283.33, 18, 334.33, 16047.81],
      [2, 'SKU263395212', '33049990', 80, 449, 254.94, 18, 300.83, 24066.34],
      [3, 'SKU263395209', '33049190', 32, 499, 283.33, 18, 334.33, 10698.54],
      [4, 'SKU263395202', '34013019', 48, 399, 226.55, 18, 267.33, 12831.79],
      [5, 'SKU263395211', '33049990', 52, 449, 254.94, 18, 300.83, 15643.12],
      [6, 'SKU263395214', '33049990', 30, 449, 254.94, 18, 300.83, 9024.88],
    ]);
    expect(po.line_items[3].description).toBe('mCaffeine Brightening Raspberry Rush Body Wash 300 ml');
    expect(po.line_items[0].unmapped).toMatchObject({ 'Taxable Value': '13599.84', IGST: '2447.97', COO: 'Nil' });
    expect(po.unmapped).toMatchObject({ 'Billing Name': 'Firstclub Technology PVT. LTD', Status: 'APPROVED', 'PO Release Date': '2026-10-18' });
    expect(po.field_sources).toMatchObject({ po_value: 'raw (Grand Total)', total_qty: 'calculated' });
    expect(po.warnings).toEqual([]);
  });

  it('PO No. split over two lines is joined; no Grand Total: Total Amount, then the lines\' sum; a total that differs: warning', async () => {
    expect((await process({ header: { ...raw.header, 'PO Number': 'PO-199751- FRHHYDMDL01' } })).po_number).toBe('PO-199751-FRHHYDMDL01');
    const { 'Grand Total': _g, ...noGrand } = raw.header;
    expect(await process({ header: noGrand })).toMatchObject({ po_value: 88312.47, field_sources: expect.objectContaining({ po_value: 'raw (Total Amount)' }) });
    const { 'Total Amount': _t, ...noTotals } = noGrand;
    expect(await process({ header: noTotals })).toMatchObject({ po_value: 88312.48, field_sources: expect.objectContaining({ po_value: 'calculated' }) });
    expect((await process({ header: { ...raw.header, 'Grand Total': '90000.00' } })).warnings.map((w) => w.code)).toContain('PO_VALUE_MISMATCH');
  });

  it('CGST + SGST on an in-state PO; no tax rates / no SKU Code: warnings', async () => {
    const inState = lineWith({ CGST: '978.70', 'CGST Rate': '(9.00%)', SGST: '978.70', 'SGST Rate': '(9.00%)', IGST: '0.00', 'IGST Rate': '0.00%' });
    expect((await process({ lines: [inState] })).line_items[0]).toMatchObject({ gst: 18, landing_rate: 267.33 });
    const { 'IGST Rate': _i, 'CGST Rate': _c, 'SGST Rate': _s, ...noRates } = raw.lines[3];
    expect((await process({ lines: [noRates] })).warnings.map((w) => w.code)).toContain('GST_COLUMNS_MISSING');
    const { 'SKU Code': _k, ...noSku } = raw.lines[3];
    expect((await process({ lines: [noSku] })).warnings.map((w) => w.code)).toContain('RAW_FIELD_MISSING');
  });
});

describe('First Club checks (validation against the masters)', () => {
  it('as on dev: Hyderabad by the pincode in its address; SKU263395202 (on 4 of our codes) -> MCaf383_WB_N1 by the item description; no issues', async () => {
    await seedFirstClub();
    const v = await validate(await process());
    expect(v.location).toMatchObject({ locationCode: 'HYDERABAD', customerCode: 'FIRST_CLUB_HYDERABAD_500078', matchedBy: 'pincode' });
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([
      ['SKU263395210', 'MCaf398', 334.33], ['SKU263395212', 'MCaf401', 300.83], ['SKU263395209', 'MCaf370', 334.33],
      ['SKU263395202', 'MCaf383_WB_N1', 267.33], ['SKU263395211', 'MCaf392', 300.83], ['SKU263395214', 'MCaf40', 300.83],
    ]);
    expect(v.issues).toEqual([]);
  });

  it('a description that fits none, or two, of the code\'s products -> review (SKU_NOT_MAPPED) with the candidates', async () => {
    await seedFirstClub();
    const none = await validate(await process({ lines: [lineWith({ 'Item Description': 'mCaffeine Mystery Gift Box' })] }));
    expect(none.issues.map((i) => i.type)).toEqual(['SKU_NOT_MAPPED']);
    expect(none.issues[0].message).toContain('MCaf383_WB_N1');
    // "Naked & Raw Espresso Coffee Face Scrub" + "Naked & Raw Coffee Body Scrub" both fit this description
    const two = await validate(await process({ lines: [lineWith({ 'Item Description': 'mCaffeine Naked & Raw Espresso Coffee Face Scrub and Coffee Body Scrub Combo' })] }));
    expect(two.issues.map((i) => i.type)).toContain('SKU_NOT_MAPPED');
  });

  it('Bengaluru by 562123; a Unit Cost that does not give our price with tax -> price issue', async () => {
    await seedFirstClub();
    const blr = { ...raw.header, 'PO Number': 'PO-199750-FHYBLRNLM01', 'Shipping GSTIN': '29AAGCF0834Q1Z4',
      'Shipping Address': 'Sy No. 23/1, 23/2, 23/6, 24/1, 24/2, 24/6, Yantaganahalli Village, Kasaba Hobli, Nelamangala, Bengaluru Rural - 562123' };
    expect((await validate(await process({ header: blr }))).location).toMatchObject({ locationCode: 'BENGALURU' });
    const v = await validate(await process({ lines: [lineWith({ 'Unit Cost': '240.00', Total: '13593.60' })] }));
    expect(v.issues.map((i) => i.type)).toContain('PRICE_MISMATCH');
  });

  it('the description tie-break is First Club\'s only: another channel with the same shared code still goes to review', async () => {
    await seedFirstClub();
    // Pop Tech is not in SKU_NAME_TIEBREAK: the same 4 rows under its channel id stay ambiguous
    const PT = CHANNEL_MASTER_IDS[CHANNELS.POP_TECH];
    await insert('master_channels', { id: PT, slug: 'pop-tech', display_name: 'POP TECH', db_aliases: ['POP TECH'], has_processor: 0, is_active: 1 });
    await (await db()).query('INSERT INTO master_channel_skus (pep_code, pep_sku_id, channel_id, channel_name, channel_code, product_name, mrp, margin, rate_after_margin, is_active) SELECT pep_code, pep_sku_id, ?, \'POP TECH\', channel_code, product_name, mrp, margin, rate_after_margin, is_active FROM master_channel_skus WHERE channel_id = ? AND channel_code = \'SKU263395202\'', [PT, FC]);
    const po = { ...(await process({ lines: [raw.lines[3]] })), channel_name: CHANNELS.POP_TECH };
    const v = await validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.POP_TECH), new Date('2026-10-19T06:00:00Z'));
    expect(v.issues.map((i) => i.type)).toContain('SKU_NOT_MAPPED');
  });
});

describe('Manual Upload offers First Club', () => {
  it('in the Manual group, one PDF per PO; the PDF is stored (and copied to S3) and waits for Process', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedFirstClub();
    const res = await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'first_club', name: 'FIRST CLUB', group: 'manual', twoFiles: false })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'first_club')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'PO-199751.pdf');
    expect(up.status).toBeLessThan(300);
    expect((await rows<{ status: string }>('SELECT status FROM manual_uploads'))[0]).toMatchObject({ status: 'uploaded' });
    expect([...s3Objects().keys()].some((k) => k.includes('manual-upload') && k.endsWith('.pdf'))).toBe(true);
  });
});

describe('the whole Manual Upload flow: upload -> S3 -> OCR "first_club" -> processed.json -> checks -> PO + sale order + Uniware CSV', () => {
  it('a First Club PDF that fits the masters becomes a PO with its sale order and CSV (OUR code for the shared SKU Code)', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedFirstClub();
    const { 'Total Amount': totalAmount, 'Grand Total': grandTotal, ...header } = raw.header;
    ocr.answer = { channel: 'first_club', header, totals: { 'Total Amount': totalAmount, 'Grand Total': grandTotal }, line_item_columns: Object.keys(raw.lines[0]), line_items: raw.lines, warnings: [] };
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'first_club')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'PO-199751.pdf');
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
    expect(ocr.calls.map((c) => [c.channel, c.files.length, c.files[0].endsWith('.pdf')])).toEqual([['first_club', 1, true]]);
    const [u] = await rows<{ status: string; po_number: string; channel: string }>("SELECT status, po_number, channel FROM po_uploads WHERE po_number = 'PO-199751-FRHHYDMDL01'");
    expect(u).toMatchObject({ status: 'completed', channel: 'FIRST CLUB' });
    const [po] = await rows<{ orderNo1: string }>("SELECT orderNo1 FROM master_purchase_orders WHERE poNumber = 'PO-199751-FRHHYDMDL01'");
    expect(po.orderNo1).toMatch(/^erp_\d{11}$/);
    const keys = [...s3Objects().keys()];
    expect(keys.some((k) => k.includes('manual-upload') && k.endsWith('processed.json'))).toBe(true);
    const csv = [...s3Objects().entries()].find(([k]) => k.endsWith('.csv') && k.includes('PO-199751-FRHHYDMDL01'))?.[1] ?? '';
    expect(csv).toContain(po.orderNo1);
    expect(csv).toContain('MCaf383_WB_N1');
    expect(csv).toContain('FIRST_CLUB_HYDERABAD_500078');
  });

  it('a line the masters cannot place -> In Review with the reason (nothing saved)', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedFirstClub();
    ocr.answer = { channel: 'first_club', header: raw.header, line_item_columns: Object.keys(raw.lines[0]), line_items: [lineWith({ 'SKU Code': 'SKU999999999' })], warnings: [] };
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'first_club')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'PO-199752.pdf');
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
    const [u] = await rows<{ id: string; status: string }>("SELECT id, status FROM po_uploads WHERE po_number = 'PO-199751-FRHHYDMDL01'");
    expect(u.status).toBe('needs_review');
    expect((await rows<{ issue_type: string }>("SELECT issue_type FROM po_issues WHERE upload_id = ? AND status = 'open'", [u.id])).map((r) => r.issue_type)).toContain('SKU_NOT_MAPPED');
    expect(await rows('SELECT uid FROM master_purchase_orders')).toEqual([]);
  });
});
