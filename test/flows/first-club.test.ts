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
import { FC, fcRaw as raw, seedFirstClub } from '../helpers/first-club';

/*
 * First Club by Manual Upload (2026-11-05): its PO PDF -> OCR PDF pipeline (fixed header / line names, tax cells split)
 * -> first-club.handler -> processed.json -> validation (SKU by First Club's SKU Code = its channel_code, a code on
 * several of our codes told apart by the item description; location by the Shipping Address pincode). The lines below
 * follow the layout of the samples (Downloads/First club, PO-199751: Hyderabad, 6 lines, IGST 18%).
 */
/** The OCR itself (Python + model) is replaced: it answers with `ocr.answer` (the OCR team's raw JSON) and records the entry asked for. */
const ocr = vi.hoisted(() => ({ calls: [] as { channel: string; files: string[] }[], answer: null as Record<string, unknown> | null }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async (channel: string, files: string[]) => {
    ocr.calls.push({ channel, files });
    return ocr.answer
      ? { exitCode: ocr.answer.error ? 1 : 0, timedOut: false, durationMs: 1, result: ocr.answer, log: '' }
      : { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'OCR is off in tests' }, log: '' };
  }),
}));
const process = async (over: Partial<RawOcr> = {}) =>
  (await firstClubHandler.process({ folder: '/tmp/first-club-test', meta: {}, channel: CHANNELS.FIRST_CLUB, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

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

  it('an OCR failure: the Failed reason says what failed and at which OCR stage (not just "exited with code 1")', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedFirstClub();
    ocr.answer = { channel: 'first_club', error: 'InvalidS3ObjectException - Unable to get object metadata from S3', error_type: 'PipelineError',
      error_code: 'InvalidS3ObjectException', ocr_run: { stage: 'tables (+ header in parallel)', totals: { cost_usd: 0.0141 } } };
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'first_club')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'PO-210392.pdf');
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('failed'), { timeout: 20_000 });
    const [m] = await rows<{ note: string }>('SELECT note FROM manual_uploads WHERE id = ?', [id]);
    expect(m.note).toContain('Unable to get object metadata from S3');
    expect(m.note).toContain('OCR stage: tables (+ header in parallel)');
  });
});
