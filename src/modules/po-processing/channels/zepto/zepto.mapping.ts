import { ChannelMapping } from '../../common/apply-mapping';
import { EmailSourceMapping } from '../../common/email-sources';
import { GstColumns } from '../../common/gst';

/*
 * Zepto: common name <- raw OCR field (pdf + csv). Checked against the real OCR output of P5724363, P5727174,
 * P5736882 and P5744492; reviewed with the user on 2026-10-06 ("PO Field Mapping: Common Names" doc).
 *
 * Zepto's CSV has the same 36 columns in every PO and repeats the PO details on every line, so most header
 * values are read from the first line (headerFromLine). Only three come from the PDF header, whose field
 * names change from PO to PO (the alternatives are listed).
 * Filled in zepto.handler.ts, not here: total_qty (SUM of Quantity: Zepto sends no total), total_line_items
 * (LineNumber of the last line), delivery_pincode (from the shipping address), gst (CGST + SGST, or IGST),
 * cart_discount 0 and net_amount = po_value (Zepto POs have no discount), and "" for type_delivery_facility
 * (StoreName is only the location code), appointment_date, po_type, free_qty and the DB-later fields
 * pep_sku_code, listing_sku_code, pep_mrp.
 */
export const ZEPTO_MAPPING: ChannelMapping = {
  header: [
    { common: 'shipping address', raw: 'Shipping Address', kind: 'text' },
    { common: 'expected_date', raw: 'Expected Delivery Date', kind: 'date' },
    { common: 'delivery_gstin', raw: ['Shipping GSTIN', 'Shipping GST No.', 'Shipping Address GSTIN'], kind: 'text' },
    { common: 'vendor_gstin', raw: ['Vendor GSTIN', 'Vendor GST No.'], kind: 'text' },
  ],
  headerFromLine: [
    { common: 'po_number', raw: 'PoNumber', kind: 'text' },
    { common: 'po_date', raw: 'PoDate', kind: 'date' },
    // The location code (channel_location_code), e.g. MUM-SS-MH-SHAKTI; the delivery location is matched on it.
    { common: 'delivery_facility_code', raw: 'StoreName', kind: 'text' },
    { common: 'po_value', raw: 'PoTotalAmount', kind: 'number' },
    { common: 'expiry_date', raw: 'PoExpiryDate', kind: 'date' },
  ],
  line: [
    { common: 'line_no', raw: 'LineNumber', kind: 'number' },
    // The long UUID: what the Zepto SKU mapping uses (MaterialCode stays under unmapped).
    { common: 'channel_sku_code', raw: 'Sku', kind: 'text' },
    { common: 'ean', raw: 'EAN', kind: 'text' },
    { common: 'description', raw: 'SkuDesc', kind: 'text' },
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    { common: 'landing_rate', raw: 'LandingCost', kind: 'number' },
    { common: 'unit_cost', raw: 'UnitBaseCost', kind: 'number' },
    { common: 'line_total', raw: 'TotalAmount', kind: 'number' },
    { common: 'margin', raw: 'BaseMarginPercentage', kind: 'number' },
    { common: 'hsn', raw: 'HSN', kind: 'text' },
  ],
};

export const ZEPTO_GST_COLUMNS: GstColumns = { cgst: 'CGSTPercentage', sgst: 'SGSTPercentage', igst: 'IGSTPercentage' };

/*
 * Zepto's email: cross-checks the raw values and fills the ones the raw JSON lacks (all 33 Zepto PO emails have
 * these lines):
 *   Order Number: P5727174           Order Date: 2026-10-01
 *   Shipping Address: R2,Shakti Logistics Park ..., Maharashtra 421302
 *   Billing Address: ...             Expected Delivery Date: 2026-10-02     Expiry Date: 2026-10-22
 * Subject: Purchase Order for [<our entity> and <PO number>]
 */
export const ZEPTO_EMAIL: EmailSourceMapping = {
  body: [
    { common: 'po_number', label: 'Order Number', kind: 'text' },
    { common: 'po_date', label: 'Order Date', kind: 'date' },
    { common: 'shipping address', label: 'Shipping Address', kind: 'address' },
    { common: 'delivery_pincode', label: 'Shipping Address', kind: 'pincode' },
    { common: 'expected_date', label: 'Expected Delivery Date', kind: 'date' },
    { common: 'expiry_date', label: 'Expiry Date', kind: 'date' },
  ],
  bodyExtras: ['Billing Address'],
  subject: [{ common: 'po_number', pattern: / and (P\d+)\]\s*$/, kind: 'text' }],
};
