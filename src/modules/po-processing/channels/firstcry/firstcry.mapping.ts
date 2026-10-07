import { ChannelMapping } from '../../common/apply-mapping';
import { EmailSourceMapping } from '../../common/email-sources';

/*
 * FirstCry: common name <- raw OCR field (sheet only: the .xls downloaded from the email's links). Checked against
 * the raw OCR output of pin218260930zye82e3, pin212260930pgp8eff, pin175260930ufx182a and pin123260930soa54a9;
 * reviewed with the user on 2026-10-07. The 18 line columns are the same in all 4; the header has 20, 24 or
 * 26 fields and the GSTIN names vary (the alternatives are listed).
 *
 * Amounts (option B): po_value = before discount (Sub Total (Total Amount)), net_amount = Sub Total After
 * Discount, cart_discount = the difference (calculated in firstcry.handler.ts).
 * Also in the handler: total_line_items (last Sr.No.), delivery_pincode (from the delivery address), and "" for
 * type_delivery_facility, expected_date, appointment_date (the body only says to take one), margin, po_type and
 * the DB-later fields pep_sku_code, pep_mrp.
 */
export const FIRSTCRY_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO No.', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    // The stockist, e.g. "Sri Laxmi Balaji Enterprises-Medchel" (also the subject's "for ..." part).
    { common: 'delivery_facility_code', raw: 'Delivered To', kind: 'text' },
    { common: 'shipping address', raw: 'Delivered To Address', kind: 'text' },
    { common: 'total_qty', raw: 'Sub Total (Total Qty)', kind: 'number' },
    { common: 'po_value', raw: 'Sub Total (Total Amount)', kind: 'number' },
    { common: 'net_amount', raw: 'Sub Total After Discount (Total Amount)', kind: 'number' },
    { common: 'expiry_date', raw: 'PO Expiry Date', kind: 'date' },
    { common: 'delivery_gstin', raw: ['Delivered To GSTIN', 'Delivered To GST No', 'Delivered To GST No.'], kind: 'text' },
    // Our ship-from entity; "Delivered By GSTIN" is in every PO, "Vendor GSTIN" only in some.
    { common: 'vendor_gstin', raw: ['Delivered By GSTIN', 'Vendor GSTIN'], kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'Sr.No.', kind: 'number' },
    { common: 'channel_sku_code', raw: 'FCID', kind: 'text' },
    // The user's choice: FirstCry's Style Code (e.g. HYPMUBX001F050) is the listing SKU code.
    { common: 'listing_sku_code', raw: 'Style Code', kind: 'text' },
    { common: 'ean', raw: 'Manufacturer BarCode', kind: 'text' },
    { common: 'description', raw: 'Product Name', kind: 'text' },
    // Total Qty = Billed Qty + Free Qty; the line amount is charged on Billed Qty only.
    { common: 'qty', raw: 'Total Qty', kind: 'number' },
    { common: 'free_qty', raw: 'Free Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    { common: 'landing_rate', raw: 'Landing Rate', kind: 'number' },
    { common: 'unit_cost', raw: 'Base Cost', kind: 'number' },
    { common: 'line_total', raw: 'Total Amount', kind: 'number' },
    { common: 'hsn', raw: 'HSN Code', kind: 'text' },
    // FirstCry gives the one GST rate directly.
    { common: 'gst', raw: 'Tax', kind: 'number' },
  ],
};

/*
 * FirstCry's email: the body has no PO data (only the two download links), so the subject is the only check:
 *   PEP TECHNOLOGIES PRIVATE LIMITED-Hyphen PONO pin218260930zye82e3 for Sri Laxmi Balaji Enterprises-Medchel
 */
export const FIRSTCRY_EMAIL: EmailSourceMapping = {
  subject: [
    { common: 'po_number', pattern: /PONO (pin\w+)/i, kind: 'text' },
    { common: 'delivery_facility_code', pattern: /PONO pin\w+ for (.+?)\s*$/i, kind: 'text' },
  ],
};
