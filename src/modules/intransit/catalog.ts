import { unzipSync } from 'fflate';
import { HEADER_SCAN_BYTES, INPUT_BY_NAME, INTRANSIT_TEMPLATE_NAME } from '../../constants';
import { pyStrip } from './frame';
import { decodeText, tokenizeCsv } from './io';

/*
 * Checks an input file before it is saved (input_catalog.py validate): a file missing a column a stage reads is
 * refused at upload, not halfway through a run.
 */

/** First row of a CSV, cleaned the way the stages clean column names. */
export const headerOf = (raw: Uint8Array): string[] => {
  const head = raw.subarray(0, HEADER_SCAN_BYTES);
  const [first = []] = tokenizeCsv(decodeText(head));
  return first.map((c) => pyStrip(c).replace(/^﻿+/, ''));
};

/** Problems with an uploaded file (empty list = fine). `name` must be a catalog name. */
export const validateInput = (name: string, raw: Uint8Array): string[] => {
  const spec = INPUT_BY_NAME.get(name);
  if (!spec) return [`${name} is not an input of the report`];
  if (!raw.length) return ['the file is empty'];
  const isZip = raw[0] === 0x50 && raw[1] === 0x4b;
  if (name === INTRANSIT_TEMPLATE_NAME) {
    if (!isZip) return ['not an Excel workbook (.xlsx)'];
    try {
      return 'xl/workbook.xml' in unzipSync(raw, { filter: (f) => f.name === 'xl/workbook.xml' }) ? [] : ['not an Excel workbook (.xlsx)'];
    } catch {
      return ['not an Excel workbook (.xlsx)'];
    }
  }
  if (isZip) return ['this is an Excel file - save it as CSV first'];
  const header = headerOf(raw);
  if (!header.some(Boolean)) return ['no header row found'];
  const problems: string[] = [];
  const missing = spec.required.filter((c) => !header.includes(c));
  if (missing.length) problems.push(`missing columns: ${missing.join(', ')}`);
  for (const options of spec.oneOf ?? []) if (!options.some((c) => header.includes(c))) problems.push(`needs one of: ${options.join(' / ')}`);
  return problems;
};

/**
 * The catalog name a dropped file belongs to, matched loosely (inputs.html key()): case, punctuation and the
 * " (1)" a browser adds to a repeated download are ignored. Undefined when nothing matches.
 */
export const matchInputName = (fileName: string): string | undefined => {
  const key = (n: string): string => n.toLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/, '').replace(/\.(csv|xlsx)$/, '').replace(/[^a-z0-9]/g, '');
  const k = key(fileName);
  for (const name of INPUT_BY_NAME.keys()) if (key(name) === k) return name;
  return undefined;
};
