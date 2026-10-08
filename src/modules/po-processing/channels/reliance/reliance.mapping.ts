import { ChannelMapping } from '../../common/apply-mapping';
import { EmailSourceMapping } from '../../common/email-sources';

/*
 * Reliance Retail: common name <- raw OCR field (PDF only: "PO. INTM_ <PO> .PDF Reliance Retail Limited.PDF").
 * Checked against the raw OCR output of 5000496668, 5000498564, 5000498578 (inter-state, IGST) and 5000501376,
 * after the ocr-service fixes of 2026-10-08 (stacked cells kept apart with " / "); agreed with the user on 2026-10-08:
 * map what Reliance sends, calculate what can be calculated, "" for what is missing, everything else under unmapped.
 *
 * Line cells are stacked in the PDF and split by common/stacked.ts before this mapping is applied:
 *   "Article No. / HSN Code", "EAN No. / Vendor Article No. / Vendor Item No / Vendor Article Name",
 *   "Material Description / Delivery Date / Site", "CGST(%) / SGST(%) / CESS(%) / CessFxdRt" (or IGST (%) ...),
 *   "CGST / SGST / CESS / CessFxdVl" (or IGST ...).
 *
 * Filled in reliance.handler.ts, not here:
 * - delivery_pincode from the delivery address;
 * - gst = IGST % when charged (inter-state), else CGST % + SGST %;
 * - line_total = Total Base Value + the line's tax amounts (CGST, SGST, IGST, CESS, CessFxdVl), so the lines add up
 *   to Total Order Value; landing_rate = line_total / qty; both "calculated";
 * - total_line_items = the last Sr.No (calculated); cart_discount 0 and net_amount = po_value (no discount);
 * - checks: SUM(qty) = Grand Total of Qty, SUM(Total Base Value) = TOTAL BASIC VALUE, SUM(line_total) = po_value,
 *   and each line's Delivery Date / Site = the header's.
 *
 * "" (Reliance doesn't send it): type_delivery_facility (Delivery Address Name is "Distribution Center" on some POs and
 * a DC name on others, so it stays under unmapped), expiry_date, appointment_date, po_type, margin, free_qty, and the
 * DB-later fields pep_sku_code, listing_sku_code, pep_mrp.
 * Kept under unmapped: buyer and vendor details, Payment / Delivery Terms, contacts, CIN, TOTAL BASIC VALUE,
 * TOTAL CGST / SGST / IGST; per line: Vendor Article No (only on some lines), UOM, Total Base Value, the tax amounts,
 * CESS(%), CessFxdRt.
 */
export const RELIANCE_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    // Reliance's site (DC) code, e.g. S4ZD (Bhiwandi), SA1A (Bahadurgarh); the OCR names it either way.
    { common: 'delivery_facility_code', raw: ['Site Code', 'Site'], kind: 'text' },
    { common: 'shipping address', raw: ['Delivery Address', 'Delivered To Address'], kind: 'text' },
    { common: 'total_qty', raw: 'Grand Total of Qty', kind: 'number' },
    // With tax (= TOTAL BASIC VALUE + taxes); Reliance POs have no discount.
    { common: 'po_value', raw: ['Total Order Value:', 'Total Order Value'], kind: 'number' },
    { common: 'expected_date', raw: 'Delivery Date', kind: 'date' },
    { common: 'delivery_gstin', raw: ['Delivery Address GSTIN', 'Delivered To GSTIN'], kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'Sr.No', kind: 'number' },
    // Reliance's article number (9 digits): what the master data calls channel_code for Reliance.
    { common: 'channel_sku_code', raw: 'Article No.', kind: 'text' },
    { common: 'hsn', raw: 'HSN Code', kind: 'text' },
    { common: 'ean', raw: 'EAN No.', kind: 'text' },
    { common: 'description', raw: 'Material Description', kind: 'text' },
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Unit price before tax.
    { common: 'unit_cost', raw: 'Base Cost', kind: 'number' },
  ],
};

/** GST rate columns (after unstacking): IGST on inter-state POs, CGST + SGST otherwise. */
export const RELIANCE_RATES = { cgst: 'CGST(%)', sgst: 'SGST(%)', igst: 'IGST (%)' };
/** Tax amount columns of a line (after unstacking): added to Total Base Value for line_total. */
export const RELIANCE_TAX_AMOUNTS = ['CGST', 'SGST', 'IGST', 'CESS', 'CessFxdVl'];
export const RELIANCE_BASE_VALUE = 'Total Base Value';
export const RELIANCE_TOTAL_BASIC = 'TOTAL BASIC VALUE';
/** Rounding between Reliance's line amounts and its totals (paise per line add up). */
export const RELIANCE_TOTAL_TOLERANCE = 1;

/*
 * Reliance's email:
 *   Subject: PO. INTM: 5000501376 .PDF Reliance Retail Limited
 *   Body:    Please find attached our Purchase Order (P.O.) No.5000501376 Dated07.10.2026
 * PO number cross-checked with subject and body, PO date with the body.
 */
export const RELIANCE_EMAIL: EmailSourceMapping = {
  bodyPatterns: [
    { common: 'po_number', pattern: /\(P\.O\.\)\s*No\.?\s*(\d{10})/i, kind: 'text' },
    { common: 'po_date', pattern: /\(P\.O\.\)\s*No\.?\s*\d{10}\s*Dated\s*(\d{2}\.\d{2}\.\d{4})/i, kind: 'date' },
  ],
  subject: [{ common: 'po_number', pattern: /INTM:\s*(\d{10})/i, kind: 'text' }],
};
