import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Nykaa: common name <- CSV column. Read from the vendor portal's "Purchase Orders" export
 * (Purchase Orders_allPo_2026_10_07_151402.csv, user 2026-10-27). By Manual Upload only: no email, no OCR; the sheet
 * reader puts every CSV row in the raw JSON as it is.
 *
 * One file = many POs, one row per PO line; the PO details repeat on every line, so the header is read from the PO's
 * first line (headerFromLine). Columns:
 *   PO Number, Vendor Code, Vendor Name, PO Release Date, Expected Delivery Date, Expiry Date, PO Amount, PO Line No,
 *   SKU Code, SKU Name, Vendor SKU Code, Unit Cost, MRP, PO Qty, Received Qty, Tax Amount, HSN Code, EAN Code,
 *   Delivery Location
 * Dates are dd-mm-yyyy. Unit Cost is BEFORE GST (262.17 x 180 + Tax Amount 8,494.44 = PO Amount 55,685.76 within
 * rounding). Vendor Code / Name = our billing entity (PEPTS = Pep Technologies MH, 553262 = Pep Technologies HR).
 * Filled in nykaa.handler.ts, not here: gst (from Tax Amount), landing_rate and line_total (calculated), totals,
 * cart_discount 0 / net_amount = po_value. Not sent: appointment date, shipping address / pincode (the location comes
 * from Delivery Location), GSTINs.
 */
export const NYKAA_MAPPING: ChannelMapping = {
  header: [],
  headerFromLine: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Release Date', kind: 'date' },
    { common: 'expected_date', raw: 'Expected Delivery Date', kind: 'date' },
    // Saved as the PO Expiry Date (master_purchase_orders.labelsLink, as PEPIMS).
    { common: 'expiry_date', raw: 'Expiry Date', kind: 'date' },
    // Nykaa's warehouse name = details_channels.channel_location_code of Nykaa (master_channels id 6).
    { common: 'delivery_facility_code', raw: 'Delivery Location', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'PO Line No', kind: 'number' },
    // SKU Code (MCAFF00000704 ...) = master_channel_skus.channel_code of Nykaa.
    { common: 'channel_sku_code', raw: 'SKU Code', kind: 'text' },
    // Vendor SKU Code = our PEP code. Only a hint for the reviewer when SKU Code is not mapped (validate-po); the
    // mapping itself always comes from master_channel_skus.
    { common: 'pep_sku_code', raw: 'Vendor SKU Code', kind: 'text' },
    { common: 'description', raw: 'SKU Name', kind: 'text' },
    { common: 'ean', raw: 'EAN Code', kind: 'text' },
    { common: 'qty', raw: 'PO Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Price per unit before GST.
    { common: 'unit_cost', raw: 'Unit Cost', kind: 'number' },
    { common: 'hsn', raw: 'HSN Code', kind: 'text' },
  ],
};

/** The CSV column that tells the POs apart (one file holds many POs). */
export const NYKAA_PO_COLUMN = 'PO Number';

/** GST of the whole line (rupees): gst % = Tax Amount / (PO Qty x Unit Cost). Kept in the line's unmapped too. */
export const NYKAA_TAX_COLUMN = 'Tax Amount';

/** Nykaa's own PO total (with GST), repeated on every line: checked against the sum of our line totals. */
export const NYKAA_PO_AMOUNT_COLUMN = 'PO Amount';

/** PO-level columns repeated on every line that have no common name: kept once in the PO's unmapped. */
export const NYKAA_PO_LEVEL_COLUMNS = ['Vendor Code', 'Vendor Name', 'PO Amount'];

/** Rupees per line that our total may differ from PO Amount (Nykaa rounds the tax per line). */
export const NYKAA_PO_AMOUNT_TOLERANCE_PER_LINE = 1;
