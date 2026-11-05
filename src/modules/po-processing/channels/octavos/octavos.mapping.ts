import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Octavos (Octavos Enterprise Solutions = Smytten): common name <- raw OCR field (its PO PDF by Manual Upload, OCR PDF
 * pipeline; 2026-11-05). Built from the 7 sample PDFs (Downloads/Octovas: OESPL/0000181, OG/00237, OG/00381, OK/000367,
 * OK/000619, RET/210, RET/211; 1-3 lines), NOT yet from a real OCR output, so every field accepts other spellings.
 *
 * Header names = the OCR's header_notes for "octavos" (ocr-service channels.json): PO Number (the "Order No." value as
 * printed, with its slashes, e.g. OG/00381/2026-27), PO Date ("Dated", dd-mm-yyyy), Due Date ("Po Due Date"), Payment
 * Terms, Buyer Name / GSTIN / Address = the company block at the TOP: Octavos' warehouse the goods go to (its address and
 * pincode change per PO: 382427 Ahmedabad, 122503 / 122506 Gurugram, 387570 Haryala), Vendor Name / GSTIN (us), Total
 * Quantity, Taxable Total, IGST / CGST / SGST Total, Rounded Off, Grand Total, Amount In Words.
 * Lines (as printed): S.N. | Description of Goods = the Octavos item code (DMCA001AA191, DHNN005AA104) and under it the
 * name | Qty | Unit | Price (one unit BEFORE tax) | CGST / SGST / IGST Rate + Amount | Amount (the line BEFORE tax).
 * No MRP on the PO.
 *
 * Master (OCTAVOS ENTERPRISE, id 22): channel_code = the Octavos item code; rate_after_margin WITH tax (Smytten Minis
 * Master Sheet1: price before GST x 1.18, loaded 2026-11-05). Location: the top block's pincode (387570 = HARYALA and
 * HARYALA_2: the address decides, location-tiebreak).
 *
 * Filled in octavos.handler.ts: channel_sku_code (Item Code), gst (IGST %, else CGST % + SGST %), landing_rate = Price x
 * (1 + GST %), line_total = the line WITH tax (Amount x (1 + GST %)), delivery_pincode, total_qty (Total Quantity, else
 * the lines' sum), po_value (Grand Total, else Taxable Total + taxes, else the lines' sum), total_line_items, no discount.
 * "" (not on the PO): channel_mrp, ean, expiry_date, delivery_facility_code, appointment_date, po_type, margin, free_qty.
 */

export const OCTAVOS_HEADER_NAMES: Record<string, string[]> = {
  'PO Number': ['PO Number', 'Order No', 'Order Number', 'PO No'],
  'PO Date': ['PO Date', 'Dated', 'Order Date', 'Date'],
  'Due Date': ['Due Date', 'Po Due Date', 'PO Due Date', 'Delivery Date'],
  'Buyer Address': ['Buyer Address', 'Delivery Address', 'Ship To Address', 'Shipping Address', 'Address'],
  'Buyer GSTIN': ['Buyer GSTIN', 'GSTIN'],
  'Vendor GSTIN': ['Vendor GSTIN', 'Party GSTIN', 'GSTIN / UIN', 'GSTIN/UIN'],
  'Total Quantity': ['Total Quantity', 'Total Qty', 'Grand Total Quantity'],
  'Grand Total': ['Grand Total', 'Total Amount', 'Grand Total Amount'],
};

export const OCTAVOS_LINE_NAMES: Record<string, string[]> = {
  'S.N.': ['S.N.', 'SN', 'S No', 'Sr No', 'Sr'],
  'Item Code': ['Item Code', 'SKU Code', 'Code'],
  Description: ['Description', 'Description of Goods', 'Item Name', 'Product Name'],
  Qty: ['Qty', 'Quantity'],
  Price: ['Price', 'Unit Price', 'Rate'],
  'CGST Rate': ['CGST Rate', 'CGST%'],
  'SGST Rate': ['SGST Rate', 'SGST%'],
  'IGST Rate': ['IGST Rate', 'IGST%'],
  Amount: ['Amount', 'Taxable Amount', 'Line Amount', 'Amount (Rs)'],
};

export const OCTAVOS_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'expected_date', raw: 'Due Date', kind: 'date' },
    { common: 'shipping address', raw: 'Buyer Address', kind: 'text' },
    { common: 'delivery_gstin', raw: 'Buyer GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'S.N.', kind: 'number' },
    { common: 'description', raw: 'Description', kind: 'text' },
    { common: 'qty', raw: 'Qty', kind: 'number' },
    // Unit price before tax.
    { common: 'unit_cost', raw: 'Price', kind: 'number' },
  ],
};

/** Grand Total vs the lines: paise per line + the PO's "Rounded Off" (up to a rupee). */
export const OCTAVOS_TOTAL_TOLERANCE = 2;
