import { PoWarning, poWarning, WARNING_CODES } from '../../../constants';
import { ProcessedLine, ProcessedPo } from './processed-po';
import { text, toDate, toNumber } from './parse';

/*
 * A channel's mapping is data: "common name <- raw OCR field, read as text / number / date".
 * These helpers apply it and collect what was used, so the rest can be kept under `unmapped`.
 */

export type FieldKind = 'text' | 'number' | 'date';

/** Header fields a mapping can fill (the ones from our side, line items and bookkeeping are set elsewhere). */
export type HeaderKey = Exclude<
  keyof ProcessedPo,
  | 'subject line if email'
  | 'channel_name'
  | 'input_type'
  | 'ref_file_urls'
  | 'revised'
  | 'revision_of'
  | 'line_items'
  | 'unmapped'
  | 'field_sources'
  | 'cross_checks'
  | 'warnings'
  | 'processed_at'
  | 'needs_review'
  | 'review_reasons'
  | 'missing_fields'
>;
export type LineKey = Exclude<keyof ProcessedLine, 'unmapped'>;

export interface FieldMap<K extends string> {
  common: K;
  /** The raw field name, or several names when the OCR names it differently from PO to PO (first found wins). */
  raw: string | string[];
  kind: FieldKind;
}

export interface ChannelMapping {
  /** Header fields read from the raw header (and totals). */
  header: FieldMap<HeaderKey>[];
  /**
   * Header fields read from the first line item, for channels whose line table repeats the PO details on every
   * line (Zepto's CSV: PoNumber, PoDate, StoreName, ...). Those columns are then left out of each line's unmapped.
   */
  headerFromLine?: FieldMap<HeaderKey>[];
  line: FieldMap<LineKey>[];
}

/** A processed PO with every key present and empty ("" / []), ready to be filled. */
export const emptyPo = (): ProcessedPo => ({
  'subject line if email': '',
  channel_name: '',
  input_type: '',
  ref_file_urls: [],
  po_number: '',
  po_date: '',
  type_delivery_facility: '',
  delivery_facility_code: '',
  'shipping address': '',
  delivery_pincode: '',
  total_line_items: '',
  total_qty: '',
  po_value: '',
  expected_date: '',
  appointment_date: '',
  expiry_date: '',
  delivery_gstin: '',
  vendor_gstin: '',
  cart_discount: '',
  net_amount: '',
  po_type: '',
  revised: false,
  revision_of: '',
  line_items: [],
  unmapped: {},
  field_sources: {},
  cross_checks: [],
  warnings: [],
  processed_at: '',
});

export const emptyLine = (): ProcessedLine => ({
  line_no: '',
  pep_sku_code: '',
  listing_sku_code: '',
  channel_sku_code: '',
  ean: '',
  description: '',
  qty: '',
  free_qty: '',
  pep_mrp: '',
  channel_mrp: '',
  landing_rate: '',
  unit_cost: '',
  line_total: '',
  margin: '',
  hsn: '',
  gst: '',
  unmapped: {},
});

/** The raw key for a mapped name (or the first of several names found), matched ignoring case and extra spaces. */
export const findKey = (values: Record<string, string>, raw: string | string[]): string | undefined => {
  for (const name of Array.isArray(raw) ? raw : [raw]) {
    const want = name.trim().toLowerCase();
    const key = Object.keys(values).find((k) => k.trim().toLowerCase() === want);
    if (key !== undefined) return key;
  }
  return undefined;
};

const rawLabel = (raw: string | string[]): string => (Array.isArray(raw) ? raw.map((r) => `"${r}"`).join(' / ') : `"${raw}"`);

const read = (kind: FieldKind, value: string, label: string, warnings: PoWarning[]): string | number => {
  if (kind === 'number') return toNumber(value, label, warnings);
  if (kind === 'date') return toDate(value, label, warnings);
  return text(value);
};

/**
 * Fills `target` from `values` with the mapping. Returns the raw keys that were used.
 * A mapped raw field that is missing adds one warning (`where` says header or which line).
 */
export const applyMapping = <K extends string>(
  target: Record<K, unknown>,
  values: Record<string, string>,
  maps: FieldMap<K>[],
  warnings: PoWarning[],
  where: string,
): Set<string> => {
  const used = new Set<string>();
  for (const m of maps) {
    const key = findKey(values, m.raw);
    if (key === undefined) {
      warnings.push(poWarning(WARNING_CODES.RAW_FIELD_MISSING, where, rawLabel(m.raw), m.common));
      continue;
    }
    used.add(key);
    target[m.common] = read(m.kind, values[key], `${where} ${m.common}`, warnings);
  }
  return used;
};

/** Records "raw" as the source of every mapped header field that got a value. */
export const markRawSources = (po: ProcessedPo, maps: FieldMap<HeaderKey>[]): void => {
  for (const m of maps) if (po[m.common] !== '') po.field_sources[m.common] = 'raw';
};

/** The raw fields that no mapping used (kept so nothing from the OCR is lost). */
export const leftover = (values: Record<string, string>, used: Set<string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).filter(([k]) => !used.has(k)).map(([k, v]) => [k, text(v)]));
