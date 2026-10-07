import { ChannelMapping, HeaderKey, LineKey } from '../../common/apply-mapping';

/*
 * Purplle: common name <- raw OCR field. Purplle sends no PO PDF, only a daily summary (EXECL_ATTACHED.XLS, really
 * tab-separated) with one row per PO line for ALL POs raised that day, 14 columns:
 *   PO Document Number, Item No, EAN Number, Sku, Material long text, MRP, Price, Qty, Plant, Address,
 *   Storage location, Purchasing Group, PO Date, Expiry Date
 * The raw output has no header block: the PO details repeat on every line, so they are read from each PO's first line.
 * Checked against the raw output of all 6 summaries (54 POs: 41 paid, 13 FOC); agreed with the user on 2026-10-07.
 * The user's table was written from Purplle's full PO PDF (PO Number, Rate/Unit, HSN Code, Total Amount (INR),
 * int_code), which we don't receive; each row was mapped to the summary's column instead.
 *
 * Filled in purplle.handler.ts, not here:
 * - one processed.json per PO Document Number (POs/<PO number>/processed.json in the email folder);
 * - delivery_pincode from Address (the match key: Purplle's pincode = details_channels.consignee_pin_code, all 13);
 * - line_total = Qty x Price, po_value = SUM(line_total), total_qty = SUM(Qty), total_line_items = the line count,
 *   all calculated and BEFORE GST (Purplle sends no tax); cart_discount 0, net_amount = po_value;
 * - cross-check of total_qty and po_value with the body's PO Summary (value within PURPLLE_VALUE_TOLERANCE);
 * - missing_fields, and FOC POs (Purchasing Group FOC, price 0) always marked for manual review.
 *
 * Not sent by Purplle, so "" (listed in missing_fields when a PO needs it): delivery_gstin, vendor_gstin, hsn, gst.
 * At the validation step they come from our master data (details_channels by pincode; master_skus by pep_code).
 * The Address is cut short by Purplle (about 30 characters of street + pincode + city); it is kept as sent and the
 * full address comes from details_channels.final_shipping_address.
 * Also "": type_delivery_facility (no int_code in the summary), expected_date, appointment_date, landing_rate, margin,
 * free_qty and the DB-later fields pep_sku_code, listing_sku_code, pep_mrp.
 */
export const PURPLLE_PO_COLUMN = 'PO Document Number';

export const PURPLLE_MAPPING: ChannelMapping = {
  header: [],
  headerFromLine: [
    { common: 'po_number', raw: PURPLLE_PO_COLUMN, kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    // Purplle's warehouse (Plant), e.g. W501; one fixed address per Plant.
    { common: 'delivery_facility_code', raw: 'Plant', kind: 'text' },
    { common: 'shipping address', raw: 'Address', kind: 'text' },
    { common: 'expiry_date', raw: 'Expiry Date', kind: 'date' },
    // Purchasing Group as given: "TPB" (paid) or "FOC" (free of cost).
    { common: 'po_type', raw: 'Purchasing Group', kind: 'text' },
  ],
  line: [
    // 10, 20, 30 ... as Purplle numbers its lines.
    { common: 'line_no', raw: 'Item No', kind: 'number' },
    // PPLB...: what the master data calls channel_code for Purplle.
    { common: 'channel_sku_code', raw: 'Sku', kind: 'text' },
    { common: 'ean', raw: 'EAN Number', kind: 'text' },
    { common: 'description', raw: 'Material long text', kind: 'text' },
    { common: 'qty', raw: 'Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Price = the PDF's Rate/Unit: unit price before tax.
    { common: 'unit_cost', raw: 'Price', kind: 'number' },
  ],
};

/** The FOC Purchasing Group: a free-of-cost PO, always reviewed by hand (its "...NF" SKUs are not in our master). */
export const PURPLLE_FOC = 'FOC';

/** The body's PO Value is computed from unrounded prices: up to Rs 2.97 off the file's sum in the 6 summaries seen. */
export const PURPLLE_VALUE_TOLERANCE = 3;

/** The fields a Purplle PO needs; any of them left "" goes into missing_fields. */
export const PURPLLE_REQUIRED: { header: HeaderKey[]; line: LineKey[] } = {
  header: ['po_number', 'po_date', 'delivery_facility_code', 'shipping address', 'delivery_pincode', 'total_qty', 'po_value',
    'expiry_date', 'delivery_gstin', 'vendor_gstin'],
  line: ['channel_sku_code', 'qty', 'channel_mrp', 'unit_cost', 'hsn', 'gst'],
};
