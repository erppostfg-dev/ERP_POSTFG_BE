import { ChannelMapping } from '../../common/apply-mapping';
import { EmailSourceMapping } from '../../common/email-sources';
import { GstColumns } from '../../common/gst';

/*
 * Scootsy (Swiggy Instamart): common name <- raw OCR field (sheet only: the .xlsx; the .pdf is kept for reference).
 * Checked against the raw OCR output of FC5PO449307, JN2PO137815, CI3PO102314, JPAPO78907 and GCAPO84932;
 * reviewed with the user on 2026-10-07. The 18 line columns are the same in all 5; the PO number field is
 * "PO No" or "PO Number" (both accepted).
 *
 * Filled in scootsy.handler.ts, not here:
 * - delivery_facility_code: the subject's facility part, e.g. "JAI IM1", "DLHY GGNFC5" (the facility codes; the raw
 *   Shipping Name carries it on only 3 of 5 POs, so it is only used to cross-check);
 * - landing_rate = Total (INR) / Qty per line (calculated: Scootsy has no landing price column);
 * - total_line_items (last S. No) and total_qty (SUM of Qty), calculated;
 * - cart_discount 0 and net_amount = po_value (Scootsy POs have no discount);
 * - "" for type_delivery_facility, appointment_date (Scootsy sends it later in "Appointment CREATED" emails),
 *   po_type, ean, margin, free_qty and the DB-later fields pep_sku_code, listing_sku_code, pep_mrp.
 */
export const SCOOTSY_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: ['PO No', 'PO Number'], kind: 'text' },
    // The user chose PO Date (equal to PO Release Date on all 5 POs seen).
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'shipping address', raw: 'Shipping Address', kind: 'text' },
    // Grand Total = with tax = the sum of the line totals (po_value = before discount; Scootsy has no discount).
    { common: 'po_value', raw: 'Grand Total (INR)', kind: 'number' },
    { common: 'expected_date', raw: 'Expected Delivery Date', kind: 'date' },
    { common: 'expiry_date', raw: 'PO Expiry Date', kind: 'date' },
    { common: 'delivery_gstin', raw: 'Shipping GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'S. No', kind: 'number' },
    // Scootsy's item code: what the master data calls channel_code (e.g. 283463).
    { common: 'channel_sku_code', raw: 'Item Code', kind: 'text' },
    { common: 'description', raw: 'Item Desc', kind: 'text' },
    { common: 'hsn', raw: 'HSN Code', kind: 'text' },
    { common: 'qty', raw: 'Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Unit price before tax (e.g. 184.97 for an MRP 299 item).
    { common: 'unit_cost', raw: 'Unit Base Cost (INR)', kind: 'number' },
    { common: 'line_total', raw: 'Total (INR)', kind: 'number' },
  ],
};

export const SCOOTSY_GST_COLUMNS: GstColumns = { cgst: 'CGST Rate', sgst: 'SGST/UGST Rate', igst: 'IGST Rate' };

/** The raw Shipping Name is "SCOOTSY LOGISTICS PRIVATE LIMITED [<facility>]"; the facility part is optional. */
export const SCOOTSY_SHIPPING_NAME = /^\s*SCOOTSY LOGISTICS PRIVATE LIMITED\s*(.*)$/i;

/*
 * Scootsy's email:
 *   Subject: <facility>-<PO number>-PEP TECHNOLOGIES PRIVATE LIMITED, e.g. "JAI IM1-JPAPO78907-PEP TECHNOLOGIES PRIVATE LIMITED"
 *   Body:    Please find attached Purchase order No JPAPO78907, ...
 * The facility is taken from the subject (always there); the PO number is cross-checked with subject and body.
 */
export const SCOOTSY_EMAIL: EmailSourceMapping = {
  bodyPatterns: [{ common: 'po_number', pattern: /Purchase order No\s*([A-Z0-9]+)/i, kind: 'text' }],
  subject: [
    { common: 'po_number', pattern: /-([A-Z0-9]{2,6}PO\d+)-/i, kind: 'text' },
    { common: 'delivery_facility_code', pattern: /^(.+?)-[A-Z0-9]{2,6}PO\d+-/i, kind: 'text' },
  ],
};
