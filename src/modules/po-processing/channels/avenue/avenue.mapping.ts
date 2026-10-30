import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Avenue E-Commerce (DMart): common name <- raw OCR field (PDF only, by Manual Upload; 2026-10-30).
 * Built from the PDF text of PO 4502349805 (16.09.2026, IFC Kukse Bhiwandi) and the user's earlier field list
 * (Documents/POs/Mappings/DMart_Ready.tsv). NOT yet checked against a real OCR output of Avenue: the OCR's field
 * names are taken from what the PDF prints and the OCR's header_notes (ocr-service channels.json "avenue"), so every
 * field accepts the names the OCR may use (AVENUE_HEADER_NAMES / AVENUE_LINE_NAMES, compared without case, spaces or
 * punctuation). Check the first real run and narrow these down.
 *
 * Each line is printed on two rows: row 1 = Sr, EAN, HSN (first part), Description (first part), UOM, PO Qty, MRP,
 * Basic Price, CGST% / SGST% / CESS% / IGST% / UGST%, Landed Price, Total Value; row 2 = Article No, the rest of HSN and
 * Description, Clot (case lot), the tax amounts CGST V ... UGST V. The OCR may give a stacked cell ("EAN/Article No":
 * "8906171510275 / 140007264"): the handler takes the 13-digit EAN and the Article No from the digits.
 *
 * Master: master_channel_skus.channel_code = the Article No (140007268 -> HYPMUBX038F050); rate_after_margin = the
 * Landed Price (with tax). Location: no site code on the PO -> the Ship To pincode (CHANNEL_LOCATION_MATCH).
 *
 * Filled in avenue.handler.ts, not here: channel_sku_code / ean from the EAN/Article cell, hsn (both rows joined),
 * gst (IGST % when charged, else CGST % + SGST % + UGST %), delivery_pincode (Ship To), expiry_date (end of PO
 * Validity "16.09.2026 to 31.10.2026"), total_qty / po_value (the Total row, else the sum of the lines), total_line_items,
 * cart_discount 0 / net_amount = po_value (no discount on Avenue POs).
 * "" (not on the PO): delivery_facility_code, type_delivery_facility, expected_date, appointment_date, po_type, margin,
 * free_qty and the DB-later fields pep_sku_code, listing_sku_code, pep_mrp.
 */

/** Our name for each raw field -> the names the OCR may give it. */
export const AVENUE_HEADER_NAMES: Record<string, string[]> = {
  'PO Number': ['PO Number', 'Purchase Order', 'Purchase Order No', 'Purchase Order Number', 'PO No'],
  'Purchase Order Date': ['Purchase Order Date', 'PO Date'],
  'PO Validity': ['PO Validity', 'Validity'],
  'Ship To': ['Ship To', 'Ship To Address', 'Shipping Address', 'Delivery Address'],
  'Ship To GSTIN': ['Ship To GSTIN', 'Ship To GST', 'Ship To GST #'],
  'Vendor GSTIN': ['Vendor GSTIN', 'Vendor GST', 'Vendor GST #'],
  'Total Qty': ['Total Qty', 'Total PO Qty', 'Total Quantity', 'Total PO Quantity'],
  // not a bare "Total": the PO's Total row holds the qty and the value side by side
  'Total Value': ['Total Value', 'Total Amount', 'Grand Total', 'Total PO Value'],
};

export const AVENUE_LINE_NAMES: Record<string, string[]> = {
  'Sr No': ['Sr No', 'Sr', 'S No', 'Sr Number', 'Serial No'],
  'EAN/Article No': ['EAN/Article No', 'EAN Article No', 'EAN/Article', 'EAN/Article Number'],
  EAN: ['EAN', 'EAN No', 'EAN Code'],
  'Article No': ['Article No', 'Article', 'Article Number', 'Article Code'],
  'HSN Code': ['HSN Code', 'HSN'],
  Description: ['Description', 'Item Description', 'Product Description'],
  'PO Qty': ['PO Qty', 'Qty', 'Quantity', 'PO Quantity'],
  MRP: ['MRP'],
  'Basic Price': ['Basic Price', 'Basic', 'Basic Cost'],
  'Landed Price': ['Landed Price', 'Landed', 'Landed Cost'],
  'Total Value': ['Total Value', 'Total', 'Line Total', 'Value'],
  'CGST%': ['CGST%', 'CGST Rate', 'CGST Percent'],
  'SGST%': ['SGST%', 'SGST Rate', 'SGST Percent'],
  'UGST%': ['UGST%', 'UGST Rate', 'UGST Percent'],
  'IGST%': ['IGST%', 'IGST Rate', 'IGST Percent'],
};

export const AVENUE_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'Purchase Order Date', kind: 'date' },
    { common: 'shipping address', raw: 'Ship To', kind: 'text' },
    { common: 'delivery_gstin', raw: 'Ship To GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'line_no', raw: 'Sr No', kind: 'number' },
    { common: 'description', raw: 'Description', kind: 'text' },
    { common: 'qty', raw: 'PO Qty', kind: 'number' },
    { common: 'channel_mrp', raw: 'MRP', kind: 'number' },
    // Unit price before tax.
    { common: 'unit_cost', raw: 'Basic Price', kind: 'number' },
    // Unit price with tax = our rate_after_margin.
    { common: 'landing_rate', raw: 'Landed Price', kind: 'number' },
    { common: 'line_total', raw: 'Total Value', kind: 'number' },
  ],
};

/** Totals row of the PO vs the lines: paise per line add up. */
export const AVENUE_TOTAL_TOLERANCE = 1;
