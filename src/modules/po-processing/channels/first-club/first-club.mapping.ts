import { ChannelMapping } from '../../common/apply-mapping';

/*
 * First Club (Firstclub Technology): common name <- raw OCR field (its PO PDF by Manual Upload, OCR PDF pipeline;
 * 2026-11-05). Built from the 8 sample PDFs (Downloads/First club: PO-145174 ... PO-210392, 3 to 32 lines), NOT yet from
 * a real OCR output, so every field accepts the other names the OCR may use (compared without case, spaces or punctuation).
 *
 * Header names = the OCR's header_notes for "first_club" (ocr-service channels.json): PO Number (the "PO No:" value, e.g.
 * PO-199751-FRHHYDMDL01 = number + First Club's warehouse code: the same on all 8 samples; the top "Purchase Order No."
 * prints it over two lines), PO Date, PO Release Date, Expected Delivery Date, PO Expiry Date, Payment Terms, Status,
 * Vendor Name / GSTIN, Billing Name / GSTIN / Address, Shipping Name / GSTIN / Address, Total Amount, Grand Total.
 * Lines (as printed): Sr. | Item Description | SKU Code | HSN | COO | Qty | MRP | Unit Cost | Taxable Value | CGST | SGST |
 * IGST | CESS | Total; each tax cell prints amount and rate ("2447.97 (18.00%)"), returned (or split by the OCR's
 * split_value_rate_cells) as "IGST" = 2447.97 and "IGST Rate" = 18.00%. Unit Cost = the price of one unit BEFORE tax;
 * Total = the line total with tax.
 *
 * Master (FIRST CLUB, id 41): channel_code = First Club's SKU Code (SKU263395210); rate_after_margin WITH tax
 * (Unit Cost 226.55 x 1.18 = 267.33, margin 0.33). Location: the Shipping Address pincode (562123 BENGALURU, 500078
 * HYDERABAD). A code on rows of several of our codes: the item description decides (SKU_NAME_TIEBREAK).
 *
 * Filled in first-club.handler.ts, not here: channel_sku_code (SKU Code without spaces), gst (IGST %, else CGST % +
 * SGST %), landing_rate = Unit Cost x (1 + GST %), delivery_pincode (Shipping Address), total_qty (the lines' sum: no
 * total quantity is printed), po_value (Grand Total, else Total Amount, else the lines' sum), total_line_items, no discount.
 * "" (not on the PO): delivery_facility_code, type_delivery_facility, ean, appointment_date, po_type, margin, free_qty,
 * pep_sku_code, listing_sku_code, pep_mrp.
 */

export const FIRST_CLUB_HEADER_NAMES: Record<string, string[]> = {
  'PO Number': ['PO Number', 'PO No', 'Purchase Order No', 'Purchase Order Number'],
  'PO Date': ['PO Date', 'Date'],
  'Expected Delivery Date': ['Expected Delivery Date', 'Delivery Date'],
  'PO Expiry Date': ['PO Expiry Date', 'Expiry Date'],
  'Shipping Address': ['Shipping Address', 'Ship To Address', 'Delivery Address'],
  'Shipping GSTIN': ['Shipping GSTIN', 'Shipping Buyer GST', 'Ship To GSTIN'],
  'Vendor GSTIN': ['Vendor GSTIN', 'GSTIN'],
  'Total Amount': ['Total Amount', 'Total Amount (INR)'],
  'Grand Total': ['Grand Total', 'Grand Total (INR)'],
};

export const FIRST_CLUB_LINE_NAMES: Record<string, string[]> = {
  Sr: ['Sr', 'Sr No', 'S No', 'Sl No'],
  'Item Description': ['Item Description', 'Description', 'Product Name', 'Item'],
  'SKU Code': ['SKU Code', 'SKU'],
  HSN: ['HSN', 'HSN Code', 'HSN/SAC'],
  Qty: ['Qty', 'Quantity'],
  MRP: ['MRP'],
  'Unit Cost': ['Unit Cost', 'Unit Price', 'Rate'],
  'Taxable Value': ['Taxable Value', 'Taxable'],
  'CGST Rate': ['CGST Rate', 'CGST%'],
  'SGST Rate': ['SGST Rate', 'SGST%'],
  'IGST Rate': ['IGST Rate', 'IGST%'],
  Total: ['Total', 'Line Total', 'Amount'],
};

export const FIRST_CLUB_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'expected_date', raw: 'Expected Delivery Date', kind: 'date' },
    { common: 'expiry_date', raw: 'PO Expiry Date', kind: 'date' },
    { common: 'shipping address', raw: 'Shipping Address', kind: 'text' },
    { common: 'delivery_gstin', raw: 'Shipping GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'Sr', kind: 'number' },
    { common: 'description', raw: 'Item Description', kind: 'text' },
    { common: 'hsn', raw: 'HSN', kind: 'text' },
    { common: 'qty', raw: 'Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Unit price before tax.
    { common: 'unit_cost', raw: 'Unit Cost', kind: 'number' },
    // The line total with tax.
    { common: 'line_total', raw: 'Total', kind: 'number' },
  ],
};

/** Grand Total vs the lines: paise per line add up. */
export const FIRST_CLUB_TOTAL_TOLERANCE = 1;
