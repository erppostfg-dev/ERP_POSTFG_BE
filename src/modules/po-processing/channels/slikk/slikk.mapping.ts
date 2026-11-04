import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Slikk (Sliksync Technologies): common name <- raw OCR field (Manual Upload; 2026-11-02). PDF + sheet together only
 * (user: the PDF alone is not taken): OCR "slikk" = header from the PDF (header_notes names), lines from the sheet
 * (orderItems ....csv or Pep SLIKPO#<n>.xlsx; Python, the sheet's own column names). Checked on 5 POs (SLIKPO#550, 679,
 * 761, 1381, 2064; PosFromEmail/Slikk/PO-1..5). The names the PDF's own table prints are accepted too (SLIKK_*_NAMES,
 * compared without case / spaces / punctuation), so a line read from the PDF would still map.
 *
 * Sheet columns: Order | Product Name | SKU Id | Vendor Sku | HSN Code | MRP | Expected Selling price(/per pc) | Allocate
 * qty | Expected GST rate on final sale | Higher GST rate on final sale | Threshold Price% | Discount /Commission% | Total
 * Purchase Price | Purchase price/pu | (Discount/Commission / per pc) | Total GST Value | Total Purchase Price with GST |
 * (Pending Quantity). PDF columns: S.No | Product Name | SKU | HSN | MRP | SP | Qty | Purchase Price | Item Value | Total
 * Tax | Total Amount.
 *
 * "SKU Id" = SKU = our pep code for most items, the EAN (= SLIKK channel_code) for some mCaffeine ones; Vendor Sku is the
 * same value. Validation looks it up as a channel code, then a pep code, then an ean_code (SKU_ANY_CODE). Price: Slikk pays its
 * selling price less 25% commission, plus GST: the line's price with tax = Total Purchase Price with GST / qty, compared
 * with our rate_after_margin (the price check decides a mismatch).
 */

export const SLIKK_HEADER_NAMES: Record<string, string[]> = {
  'PO Number': ['PO Number', 'PO#', 'PO No'],
  'PO Date': ['PO Date', 'Order Date'],
  'PO Expiry Date': ['PO Expiry Date', 'PO Expiry'],
  'Shipped To Address': ['Shipped To Address', 'Shipped To', 'Ship To Address'],
  'Billed To GSTIN': ['Billed To GSTIN', 'Buyer GSTIN'],
  'Billed By GSTIN': ['Billed By GSTIN', 'Vendor GSTIN', 'Supplier GSTIN'],
  'Total Quantity': ['Total Quantity', 'Total Qty'],
  'Total Amount': ['Total Amount', 'Grand Total'],
};

export const SLIKK_LINE_NAMES: Record<string, string[]> = {
  Order: ['Order', 'PO', 'PO Number'],
  'S.No': ['S.No', 'S No', 'Sr No', 'Serial No'],
  SKU: ['SKU Id', 'SKU', 'SKU ID', 'Vendor Sku'],
  'Product Name': ['Product Name', 'Name', 'Description'],
  HSN: ['HSN Code', 'HSN'],
  MRP: ['MRP'],
  Qty: ['Allocate qty', 'Qty', 'Quantity', 'Allocated Qty'],
  /** Unit price before tax. */
  'Unit Price': ['Purchase price/pu', 'Purchase Price', 'Purchase Price Per Unit'],
  /** The line before tax. */
  Taxable: ['Total Purchase Price', 'Item Value', 'Taxable Value'],
  Tax: ['Total GST Value', 'Total Tax', 'Tax Amount'],
  /** The line with tax. */
  'Line Total': ['Total Purchase Price with GST', 'Total Amount', 'Line Total'],
  'GST %': ['Expected GST rate on final sale', 'GST Rate', 'GST %', 'Tax Rate'],
};

export const SLIKK_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'expiry_date', raw: 'PO Expiry Date', kind: 'date' },
    { common: 'shipping address', raw: 'Shipped To Address', kind: 'text' },
    { common: 'delivery_gstin', raw: 'Billed To GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Billed By GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'description', raw: 'Product Name', kind: 'text' },
    { common: 'qty', raw: 'Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    { common: 'unit_cost', raw: 'Unit Price', kind: 'number' },
  ],
};

/** The PDF's totals vs the lines: paise per line add up. */
export const SLIKK_TOTAL_TOLERANCE = 1;
