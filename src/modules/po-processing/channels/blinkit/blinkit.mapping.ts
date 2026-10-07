import { ChannelMapping } from '../../common/apply-mapping';
import { EmailSourceMapping } from '../../common/email-sources';
import { GstColumns } from '../../common/gst';

/*
 * Blinkit: common name <- raw OCR field (pdf + sheet: header from the PDF, lines and totals from the XLSX).
 * Checked against the real OCR output of POs 2135610086645 and 50033210061004; reviewed with the user on
 * 2026-10-06 ("PO Field Mapping: Common Names" doc). Filled in blinkit.handler.ts, not here:
 * type_delivery_facility ("": Blinkit sends no facility type), delivery_pincode (from "Delivered To"),
 * gst (CGST % + SGST %, or IGST %), and the DB-later fields pep_sku_code, listing_sku_code, pep_mrp ("").
 */
export const BLINKIT_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'delivery_facility_code', raw: 'Buyer Facility Name', kind: 'text' },
    { common: 'shipping address', raw: 'Delivered To', kind: 'text' },
    { common: 'total_line_items', raw: 'Total Items', kind: 'number' },
    { common: 'total_qty', raw: 'Total Quantity', kind: 'number' },
    { common: 'po_value', raw: 'Total Amount', kind: 'number' },
    { common: 'expected_date', raw: 'PO Delivery Date', kind: 'date' },
    { common: 'expiry_date', raw: 'PO Expiry Date', kind: 'date' },
    { common: 'delivery_gstin', raw: 'Delivered To GST No', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GST No', kind: 'text' },
    { common: 'cart_discount', raw: 'Cart Discount', kind: 'number' },
    { common: 'net_amount', raw: 'Net amount', kind: 'number' },
    { common: 'po_type', raw: 'PO Type', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: '#', kind: 'number' },
    { common: 'channel_sku_code', raw: 'Item Code', kind: 'text' },
    { common: 'ean', raw: 'Product UPC', kind: 'text' },
    { common: 'description', raw: 'Product Description', kind: 'text' },
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    { common: 'landing_rate', raw: 'Landing Rate', kind: 'number' },
    { common: 'unit_cost', raw: 'Basic Cost Price', kind: 'number' },
    { common: 'line_total', raw: 'Total Amount', kind: 'number' },
    { common: 'margin', raw: 'Margin %', kind: 'number' },
    { common: 'hsn', raw: 'HSN Code', kind: 'text' },
  ],
};

/** Line columns that make up the one GST rate (gst = CGST % + SGST %, or IGST %). */
export const BLINKIT_GST_COLUMNS: GstColumns = { cgst: 'CGST %', sgst: 'SGST %', igst: 'IGST %' };

/*
 * Blinkit's email: cross-checks the raw values and fills the ones the raw JSON lacks (checked against all 53
 * Blinkit emails: 51 have this block). A revised PO's body has no address block, only "has been REVISED".
 *   Bill To: BCPL - Kolkata K4 Feeder Warehouse
 *    GST NO : 19AAFCG9846E1Z8
 *   Billing Address : ..., 700113
 *   Shipping Address: ..., 700113
 *   Contact Name : ...   Contact Number : ...
 * Subject: PO_<Bill To>_<CITY>_<warehouse>_<our entity>-<PO number> : <PO date YYYY-MM-DD>
 */
export const BLINKIT_EMAIL: EmailSourceMapping = {
  body: [
    { common: 'delivery_facility_code', label: 'Bill To', kind: 'text' },
    { common: 'shipping address', label: 'Shipping Address', kind: 'address' },
    { common: 'delivery_pincode', label: 'Shipping Address', kind: 'pincode' },
    { common: 'delivery_gstin', label: 'GST NO', kind: 'text' },
  ],
  bodyExtras: ['Billing Address', 'Contact Name', 'Contact Number'],
  subject: [
    { common: 'po_number', pattern: /-(\d{10,16}) : \d{4}-\d{2}-\d{2}\s*$/, kind: 'text' },
    { common: 'po_date', pattern: / : (\d{4}-\d{2}-\d{2})\s*$/, kind: 'date' },
  ],
};

/** The body text Blinkit uses for a revised PO. */
export const BLINKIT_REVISED = /this purchase order has been revised/i;
