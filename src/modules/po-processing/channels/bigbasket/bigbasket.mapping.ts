import { ChannelMapping } from '../../common/apply-mapping';
import { EmailSourceMapping } from '../../common/email-sources';

/*
 * BigBasket: common name <- raw OCR field (sheet only: one xlsx). Checked against the raw OCR output of
 * IRM45279529, IRA45550241, IRA45544122, IRA45546509 and IRA45547903 (the header names are the same in all 5)
 * and the Excel files of all 20 stored BigBasket POs (same layout); reviewed with the user on 2026-10-07.
 *
 * Filled in bigbasket.handler.ts, not here:
 * - total_qty = SUM(Quantity) and po_value = SUM(Total Value): the Excel's Total row holds only SUM formulas
 *   with no saved values, and the OCR returns no PO total;
 * - delivery_pincode (from the delivery address);
 * - po_type "AUTO-PO" / "MANUAL-PO" from the PO number prefix (BIGBASKET_PO_TYPES);
 * - cart_discount 0 and net_amount = po_value (BigBasket POs have no discount);
 * - "" for type_delivery_facility, expected_date, appointment_date (booked on BigBasket's portal), margin
 *   (no column), free_qty, and the DB-later fields pep_sku_code, listing_sku_code, pep_mrp.
 */
export const BIGBASKET_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    // The Excel's first line, e.g. WMS-Bangalore-FC (the user's "first line"): the delivery location key.
    { common: 'delivery_facility_code', raw: 'Delivery Name', kind: 'text' },
    { common: 'shipping address', raw: 'Delivery Address', kind: 'text' },
    // The Excel's "(count) N" label.
    { common: 'total_line_items', raw: 'Total Items', kind: 'number' },
    { common: 'expiry_date', raw: 'PO Expiry Date', kind: 'date' },
    { common: 'delivery_gstin', raw: 'Delivery GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Supplier GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'S.No', kind: 'number' },
    { common: 'channel_sku_code', raw: 'SKU Code', kind: 'text' },
    { common: 'ean', raw: 'EAN/UPC Code', kind: 'text' },
    { common: 'description', raw: 'Description', kind: 'text' },
    // Units ordered; "Case Quantity" (units per case) stays under unmapped.
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    { common: 'landing_rate', raw: 'Landing Cost', kind: 'number' },
    { common: 'unit_cost', raw: 'Basic Cost', kind: 'number' },
    { common: 'line_total', raw: 'Total Value', kind: 'number' },
    { common: 'hsn', raw: 'HSN Code', kind: 'text' },
    // BigBasket gives the one GST rate directly.
    { common: 'gst', raw: 'GST%', kind: 'number' },
  ],
};

/** PO number prefix -> BigBasket's PO type (matches the Excel sheet names <PO>AUTO-PO / <PO>MANUAL-PO). */
export const BIGBASKET_PO_TYPES: Record<string, string> = { IRA: 'AUTO-PO', IRM: 'MANUAL-PO' };

/*
 * BigBasket's email: no addresses or dates in the body, only the PO number in a sentence.
 *   Subject: Big Basket WMS-Bangalore-FC PO Details: PO No IRM45279529 Pep Technologies Pvt Ltd
 *   Body:    You have received a purchase order IRM45279529 from Bigbasket.
 */
export const BIGBASKET_EMAIL: EmailSourceMapping = {
  bodyPatterns: [{ common: 'po_number', pattern: /purchase order ([A-Z]{3}\d+)/i, kind: 'text' }],
  subject: [
    { common: 'po_number', pattern: /PO No ([A-Z]{3}\d+)/, kind: 'text' },
    { common: 'delivery_facility_code', pattern: /^Big Basket (.+?) PO Details:/i, kind: 'text' },
  ],
};
