import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import { purplleHandler } from '../../src/modules/po-processing/channels/purplle/purplle.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { seedMasters } from '../helpers/fixtures';

/*
 * Purplle's PO PDF by Manual Upload (2026-11-06; user: "handle the PDFs too", Manual Upload only): PO_<number>.PDF ->
 * OCR "purplle" (PDF pipeline, header_notes / line_notes) -> purplle.handler (purplle-pdf.ts) -> the same PO as from the
 * daily summary (prices before GST). The raw OCR below is the real output for PO_4300132312.PDF (Bhubaneshwar, IGST 18%)
 * and PO_4300132301.PDF (Bhiwandi, SGST + CGST), trimmed to a few lines; the master rows are dev's (rate = MRP x 0.8).
 * A summary that comes after the PDF went in leaves that PO out quietly (skipKnownPos, user's choice).
 */
const ocr = vi.hoisted(() => ({ calls: [] as { channel: string; files: string[] }[], pdf: null as Record<string, unknown> | null, sheet: null as Record<string, unknown> | null }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async (channel: string, files: string[]) => {
    ocr.calls.push({ channel, files });
    const answer = /\.pdf$/i.test(files[0]) ? ocr.pdf : ocr.sheet;
    return answer
      ? { exitCode: 0, timedOut: false, durationMs: 1, result: answer, log: '' }
      : { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'OCR is off in tests' }, log: '' };
  }),
}));

const PURPLLE = CHANNEL_MASTER_IDS[CHANNELS.PURPLLE];
const pdfLine = (no: number, code: string, desc: string, ean: string, mrp: string, hsn: string, qty: string, rate: string, tax: Record<string, string>, amount: string) => ({
  'SR No': String(no), 'Item Code': code, Description: desc, EAN: ean, MRP: mrp, 'HSN Code': hsn, UOM: 'EA', Qty: qty, 'Rate/Unit': rate,
  'IGST Rate': '', IGST: '', 'SGST Rate': '', SGST: '', 'CGST Rate': '', CGST: '', ...tax, Amount: amount,
});
const igst = (rate: string, value: string) => ({ 'IGST Rate': rate, IGST: value, 'CGST Rate': '0.00' });
const sgstCgst = (rate: string, value: string) => ({ 'SGST Rate': rate, SGST: value, 'CGST Rate': rate, CGST: value });
const KHORDHA = 'Plot No. B1A,B2-B5, FOOD PROCESSING PARK, Khurda Industrial Estate, Khordha, Odisha, Khordha-752055';
const BHIWANDI = 'Gala No. 7/8, Building No. C4, Angel Logistics Park, Off Mumbai-Agra Highway, Village Pimplas Opposite Bhumi World, Next to Cipla Abbott Warehouse,Bhiwandi Thane-421311';
const header = (po: string, address: string, gstin: string, supplier: string) => ({
  'PO Number': po, 'PO Date': '06.11.2026', 'Billing Name': 'MANASH E-COMMERCE PRIVATE LTD', 'Billing Address': address, 'Billing GSTIN': gstin,
  'Delivery Name': 'MANASH E-COMMERCE PRIVATE LTD', 'Delivery Address': address, 'Delivery GSTIN': gstin, 'Supplier Name': 'PEP TECHNOLOGIES PRIVATE LIMITED',
  'Supplier GSTIN': supplier, 'Amount In Words': 'Rupees ...', 'Payment Terms': 'Transactn(entry date)+ 45 days',
});
/** The OCR's raw JSON for one PDF (the parts used here). */
type PdfOcr = {
  channel: string; input: string; pdf: string; sheet: null; header: Record<string, string>; totals: Record<string, string>;
  line_item_columns: string[]; line_items: Record<string, string>[]; warnings: string[];
};
/** PO_4300132312.PDF: lines 1, 3 and 9 (the 9th as the OCR returned it once: the name glued to the code at a page break). */
const IGST_PDF: PdfOcr = {
  channel: 'purplle', input: 'pdf', pdf: 'PO_4300132312.PDF', sheet: null,
  header: header('4300132312', KHORDHA, '21AARCM7004J1ZG', '06AAICP2804J1ZG'),
  totals: { 'Total Qty': '192', 'Total IGST': '9,524.56', 'Total Amount (INR)': '62,438.80' },
  line_item_columns: [],
  line_items: [
    pdfLine(1, 'PPLB8906129575912', 'mCaffeine 7% Exfoliating Body Wash', '8906129575912', '449.00', '33049990', '24', '304.41', igst('18.00', '1,315'), '8,621'),
    pdfLine(3, 'PPLB8906129571099', 'mCaffeine Naked & Raw Coffee', '8906129571099', '279.00', '33049990', '48', '189.15', igst('18.00', '1,634'), '10,714'),
    pdfLine(9, 'PPLB8906129575929 mCaffeine Detan Body Wash', 'mCaffeine Detan Body Wash', '8906129575929', '449.00', '33049990', '120', '304.41', igst('18.00', '6,575'), '43,104'),
  ],
  warnings: [],
};
/** PO_4300132301.PDF: lines 1 and 3 (same state: SGST + CGST 9% + 9%, and 2.5% + 2.5% for the shampoo). */
const SGST_PDF: PdfOcr = {
  ...IGST_PDF, pdf: 'PO_4300132301.PDF',
  header: header('4300132301', BHIWANDI, '27AARCM7004J1Z4', '27AAICP2804J1ZC'),
  totals: { 'Total Qty': '26', 'Total SGST': '603.00', 'Total CGST': '603.00', 'Total Amount (INR)': '8,459.24' },
  line_items: [
    pdfLine(1, 'PPLB8906129574083', 'mCaffeine Blueberry Swirl Serum Body Lo', '8906129574083', '399.00', '33049930', '24', '270.51', sgstCgst('9.00', '584'), '7,661'),
    pdfLine(3, 'PPLB8906129576353', 'High Shine Glossing Shampoo', '8906129576353', '499.00', '33051090', '2', '380.19', sgstCgst('2.50', '19'), '798'),
  ],
};
const rawOf = (o: PdfOcr): RawOcr => ({
  header: { ...o.header, ...o.totals }, lines: o.line_items, lineColumns: [], inputType: 'pdf', inputFiles: [o.pdf], sourceFile: 'raw.json',
});
const process = async (o: PdfOcr = IGST_PDF) =>
  (await purplleHandler.process({ folder: '/tmp/purplle-pdf-test', meta: {}, channel: CHANNELS.PURPLLE, raw: rawOf(o), body: '', subject: '' })) as ProcessedPo;
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.PURPLLE), new Date('2026-11-06T12:00:00Z'));

/** The daily summary (EXECL_ATTACHED.XLS) as the OCR's sheet pipeline returns it: one row per PO line. */
const summaryRow = (po: string, item: string, ean: string, sku: string, mrp: string, price: string, qty: string) => ({
  'PO Document Number': po, 'Item No': item, 'EAN Number': ean, Sku: sku, 'Material long text': `${sku} product`, MRP: mrp, Price: price, Qty: qty,
  Plant: 'W512', Address: 'Plot No. B1A,B2-B5, Khurda Khordha 752055', 'Storage location': 'S001', 'Purchasing Group': 'TPB', 'PO Date': '06.11.2026', 'Expiry Date': '06.12.2026',
});
const summary = (lines: Record<string, string>[]) => ({
  channel: 'purplle', input: 'sheet', pdf: null, sheet: 'EXECL_ATTACHED.XLS', header: {}, line_item_columns: Object.keys(lines[0]), line_items: lines, warnings: [],
});

/** Purplle SOR as on dev (6 Nov): 5 SKU rows (rate = MRP x 0.8, with tax), Bhubaneshwar + Mumbai by consignee pincode. */
const seedPurplle = async () => {
  await insert('master_channels', { id: PURPLLE, slug: 'purplle-sor', display_name: 'Purplle SOR', db_aliases: ['Purplle SOR', 'purplle'], has_processor: 1, is_active: 1 });
  for (const [pep, code, mrp, rate, gst] of [
    ['Mcaf397_WB', 'PPLB8906129575912', 449, 359.2, '18'], ['55MCaf40', 'PPLB8906129571099', 279, 223.2, '18'], ['Mcaf396_WB', 'PPLB8906129575929', 449, 359.2, '18'],
    ['MCaf298_WB', 'PPLB8906129574083', 399, 319.2, '18'], ['Mcaf404', 'PPLB8906129576353', 499, 399.2, '5'],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'mCaffeine', product_type: 'Main Unit', mrp, gst_tax_type: gst, is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: PURPLLE, channel_name: 'Purplle SOR', channel_code: code, mrp, margin: 0.2, rate_after_margin: rate, is_active: 1 });
  }
  for (const [code, pin, gstin] of [['Bhubaneshwar', '752055', '21AARCM7004J1ZG'], ['Mumbai', '421311', '27AARCM7004J1Z4']]) {
    await insert('details_channels', {
      channel_id: PURPLLE, channel_name: 'Purplle SOR', channel_location_code: code, uniware_customer_code: `PURPLLE_SOR_${code.toUpperCase()}_${pin}`, channel_code: 'OTHER_B2B',
      facility_code: 'TEST_WH1', consignee_gst_number: gstin, consignee_pin_code: pin, final_shipping_address: `MANASH E-COMMERCE PRIVATE LTD, ${code} ${pin}`,
      is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};

/** Uploads files for Purplle, presses Process and waits until every upload is done; returns the upload ids. */
const uploadAndProcess = async (cookie: string, files: [Buffer, string][]) => {
  let req = api().post('/api/v1/manual-uploads').set('Cookie', cookie).field('channel', 'purplle');
  for (const [b, name] of files) req = req.attach('files', b, name);
  const ids = (await req.expect(201)).body.data.ids as string[];
  await api().post('/api/v1/manual-uploads/process').set('Cookie', cookie).send({ ids }).expect(200);
  for (const id of ids) {
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
  }
  return ids;
};

beforeEach(async () => {
  ocr.calls.length = 0;
  ocr.pdf = null;
  ocr.sheet = null;
  await resetDb();
  await seedMasters();
});
afterAll(closeDb);

describe('Purplle PO PDF -> processed.json (purplle-pdf.ts)', () => {
  it('IGST: header, delivery pincode + GSTINs, Item Code cut to its PPLB code, GST 18, values BEFORE GST (as the summary), totals agree', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'purplle', po_number: '4300132312', po_date: '2026-11-06', delivery_pincode: '752055', delivery_gstin: '21AARCM7004J1ZG',
      vendor_gstin: '06AAICP2804J1ZG', total_line_items: 3, total_qty: 192, po_value: 52914.24, cart_discount: 0, net_amount: 52914.24, expiry_date: '',
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.ean, l.hsn, l.qty, l.channel_mrp, l.unit_cost, l.gst, l.line_total])).toEqual([
      [1, 'PPLB8906129575912', '8906129575912', '33049990', 24, 449, 304.41, 18, 7305.84],
      [3, 'PPLB8906129571099', '8906129571099', '33049990', 48, 279, 189.15, 18, 9079.2],
      [9, 'PPLB8906129575929', '8906129575929', '33049990', 120, 449, 304.41, 18, 36529.2],
    ]);
    expect(po.warnings).toEqual([]);
    expect(po.needs_review).toBe(false);
    expect(po.field_sources).toMatchObject({ po_value: 'calculated (before GST)', 'line_items.channel_sku_code': 'raw (Item Code)' });
  });

  it('SGST + CGST: GST = the two rates (9 + 9, 2.5 + 2.5); a printed total that differs -> warning; FOC (all prices 0) -> review', async () => {
    const po = await process(SGST_PDF);
    expect(po.line_items.map((l) => [l.channel_sku_code, l.gst])).toEqual([['PPLB8906129574083', 18], ['PPLB8906129576353', 5]]);
    expect(po).toMatchObject({ delivery_pincode: '421311', vendor_gstin: '27AAICP2804J1ZC', total_qty: 26 });
    expect(po.warnings).toEqual([]);
    const off = await process({ ...SGST_PDF, totals: { ...SGST_PDF.totals, 'Total Qty': '30', 'Total Amount (INR)': '9,000.00' } });
    expect(off.warnings.map((w) => w.code)).toEqual(['TOTAL_QTY_MISMATCH', 'PO_VALUE_MISMATCH']);
    const foc = await process({ ...SGST_PDF, line_items: SGST_PDF.line_items.map((l) => ({ ...l, 'Rate/Unit': '0.00' })) });
    expect((foc.review_reasons ?? []).join(' ')).toContain('FOC');
  });

  it('as on dev: location by the delivery pincode, every SKU and price fits (Rate/Unit x (1 + GST %) = our rate): no issues', async () => {
    await seedPurplle();
    const v = await validate(await process());
    expect(v.location).toMatchObject({ locationCode: 'Bhubaneshwar', customerCode: 'PURPLLE_SOR_BHUBANESHWAR_752055', matchedBy: 'pincode' });
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([
      ['PPLB8906129575912', 'Mcaf397_WB', 359.2], ['PPLB8906129571099', '55MCaf40', 223.2], ['PPLB8906129575929', 'Mcaf396_WB', 359.2],
    ]);
    expect(v.issues).toEqual([]);
    expect((await validate(await process(SGST_PDF))).issues).toEqual([]);
  });
});

describe('Manual Upload: Purplle takes its PDFs (one PO each) or its summary sheet (many POs)', () => {
  it('the channel says PDF or sheet; each file is its own upload; another file type is refused with why', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedPurplle();
    const list = (await api().get('/api/v1/manual-uploads/channels').set('Cookie', reviewer.cookie).expect(200)).body.data;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'purplle', name: 'Purplle SOR', group: 'email', needs: 'PDF or XLSX / XLS / CSV', twoFiles: false, either: true })]));
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'purplle')
      .attach('files', Buffer.from('%PDF-1.4 a'), 'PO_4300132312.PDF').attach('files', Buffer.from('%PDF-1.4 b'), 'PO_4300132301.PDF')
      .attach('files', Buffer.from('summary'), 'EXECL_ATTACHED.XLS').expect(201);
    expect(up.body.data.ids).toHaveLength(3);
    const bad = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'purplle')
      .attach('files', Buffer.from('x'), 'PO_4300132312.docx');
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('two PDFs -> two POs with their sale orders (OCR "purplle" on each PDF)', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedPurplle();
    ocr.pdf = IGST_PDF;
    await uploadAndProcess(reviewer.cookie, [[Buffer.from('%PDF-1.4 a'), 'PO_4300132312.PDF']]);
    ocr.pdf = SGST_PDF;
    await uploadAndProcess(reviewer.cookie, [[Buffer.from('%PDF-1.4 b'), 'PO_4300132301.PDF']]);
    expect(ocr.calls.map((c) => [c.channel, c.files.length])).toEqual([['purplle', 1], ['purplle', 1]]);
    const made = await rows<{ po_number: string; status: string }>("SELECT po_number, status FROM po_uploads WHERE channel = 'Purplle SOR' ORDER BY po_number");
    expect(made).toEqual([{ po_number: '4300132301', status: 'completed' }, { po_number: '4300132312', status: 'completed' }]);
    const pos = await rows<{ poNumber: string; location: string }>("SELECT poNumber, location FROM master_purchase_orders ORDER BY poNumber");
    expect(pos.map((p) => [p.poNumber, p.location])).toEqual([['4300132301', 'Mumbai'], ['4300132312', 'Bhubaneshwar']]);
  });

  it('the summary after a PDF went in: that PO is left out quietly (no second row, no Duplicate review), the others are taken', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedPurplle();
    ocr.pdf = IGST_PDF;
    await uploadAndProcess(reviewer.cookie, [[Buffer.from('%PDF-1.4 a'), 'PO_4300132312.PDF']]);
    ocr.sheet = summary([
      summaryRow('4300132312', '10', '000008906129575912', 'PPLB8906129575912', '449.00', '304.41', '24'),
      summaryRow('4300132399', '10', '000008906129571099', 'PPLB8906129571099', '279.00', '189.15', '48'),
    ]);
    const [sheetId] = await uploadAndProcess(reviewer.cookie, [[Buffer.from('summary 6 Nov'), 'EXECL_ATTACHED.XLS']]);
    const made = await rows<{ po_number: string; status: string; email_message_id: string }>("SELECT po_number, status, email_message_id FROM po_uploads WHERE channel = 'Purplle SOR' ORDER BY id");
    expect(made.map((r) => [r.po_number, r.email_message_id === `manual-upload:${sheetId}`])).toEqual([['4300132312', false], ['4300132399', true]]);
    expect(await rows("SELECT id FROM po_issues WHERE issue_type = 'DUPLICATE_PO'")).toEqual([]);
    expect(Number((await rows<{ n: number }>("SELECT COUNT(*) n FROM master_purchase_orders WHERE poNumber = '4300132312'"))[0].n)).toBe(1);
  });

  it('a summary whose every PO is already in: its row is closed as rejected with the reason, nothing taken twice', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedPurplle();
    ocr.pdf = IGST_PDF;
    await uploadAndProcess(reviewer.cookie, [[Buffer.from('%PDF-1.4 a'), 'PO_4300132312.PDF']]);
    ocr.sheet = summary([summaryRow('4300132312', '10', '000008906129575912', 'PPLB8906129575912', '449.00', '304.41', '24')]);
    const [sheetId] = await uploadAndProcess(reviewer.cookie, [[Buffer.from('summary again'), 'EXECL_ATTACHED.XLS']]);
    const [row] = await rows<{ status: string; po_number: string | null; error_details: string }>('SELECT status, po_number, error_details FROM po_uploads WHERE email_message_id = ?', [`manual-upload:${sheetId}`]);
    expect(row).toMatchObject({ status: 'rejected', po_number: null });
    expect(JSON.stringify(row.error_details)).toContain('already in POST_FG');
    expect(Number((await rows<{ n: number }>("SELECT COUNT(*) n FROM po_uploads WHERE po_number = '4300132312'"))[0].n)).toBe(1);
  });
});
