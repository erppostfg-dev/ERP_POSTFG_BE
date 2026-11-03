import { ChannelMapping } from '../../common/apply-mapping';

/*
 * Gluzo: common name <- raw OCR field (EasyEcom PO PDF by Manual Upload, OCR PDF pipeline; 2026-11-02, option B: the PDF
 * alone). Header names = the OCR's header_notes for "gluzo" (channels.json: PO Number, PO Date, Shipping Address, Buyer
 * GSTIN, Vendor GSTIN, Expected Delivery Date, Total Quantity, Item Total, Total Tax Amount, Grand Total); the line names
 * are what the PDF prints (checked on 1974519, 2263773; NOT yet on a real OCR output, so they accept other spellings):
 *   SKU | IMAGE | Company SKU | Product Name | Vendor SKU | EAN/UPC | Product Tax Code | Quantity | Tax Rate | Tax Type
 *   | Base Price | Tax per Item | Unit Total
 * "Unit Total" is the LINE total (qty x (Base Price + Tax per Item)); the lines add up to the Grand Total.
 *
 * Master (GLUZO, id 24): channel_code = Gluzo's SKU (226661 -> MCaf371); rate_after_margin = Base Price + Tax per Item
 * (329.85 + 59.37 = 389.22). Location: the Shipping Address pincode (110092).
 *
 * Filled in gluzo.handler.ts, not here: channel_sku_code (SKU, else Vendor / Company SKU), ean (digits of EAN/UPC: it
 * wraps over two lines), landing_rate = Base Price + Tax per Item, gst = Tax Rate ("18%"), line_total (Unit Total, else
 * qty x landing_rate), line_no (the line's position), delivery_pincode, po_value (Grand Total "₹637495.24*", else the
 * lines' sum), total_qty, total_line_items, no discount.
 * "" (not on the PO): channel_mrp (Gluzo prints no MRP: the MRP check does not run), delivery_facility_code,
 * type_delivery_facility, expiry_date, appointment_date, po_type, margin, free_qty, pep_sku_code, listing_sku_code, pep_mrp.
 */

export const GLUZO_HEADER_NAMES: Record<string, string[]> = {
  'PO Number': ['PO Number', 'Purchase Order', 'PO No'],
  'PO Date': ['PO Date', 'Purchase Order Date'],
  'Expected Delivery Date': ['Expected Delivery Date', 'Delivery Date'],
  'Shipping Address': ['Shipping Address', 'Ship To Address', 'Delivery Address'],
  'Buyer GSTIN': ['Buyer GSTIN', 'GST number', 'GST Number', 'Buyer GST'],
  'Vendor GSTIN': ['Vendor GSTIN', 'Vendor Tax ID'],
  'Total Quantity': ['Total Quantity', 'Total Qty'],
  'Grand Total': ['Grand Total', 'Total Amount', 'Total Value'],
};

export const GLUZO_LINE_NAMES: Record<string, string[]> = {
  SKU: ['SKU', 'Gluzo SKU'],
  'Vendor SKU': ['Vendor SKU', 'Company SKU'],
  'Product Name': ['Product Name', 'Name', 'Description'],
  'EAN/UPC': ['EAN/UPC', 'EAN', 'UPC'],
  'Product Tax Code': ['Product Tax Code', 'HSN', 'HSN Code', 'Tax Code'],
  Quantity: ['Quantity', 'Qty', 'Ordered Quantity'],
  'Tax Rate': ['Tax Rate', 'GST Rate', 'Tax %'],
  'Base Price': ['Base Price', 'Base', 'Price'],
  'Tax per Item': ['Tax per Item', 'Tax Per Unit', 'Tax'],
  'Unit Total': ['Unit Total', 'Total', 'Line Total', 'Total Value'],
};

export const GLUZO_MAPPING: ChannelMapping = {
  header: [
    { common: 'po_number', raw: 'PO Number', kind: 'text' },
    { common: 'po_date', raw: 'PO Date', kind: 'date' },
    { common: 'shipping address', raw: 'Shipping Address', kind: 'text' },
    { common: 'delivery_gstin', raw: 'Buyer GSTIN', kind: 'text' },
    { common: 'vendor_gstin', raw: 'Vendor GSTIN', kind: 'text' },
  ],
  line: [
    { common: 'description', raw: 'Product Name', kind: 'text' },
    { common: 'qty', raw: 'Quantity', kind: 'number' },
    // Unit price before tax.
    { common: 'unit_cost', raw: 'Base Price', kind: 'number' },
  ],
};

/** Grand Total vs the lines: paise per line add up. */
export const GLUZO_TOTAL_TOLERANCE = 1;
