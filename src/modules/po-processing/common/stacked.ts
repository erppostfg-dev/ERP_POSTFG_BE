/*
 * Stacked cells: some PDFs print several fields in one table cell, one under the other (Reliance:
 * "Article No. / HSN Code", "EAN No. / Vendor Article No. / Vendor Item No / Vendor Article Name").
 * The OCR keeps them apart with " / " in both the column name and the value (ocr-service join_cell_lines).
 */

export const STACK_SEPARATOR = ' / ';

/**
 * One raw line with every stacked column split into its own fields:
 *   {"Article No. / HSN Code": "493711050 / 33049990"} -> {"Article No.": "493711050", "HSN Code": "33049990"}
 * A field with no value on this line (e.g. no Vendor Article No) is left out. Other columns are kept as they are.
 */
export const unstack = (values: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.includes(STACK_SEPARATOR)) {
      out[key] = value;
      continue;
    }
    const names = key.split(STACK_SEPARATOR).map((n) => n.trim());
    const parts = (value ?? '').split(STACK_SEPARATOR).map((p) => p.trim());
    names.forEach((name, i) => {
      // more values than names: the extra ones belong to the last field
      const v = i === names.length - 1 ? parts.slice(i).join(STACK_SEPARATOR) : parts[i] ?? '';
      if (v) out[name] = v;
    });
  }
  return out;
};
