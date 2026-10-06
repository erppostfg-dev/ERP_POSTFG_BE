import { findKey } from './apply-mapping';
import { toNumber } from './parse';
import { Num } from './processed-po';

/** A channel's raw column names for the GST rates of a line. */
export interface GstColumns {
  cgst: string;
  sgst: string;
  igst: string;
}

/**
 * One GST rate for a line (the user's rule: one rate, e.g. 18): IGST % when charged (delivery in another state),
 * otherwise CGST % + SGST % (same state). The columns used are added to `used`, so they don't show as unmapped.
 */
export const gstRate = (
  raw: Record<string, string>,
  cols: GstColumns,
  used: Set<string>,
  where: string,
  warnings: string[],
): Num => {
  const keys = { cgst: findKey(raw, cols.cgst), sgst: findKey(raw, cols.sgst), igst: findKey(raw, cols.igst) };
  const missing = (Object.keys(keys) as (keyof GstColumns)[]).filter((k) => keys[k] === undefined).map((k) => `"${cols[k]}"`);
  if (missing.length) {
    warnings.push(`${where}: GST columns ${missing.join(', ')} are not in the OCR output`);
    return '';
  }
  Object.values(keys).forEach((k) => used.add(k as string));
  const igst = toNumber(raw[keys.igst as string], `${where} ${cols.igst}`, warnings);
  if (typeof igst === 'number' && igst > 0) return igst;
  const cgst = toNumber(raw[keys.cgst as string], `${where} ${cols.cgst}`, warnings);
  const sgst = toNumber(raw[keys.sgst as string], `${where} ${cols.sgst}`, warnings);
  return typeof cgst === 'number' && typeof sgst === 'number' ? cgst + sgst : '';
};
