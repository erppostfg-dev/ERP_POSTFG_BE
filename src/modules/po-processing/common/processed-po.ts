/**
 * processed.json: the common format every channel's raw OCR output is turned into.
 * The field names are the user's common names, kept exactly as given (including "shipping address" and
 * "subject line if email"); names added later come from what the raw OCR output really sends.
 * A field with no data is "" (never null), so every key is always present.
 */

/** A value read from the raw output: the parsed number, or "" when the channel doesn't send it. */
export type Num = number | '';

export interface ProcessedLine {
  line_no: Num;
  /** Our SKU code; filled from the DB mapping later. */
  pep_sku_code: string;
  /** Filled from the DB mapping later. */
  listing_sku_code: string;
  channel_sku_code: string;
  /** Barcode (EAN / UPC); fallback for SKU matching. */
  ean: string;
  description: string;
  qty: Num;
  /** Our MRP; filled from the DB later and compared with channel_mrp. */
  pep_mrp: Num;
  /** The MRP printed on the channel's PO. */
  channel_mrp: Num;
  /** Unit price the channel pays, including tax. */
  landing_rate: Num;
  /** Unit price before tax. */
  unit_cost: Num;
  line_total: Num;
  margin: Num;
  hsn: string;
  /** One GST rate per line, e.g. 18 (CGST % + SGST %, or IGST %). */
  gst: Num;
  /** Raw columns of this line that have no common name yet (nothing from the OCR is lost). */
  unmapped: Record<string, string>;
}

export interface ProcessedPo {
  'subject line if email': string;
  channel_name: string;
  /** Files the OCR used: "pdf", "sheet" or "pdf+sheet". */
  input_type: string;
  /** S3 paths of the PO files and the raw OCR output. */
  ref_file_urls: string[];

  po_number: string;
  po_date: string;
  /** The channel's own facility type when its OCR output has one; otherwise "". */
  type_delivery_facility: string;
  /** Facility name; the key for matching the delivery location (DB step, later). */
  delivery_facility_code: string;
  'shipping address': string;
  delivery_pincode: string;
  total_line_items: Num;
  total_qty: Num;
  po_value: Num;
  expected_date: string;
  appointment_date: string;
  expiry_date: string;
  delivery_gstin: string;
  vendor_gstin: string;
  cart_discount: Num;
  net_amount: Num;
  po_type: string;

  line_items: ProcessedLine[];
  /** Raw header fields that have no common name yet. */
  unmapped: Record<string, string>;
  /** Values that could not be read (e.g. a date in an unknown format, a missing raw field). */
  warnings: string[];
  processed_at: string;
}

/** Date-valued header fields: written as YYYY-MM-DD. */
export type DateField = 'po_date' | 'expected_date' | 'appointment_date' | 'expiry_date';
