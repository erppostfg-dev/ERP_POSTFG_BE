import { CHANNEL_MASTER_IDS, CHANNELS } from '../../src/constants';
import type { RawOcr } from '../../src/modules/po-processing/common/raw-reader';
import { insert } from './db';

/*
 * First Club test data (2026-11-05), shared by test/flows/first-club.test.ts and manual-upload-copies.test.ts: a raw
 * OCR output in the layout of the samples (Downloads/First club, PO-199751: Hyderabad, 6 lines, IGST 18%) and the
 * FIRST CLUB master as on dev.
 */
export const FC = CHANNEL_MASTER_IDS[CHANNELS.FIRST_CLUB];
export const fcLine = (no: number, desc: string, sku: string, hsn: string, qty: number, mrp: number, unit: number, taxable: string, igst: string, total: string) => ({
  Sr: String(no), 'Item Description': desc, 'SKU Code': sku, HSN: hsn, COO: 'Nil', Qty: qty.toFixed(2), MRP: mrp.toFixed(2),
  'Unit Cost': String(unit), 'Taxable Value': taxable, CGST: '0.00', 'CGST Rate': '0.00%', SGST: '0.00', 'SGST Rate': '0.00%',
  IGST: igst, 'IGST Rate': '18.00%', CESS: '0.00', 'CESS Rate': '0.00%', Total: total,
});
export const HYD = '1-8/74/3, MEDCHAL MALKAJGIRI THUMKUNTA MUNICIPALITY DEVRAYAMJAL- YAMJAL HYDERABAD TELANGANA Pin code- 500078';
export const fcRaw: RawOcr = {
  header: {
    'PO Number': 'PO-199751-FRHHYDMDL01', 'PO Date': '2026-10-18', 'PO Release Date': '2026-10-18', 'Expected Delivery Date': '2026-11-17',
    'PO Expiry Date': '2026-11-22', 'Payment Terms': 'As per agreed terms', Status: 'APPROVED',
    'Vendor Name': 'PEP TECHNOLOGIES PRIVATE LIMITED', 'Vendor GSTIN': '27AAICP2804J1ZC',
    'Billing Name': 'Firstclub Technology PVT. LTD', 'Billing GSTIN': '36AAGCF0834Q1Z9', 'Billing Address': HYD,
    'Shipping Name': 'Firstclub Technology PVT. LTD', 'Shipping GSTIN': '36AAGCF0834Q1Z9', 'Shipping Address': HYD,
    'Total Amount': '88312.47', 'Grand Total': '88312.47',
  },
  lines: [
    fcLine(1, 'mCaffeine Take A Dip Triple-Action Deo Body Wash 250 ml', 'SKU263395210', '34013019', 48, 499, 283.33, '13599.84', '2447.97', '16047.81'),
    fcLine(2, 'mCaffeine Guava Tini De-Tan Body Wash 300 ml', 'SKU263395212', '33049990', 80, 449, 254.94, '20395.20', '3671.14', '24066.34'),
    fcLine(3, 'mCaffeine Sweet Escape Perfume Body Lotion 300 ml', 'SKU263395209', '33049190', 32, 499, 283.33, '9066.56', '1631.98', '10698.54'),
    fcLine(4, 'mCaffeine Brightening Raspberry Rush Body Wash 300 ml', 'SKU263395202', '34013019', 48, 399, 226.55, '10874.40', '1957.39', '12831.79'),
    fcLine(5, 'mCaffeine Caramel Crunch Exfoliating Body Wash 300 ml', 'SKU263395211', '33049990', 52, 449, 254.94, '13256.88', '2386.24', '15643.12'),
    fcLine(6, 'mCaffeine Naked & Raw Coffee Body Scrub 100 g', 'SKU263395214', '33049990', 30, 449, 254.94, '7648.20', '1376.68', '9024.88'),
  ],
  lineColumns: [], inputType: 'pdf', inputFiles: ['PO-199751.pdf'], sourceFile: 'raw.json',
};
/**
 * FIRST CLUB's master as on dev (5 Nov, read-only check): channel_code = First Club's SKU Code, rate_after_margin = MRP x
 * 0.67 with tax; SKU263395202 on FOUR of our codes (only MCaf383_WB_N1 is the Raspberry Rush body wash; the channel row
 * of 55MCaf40 has its own long name); the 2 locations keep their pincode only in final_shipping_address.
 */
export const seedFirstClub = async () => {
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
