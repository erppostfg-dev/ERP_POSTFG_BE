import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MASTER_IDS, CHANNELS, fileSafePo, UNIWARE_CSV } from '../../src/constants';
import { octavosHandler } from '../../src/modules/po-processing/channels/octavos/octavos.handler';
import type { ProcessedPo } from '../../src/modules/po-processing/common/processed-po';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { MasterDataReader } from '../../src/modules/po-validation/master-data';
import { validatePo } from '../../src/modules/po-validation/validate-po';
import { api, loginAs } from '../helpers/auth';
import { closeDb, db, insert, resetDb, rows } from '../helpers/db';
import { s3Objects } from '../helpers/fake-s3';
import { seedMasters } from '../helpers/fixtures';

/*
 * Octavos (Smytten) by Manual Upload (2026-11-05): its PO PDF -> OCR PDF pipeline (fixed names) -> octavos.handler ->
 * processed.json -> validation (SKU by the Octavos item code, price before tax x 1.18 vs our rate from the Smytten Minis
 * Master, no MRP on the PO; location by the pincode of Octavos' warehouse block, 387570 decided by the address) -> PO +
 * sale order + Uniware CSV (its file name with dashes for the PO number's slashes). Lines = PO OK/000367/2026-27.
 */
const ocr = vi.hoisted(() => ({ answer: null as Record<string, unknown> | null }));
vi.mock('../../src/modules/ocr/ocr-runner', async (orig) => ({
  ...(await orig<object>()),
  runOcr: vi.fn(async () => (ocr.answer
    ? { exitCode: 0, timedOut: false, durationMs: 1, result: ocr.answer, logTail: '' }
    : { exitCode: 1, timedOut: false, durationMs: 1, result: { error: 'OCR is off in tests' }, logTail: '' })),
}));

const OC = CHANNEL_MASTER_IDS[CHANNELS.OCTAVOS];
const HARYALA_2 = 'SURVEY NO. 686,693 at Prime Warehouse, Hub, Shed-B, Next to Dutron Pipes Co. N.H.NO.8, Village Haryala, Dist.-Kheda, 387570';
const line = (no: number, code: string, desc: string, qty: string, price: string, igst: string, amount: string) => ({
  'S.N.': `${no}.`, 'Item Code': code, Description: desc, Qty: qty, Unit: 'Unit', Price: price, 'CGST Rate': '', 'CGST Amount': '',
  'SGST Rate': '', 'SGST Amount': '', 'IGST Rate': '18.00%', 'IGST Amount': igst, Amount: amount,
});
const raw: RawOcr = {
  header: {
    'PO Number': 'OK/000367/2026-27', 'PO Date': '15-07-2026', 'Due Date': '15 Nov 2026.', 'Payment Terms': '30 Days Post GRN',
    'Buyer Name': 'OCTAVOS ENTERPRISE SOLUTIONS PVT LTD', 'Buyer GSTIN': '24AADCO2555N1Z8',
    'Buyer Address': 'SURVEY NO. 686,693 at Prime Warehouse, Hub,Shed-B, Next to Dutron Pipes Co. N.H.NO.8,Village Haryala,, Dist.-Kheda, 387570',
    'Vendor Name': 'Pep Technologies Pvt Ltd', 'Vendor GSTIN': '27AAICP2804J1ZC',
    'Total Quantity': '8,100.00', 'Taxable Total': '2,17,350.00', 'IGST Total': '39,123.00', 'Grand Total': '2,56,473.00',
  },
  lines: [
    line(1, 'DHNN005AA104', 'All I Need Sunscreen SPF 50 PA++++ 15 Ml', '2,700.00', '33.50', '16,281.00', '90,450.00'),
    line(2, 'DHNN0025AB2', 'Rice Water Brightening Daily Cleanser | Brightens Skin, Reduces Dark Spots 15 Ml', '2,250.00', '16.50', '6,682.50', '37,125.00'),
    line(3, 'DHNN003AA104', '18% Brightening + 20% Collagen Face Serum| Brightening & Collagen Boost 10 Ml', '3,150.00', '28.50', '16,159.50', '89,775.00'),
  ],
  lineColumns: [], inputType: 'pdf', inputFiles: ['OK-000367-2026-27.pdf'], sourceFile: 'raw.json',
};
const process = async (over: Partial<RawOcr> = {}) =>
  (await octavosHandler.process({ folder: '/tmp/octavos-test', meta: {}, channel: CHANNELS.OCTAVOS, raw: { ...raw, ...over }, body: '', subject: '' })) as ProcessedPo;

/**
 * OCTAVOS ENTERPRISE as on dev after the 5 Nov price load: channel_code = the Octavos item code, rate_after_margin = the
 * Smytten Minis Master price before GST x 1.18 (33.5 -> 39.53, 16.5 -> 19.47, 28.5 -> 33.63), no MRP check (the PO has
 * none); HARYALA and HARYALA_2 share 387570 (only their addresses differ); 122506 has no location.
 */
const seedOctavos = async () => {
  await insert('master_channels', { id: OC, slug: 'octavos', display_name: 'OCTAVOS ENTERPRISE', db_aliases: ['OCTAVOS ENTERPRISE', 'octavos'], has_processor: 0, is_active: 1 });
  for (const [pep, code, mrp, rate] of [
    ['HYPMUWB0004F0015', 'DHNN005AA104', 199, 39.53], ['HYPMUWB0017F0015', 'DHNN0025AB2', 99, 19.47], ['HYPMUBX0038F0010', 'DHNN003AA104', 249, 33.63],
  ] as const) {
    const pepSkuId = await insert('master_skus', { pep_code: pep, product_name: pep, brand_name: 'Hyphen', product_type: 'Main Unit', mrp, gst_tax_type: '18', is_active: 1, created_at: new Date(), updated_at: new Date() });
    await insert('master_channel_skus', { pep_code: pep, pep_sku_id: pepSkuId, channel_id: OC, channel_name: 'OCTAVOS ENTERPRISE', channel_code: code, mrp, margin: null, rate_after_margin: rate, is_active: 1 });
  }
  for (const [code, address] of [
    ['AHMEDABAD_2', 'M.chandulal estate,1 st floor-Abbott healthcare ltd Opp. ashapura hotel, N H 8, Aslali, Ahmedabad 382427'],
    ['GURGAON', 'Rect. No. 9, Killa/Khasra No. 11/2,, 11/2 Sanpka, Gurugram, Pataudi Gurugram, Haryana 122503'],
    ['HARYALA', 'B-1007-1008, TITANIUM SQUARE, NR. THALTEJ CROSS ROAD S.G HIGHWAY Ahmedabad Gujarat 387570'],
    ['HARYALA_2', HARYALA_2],
  ]) {
    await insert('details_channels', {
      channel_id: OC, channel_name: 'OCTAVOS ENTERPRISE', channel_location_code: code, uniware_customer_code: `OCTAVOS_ENTERPRISE_${code}`, channel_code: 'OTHER_B2B',
      facility_code: 'TEST_WH1', consignee_pin_code: null, final_shipping_address: address, is_active: 1, created_at: new Date(), updated_at: new Date(),
    });
  }
};
const validate = async (po: ProcessedPo) => validatePo(po, await new MasterDataReader(await db()).forChannel(CHANNELS.OCTAVOS), new Date('2026-07-16T06:00:00Z'));

beforeEach(async () => {
  ocr.answer = null;
  await resetDb();
  await seedMasters();
});
afterAll(closeDb);

describe('Octavos PDF -> processed.json (octavos.handler)', () => {
  it('PO number as printed (slashes), dates, the warehouse pincode, lines with tax worked out (prices before tax), Grand Total', async () => {
    const po = await process();
    expect(po).toMatchObject({
      channel_name: 'octavos', po_number: 'OK/000367/2026-27', po_date: '2026-07-15', expected_date: '2026-11-15', delivery_pincode: '387570',
      delivery_gstin: '24AADCO2555N1Z8', vendor_gstin: '27AAICP2804J1ZC', total_line_items: 3, total_qty: 8100, po_value: 256473, net_amount: 256473,
    });
    expect(po.line_items.map((l) => [l.line_no, l.channel_sku_code, l.qty, l.unit_cost, l.gst, l.landing_rate, l.line_total, l.channel_mrp])).toEqual([
      [1, 'DHNN005AA104', 2700, 33.5, 18, 39.53, 106731, ''],
      [2, 'DHNN0025AB2', 2250, 16.5, 18, 19.47, 43807.5, ''],
      [3, 'DHNN003AA104', 3150, 28.5, 18, 33.63, 105934.5, ''],
    ]);
    expect(po.line_items[0].unmapped).toMatchObject({ 'Amount (before tax)': '90450', 'IGST Amount': '16,281.00' });
    expect(po.warnings).toEqual([]);
    expect((await process({ header: { ...raw.header, 'PO Number': 'OK/ 000367/2026-27' } })).po_number).toBe('OK/000367/2026-27');
    expect((await process({ header: { ...raw.header, 'Grand Total': '3,00,000.00' } })).warnings.map((w) => w.code)).toContain('PO_VALUE_MISMATCH');
  });

  it('the Uniware CSV name writes the slashes as dashes (no sub-folders); other PO numbers are unchanged', () => {
    expect(UNIWARE_CSV.FILE_NAME('OK/000367/2026-27', '2026-11-05')).toBe('OK-000367-2026-27_final_2026-11-05.csv');
    expect(fileSafePo('P5654534')).toBe('P5654534');
  });
});

describe('Octavos checks', () => {
  it('387570 = HARYALA_2 by its address; prices before tax x 1.18 = our rate; no MRP on the PO = no MRP issue; no issues', async () => {
    await seedOctavos();
    const v = await validate(await process());
    expect(v.location).toMatchObject({ locationCode: 'HARYALA_2' });
    expect(v.lines.map((l) => [l.channelSkuCode, l.pepCode, l.ourRate])).toEqual([
      ['DHNN005AA104', 'HYPMUWB0004F0015', 39.53], ['DHNN0025AB2', 'HYPMUWB0017F0015', 19.47], ['DHNN003AA104', 'HYPMUBX0038F0010', 33.63],
    ]);
    expect(v.issues).toEqual([]);
  });

  it('review with the reasons: an item code not in our master (GBMCA…), pincode 122506 without a location, a price that differs', async () => {
    await seedOctavos();
    const farukh = { ...raw.header, 'Buyer Address': 'KHASRA NO 35/13, GURUGRAM CIRCLE-2, FARUKH NAGAR, Gurugram, Haryana - 122506' };
    const v = await validate(await process({ header: farukh, lines: [line(1, 'GBMCA004AA184', 'Gift box', '250.00', '70.00', '3,150.00', '17,500.00'), { ...raw.lines[2], Price: '43.50', Amount: '1,37,025.00' }] }));
    // (no total check while a line has no SKU of ours)
    expect(v.issues.map((i) => i.type).sort()).toEqual(['LOCATION_NOT_MAPPED', 'PRICE_MISMATCH', 'SKU_NOT_MAPPED']);
  });
});

describe('Manual Upload: the whole Octavos flow', () => {
  it('PDF -> OCR "octavos" -> PO OK/000367/2026-27 + sale order + CSV OK-000367-2026-27_final_…; the same PO again (by its file name) is refused', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedOctavos();
    const { 'Total Quantity': q, 'Grand Total': g, ...header } = raw.header;
    ocr.answer = { channel: 'octavos', header, totals: { 'Total Quantity': q, 'Grand Total': g }, line_item_columns: Object.keys(raw.lines[0]), line_items: raw.lines };
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'octavos')
      .attach('files', Buffer.from('%PDF-1.4 octavos'), 'OK-000367-2026-27.pdf').expect(201);
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
    const [u] = await rows<{ status: string; po_number: string }>('SELECT status, po_number FROM po_uploads WHERE email_message_id = ?', [`manual-upload:${id}`]);
    expect(u).toMatchObject({ status: 'completed', po_number: 'OK/000367/2026-27' });
    const [po] = await rows<{ orderNo1: string }>("SELECT orderNo1 FROM master_purchase_orders WHERE poNumber = 'OK/000367/2026-27'");
    expect(po.orderNo1).toMatch(/^erp_\d{11}$/);
    const csvKey = [...s3Objects().keys()].find((k) => k.endsWith('.csv') && k.includes('OK-000367-2026-27_final_'));
    expect(csvKey).toBeTruthy();
    expect(csvKey).not.toContain('OK/000367');
    expect(s3Objects().get(csvKey!)).toContain('OCTAVOS_ENTERPRISE_HARYALA_2');
    // another copy of the same PO (a different file, the PO number in its name): a sale order exists -> blocked
    const again = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'octavos')
      .attach('files', Buffer.from('%PDF-1.4 octavos re-saved'), 'OK-000367-2026-27 (1).pdf').expect(409);
    expect(again.body.error.code).toBe('MANUAL_ALREADY_BLOCKED');
    expect(again.body.error.details.copies[0]).toMatchObject({ poNumber: 'OK/000367/2026-27', how: 'same PO number', action: 'blocked' });
  });
});

describe('A gap in our master (user: "the masters team adds it"): review with a proper error, completed once added', () => {
  it('no rate for one SKU: In Review "no price in our master" (cannot be accepted); the masters team adds it -> the re-check completes the PO', async () => {
    const reviewer = await loginAs('operations-executive');
    await seedOctavos();
    await (await db()).query("UPDATE master_channel_skus SET rate_after_margin = NULL WHERE channel_code = 'DHNN003AA104'");
    const { 'Total Quantity': q, 'Grand Total': g, ...header } = raw.header;
    ocr.answer = { channel: 'octavos', header, totals: { 'Total Quantity': q, 'Grand Total': g }, line_item_columns: Object.keys(raw.lines[0]), line_items: raw.lines };
    const up = await api().post('/api/v1/manual-uploads').set('Cookie', reviewer.cookie).field('channel', 'octavos')
      .attach('files', Buffer.from('%PDF-1.4 octavos gap'), 'OK-000367-2026-27.pdf').expect(201);
    const [id] = up.body.data.ids as string[];
    await api().post('/api/v1/manual-uploads/process').set('Cookie', reviewer.cookie).send({ ids: [id] }).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM manual_uploads WHERE id = ?', [id]))[0].status).toBe('done'), { timeout: 20_000 });
    const [u] = await rows<{ id: string; status: string }>('SELECT id, status FROM po_uploads WHERE email_message_id = ?', [`manual-upload:${id}`]);
    expect(u.status).toBe('needs_review');

    const detail = (await api().get(`/api/v1/po-review/${u.id}`).set('Cookie', reviewer.cookie).expect(200)).body.data;
    const gap = (detail.issues as { issueId: string; type: string; field: string; details: string; canAccept: boolean }[]).find((i) => i.field === 'rate_after_margin');
    expect(gap).toMatchObject({ type: 'OTHER', canAccept: false });
    expect(gap?.details).toContain('no price in our master: our SKU HYPMUBX0038F0010');
    // a reviewer cannot wave it through (no sale order without our price)
    const sub = await api().post(`/api/v1/po-review/${u.id}/submit`).set('Cookie', reviewer.cookie).send({ accept: [{ issueId: gap?.issueId, remark: 'ok' }] });
    expect(sub.body.error.code).toBe('ISSUE_NOT_ACCEPTABLE');

    // the masters team adds the price -> the re-check closes the gap and the PO is saved with its sale order
    await (await db()).query("UPDATE master_channel_skus SET rate_after_margin = 33.63 WHERE channel_code = 'DHNN003AA104'");
    await api().post('/api/v1/po-review/recheck').set('Cookie', reviewer.cookie).expect(200);
    await vi.waitFor(async () => expect((await rows<{ status: string }>('SELECT status FROM po_uploads WHERE id = ?', [u.id]))[0].status).toBe('completed'), { timeout: 20_000 });
  });
});

