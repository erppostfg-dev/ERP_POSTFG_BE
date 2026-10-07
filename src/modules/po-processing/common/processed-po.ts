/**
 * processed.json: the common format every channel's raw OCR output is turned into.
 * The field names are the user's common names, kept exactly as given (including "shipping address" and
 * "subject line if email"); names added later come from what the raw OCR output really sends.
 * A field with no data is "" (never null), so every key is always present.
 *
 * Where values come from (the user's rule): the raw OCR JSON is the main source. The email body (and subject)
 * cross-check the fields they also have; a field the raw JSON doesn't have is filled from the body. Every
 * header value's source is in field_sources and every comparison in cross_checks.
 */

/** One comparison of a raw value with the email body or subject. */
export interface CrossCheck {
  field: string;
  against: 'body' | 'subject';
  raw: string | number;
  value: string | number;
  /** match / mismatch, or filled: the raw JSON had no value and the body or subject filled it. */
  result: 'match' | 'mismatch' | 'filled';
}

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
  /** Free units included in qty and not charged (FirstCry: Free Qty); "" for channels with no free quantity. */
  free_qty: Num;
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
  /**
   * The PO value BEFORE any discount (= the sum of the line totals), in every channel (user, 2026-10-07).
   * The discount is cart_discount and the amount payable is net_amount.
   */
  po_value: Num;
  expected_date: string;
  appointment_date: string;
  expiry_date: string;
  delivery_gstin: string;
  vendor_gstin: string;
  /** Discount on the PO. Channels with no discount at all (Zepto, BigBasket): 0, calculated. */
  cart_discount: Num;
  /**
   * Amount payable, after discount. Channels with no discount at all: = po_value, calculated. Channels that do
   * have discounts (Blinkit, FirstCry): only from the raw output; if missing it stays "" with a warning.
   */
  net_amount: Num;
  po_type: string;
  /** The channel says this PO is a revised version of an earlier one (Blinkit: "has been REVISED" in the body). */
  revised: boolean;
  /** For a revised PO stored next to its earlier version (<PO>_2): the earlier version's S3 folder, else "". */
  revision_of: string;

  line_items: ProcessedLine[];
  /** Raw header fields that have no common name yet. */
  unmapped: Record<string, string>;
  /**
   * Where each header value came from: "raw" (OCR output), "raw (from address)", "body", "subject",
   * "calculated", "email" (subject line), "detected" (channel), "s3" (file URLs), or "" when there is no value.
   * Line item values always come from the raw OCR output.
   */
  field_sources: Record<string, string>;
  /** Every raw-vs-body / raw-vs-subject comparison; a mismatch is also a warning. */
  cross_checks: CrossCheck[];
  /** Values that could not be read (e.g. a date in an unknown format, a missing raw field) and cross-check mismatches. */
  warnings: string[];
  processed_at: string;
}

/** Date-valued header fields: written as YYYY-MM-DD. */
export type DateField = 'po_date' | 'expected_date' | 'appointment_date' | 'expiry_date';
