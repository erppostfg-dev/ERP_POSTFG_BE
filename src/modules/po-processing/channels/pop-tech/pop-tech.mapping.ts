import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Pop Tech (Curioso Fashions): common name <- raw OCR field (Unicommerce PO PDF by Manual Upload, OCR PDF pipeline;
 * 2026-11-02). Built from the 5 sample PDFs (Downloads/POP TEch: DL_MCFN002-005, BLR_MCFN002), NOT yet from a real OCR
 * output, so every field accepts the other names the OCR may use (compared without case, spaces or punctuation).
 *
 * Header names = the OCR's header_notes for "pop_tech" (ocr-service channels.json): PO Number, PO Date, Expiry Date,
 * Delivery Date, Buyer Name / Address / GSTIN (the "Purchser" box), Vendor Name / Address / GSTIN (the "Sender" box),
 * Ship To Name / Address / Phone / GSTIN, Payment Terms, Amount In Words.
 * Lines (as printed): SI No. | Product Name | EAN code | QTY | Rate | MRP | Taxable Value | SGST | CGST | Amount, the tax
 * cells "1522.40 (9.000%)" split by the OCR (split_value_rate_cells) into "SGST" = 1522.40 and "SGST Rate" = 9.000%
 * (IGST the same way on an inter-state PO). Rate = the unit price BEFORE tax; Amount = the line total with tax.
 * Totals: the unlabeled row after the items (unlabeled_total_row), named by the OCR after the column above:
 * "Total QTY", "Total Taxable Value", "Total SGST", "Total CGST", "Total Amount".
 *
 * Master (POP TECH, id 37): channel_code = the EAN (8906129575349 -> MCaf371); rate_after_margin = MRP x 0.8 WITH tax
 * (499 -> 399.20 = Rate 338.31 x 1.18). Location: the Ship to pincode (562114 BANGLORE, 122001 GURGOAN).
 *
 * Filled in pop-tech.handler.ts, not here: channel_sku_code + ean (the EAN code's digits), gst (IGST %, else SGST % +
 * CGST %), landing_rate = Rate x (1 + GST %), delivery_pincode (Ship To Address), total_qty / po_value (Total QTY / Total
 * Amount, else the lines' sums), total_line_items, no discount.
 * "" (not on the PO): delivery_facility_code, type_delivery_facility, hsn, appointment_date, po_type, margin, free_qty,
 * pep_sku_code, listing_sku_code, pep_mrp.
 */

export const POP_TECH_HEADER_NAMES: Record<string, string[]> = {
  'PO Number': ['PO Number', 'Purchase Order No', 'Purchase Order Number', 'PO No'],
  'PO Date': ['PO Date', 'Purchase Order Date'],
  'Expiry Date': ['Expiry Date', 'PO Expiry Date'],
  'Delivery Date': ['Delivery Date', 'Expected Delivery Date'],
  'Ship To Address': ['Ship To Address', 'Ship To', 'Shipping Address', 'Delivery Address'],
  'Ship To GSTIN': ['Ship To GSTIN', 'Ship To GST'],
  'Vendor GSTIN': ['Vendor GSTIN', 'Sender GSTIN'],
  'Total QTY': ['Total QTY', 'Total Quantity', 'Total Qty'],
  'Total Amount': ['Total Amount', 'Grand Total', 'Total Value'],
};

export const POP_TECH_LINE_NAMES: Record<string, string[]> = {
  'SI No': ['SI No', 'Sl No', 'S No', 'Sr No'],
  'Product Name': ['Product Name', 'Product', 'Description'],
  'EAN code': ['EAN code', 'EAN'],
  QTY: ['QTY', 'Quantity'],
  Rate: ['Rate', 'Unit Price'],
  MRP: ['MRP'],
  'Taxable Value': ['Taxable Value', 'Taxable'],
  'SGST Rate': ['SGST Rate', 'SGST%'],
  'CGST Rate': ['CGST Rate', 'CGST%'],
  'IGST Rate': ['IGST Rate', 'IGST%'],
  Amount: ['Amount', 'Total', 'Line Total'],
};

export const POP_TECH_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'expiry_date', raw: 'Expiry Date', kind: 'date' },
    { common: 'expected_date', raw: 'Delivery Date', kind: 'date' },
    { common: 'shipping address', raw: 'Ship To Address', kind: 'text' },
    { common: 'delivery_gstin', raw: 'Ship To GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'SI No', kind: 'number' },
    { common: 'description', raw: 'Product Name', kind: 'text' },
    { common: 'qty', raw: 'QTY', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Unit price before tax.
    { common: 'unit_cost', raw: 'Rate', kind: 'number' },
    // The line total with tax.
    { common: 'line_total', raw: 'Amount', kind: 'number' },
  ],
};

/** Total Amount vs the lines: paise per line add up. */
export const POP_TECH_TOTAL_TOLERANCE = 1;
