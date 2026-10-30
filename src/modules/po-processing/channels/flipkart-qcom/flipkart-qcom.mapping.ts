import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Flipkart Quick Commerce: common name <- raw OCR field (purchase_order_<PO>.xls by Manual Upload; 2026-10-30).
 * The OCR's sheet pipeline (extract_excel_only_v2, channels.json "flipkart_quickcomm") reads the line table and the
 * footer with plain Python, so their names are the sheet's own (checked against FASWN08497679, 17-09-26, Hillway):
 *   S. no. | HSN/SA Code | FSN/ISBN13 | Quantity | Pending Quantity | UOM | Title | Brand | Model Name | Ean | Set Content
 *   | Vertical | Required by Date | Supplier MRP | Supplier Price | Taxable Value | IGST Rate | IGST Amount(per unit)
 *   | SGST/UTGST Rate | ... | CGST Rate | ... | CESS Rate | ... | Tax Amount | Total Amount
 * amounts without "INR" ("249.5"), rates as printed ("18.0%"); footer = "Total Quantity", "Total Taxable Value",
 * "Total Tax Amount", "Total Amount" (merged into the header by raw-reader). Only the header block above the table
 * goes to the OCR's model, which returns the labels as printed (PO#, ORDER DATE, PO Expiry, SHIPPED TO ADDRESS, GSTIN):
 * those accept other spellings (FLIPKART_QCOM_HEADER_NAMES) until a real run shows them.
 *
 * Master ("Flipkart Qcom", id 16): channel_code = the FSN; rate_after_margin = Supplier Price (with tax: 249.50 x 36 =
 * Total Amount 8,982; Taxable Value = Supplier Price / 1.18 x qty). Location: the SHIPPED TO ADDRESS pincode.
 *
 * Filled in flipkart-qcom.handler.ts, not here: po_date / expiry_date ("17-09-26": two-digit year), expected_date (the
 * lines' Required by Date), delivery_pincode (SHIPPED TO ADDRESS), delivery_gstin (a header GSTIN that is not ours),
 * gst (IGST + SGST/UTGST + CGST rates), total_qty / po_value (footer, else the lines' sums), total_line_items, no discount.
 * "" (not on the PO): delivery_facility_code, type_delivery_facility, appointment_date, po_type, margin, free_qty
 * (Pending Quantity is the qty not yet received, kept under unmapped), pep_sku_code, listing_sku_code, pep_mrp.
 */

export const FLIPKART_QCOM_HEADER_NAMES: Record<string, string[]> = {
  'PO#': ['PO#', 'PO', 'PO Number', 'PO No', 'Purchase Order', 'Purchase Order Number'],
  'ORDER DATE': ['ORDER DATE', 'PO Date', 'Order Date'],
  'PO Expiry': ['PO Expiry', 'PO Expiry Date', 'Expiry Date'],
  'SHIPPED TO ADDRESS': ['SHIPPED TO ADDRESS', 'Shipped To', 'Ship To Address', 'Shipping Address'],
  'Total Quantity': ['Total Quantity', 'Total Qty'],
  'Total Amount': ['Total Amount', 'Grand Total'],
};

export const FLIPKART_QCOM_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO#', kind: 'text' },
    { common: 'shipping address', raw: 'SHIPPED TO ADDRESS', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'S. no.', kind: 'number' },
    // Flipkart's FSN = master_channel_skus.channel_code of Flipkart Qcom (gives the _S code for combos).
    { common: 'channel_sku_code', raw: 'FSN/ISBN13', kind: 'text' },
    { common: 'hsn', raw: 'HSN/SA Code', kind: 'text' },
    { common: 'ean', raw: 'Ean', kind: 'text' },
    { common: 'description', raw: 'Title', kind: 'text' },
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    { common: 'channel_mrp', raw: 'Supplier MRP', kind: 'number' },
    // Unit price WITH tax = our rate_after_margin.
    { common: 'landing_rate', raw: 'Supplier Price', kind: 'number' },
    { common: 'line_total', raw: 'Total Amount', kind: 'number' },
  ],
};

/** The rate columns that add up to the line's GST %. */
export const FLIPKART_QCOM_RATES = ['IGST Rate', 'SGST/UTGST Rate', 'CGST Rate'];
/** Footer totals vs the lines: paise per line add up. */
export const FLIPKART_QCOM_TOTAL_TOLERANCE = 1;
