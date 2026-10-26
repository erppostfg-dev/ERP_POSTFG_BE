import fs from 'fs/promises';
import { Cell, Frame, pyStrip } from './frame';

/*
 * Reading the input CSVs the way pandas read_csv(dtype=str) does (intransit-service/intransit/io.py), so every
 * stage sees the same cells as the Python pipeline:
 *   - UTF-8 (a BOM is skipped), else cp1252 (Sheet35(2) and Shipment_Status come in cp1252);
 *   - fully blank or whitespace-only lines are skipped; a line of only commas is a row of NaN;
 *   - the default NA strings ('', 'NA', 'null', 'nan' ...) become NaN (null), compared exactly (' NA ' stays text);
 *   - repeated header names become 'X.1', 'X.2'; a blank header is 'Unnamed: <position>';
 *   - a short row is padded with NaN; a row with more cells than the header is an error.
 */

/** pandas' default na_values. */
const NA_VALUES = new Set([
  '', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN',
  'None', 'n/a', 'nan', 'null',
]);
const BOM = '﻿';

/** UTF-8 if the bytes are valid UTF-8, else cp1252 (read_csv's fallback in io.py). */
export const decodeText = (raw: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(raw);
  }
};

/** CSV lines as raw text cells, blank lines skipped. `sep` is ',' or '\t'. */
export const tokenizeCsv = (text: string, sep = ','): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false; // inside "..."
  let wasQuoted = false; // the current cell had quotes
  let lineHasContent = false; // any non-whitespace character on this line (outside a quoted cell too)

  const endCell = (): void => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endLine = (): void => {
    endCell();
    if (lineHasContent) rows.push(row);
    row = [];
    lineHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      wasQuoted = true;
      lineHasContent = true;
    } else if (c === sep) {
      endCell();
      lineHasContent = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endLine();
    } else {
      cell += c;
      if (c !== ' ' && c !== '\t') lineHasContent = true;
    }
  }
  if (cell !== '' || row.length || wasQuoted) endLine();
  return rows;
};

/** Header names as pandas makes them: blanks become 'Unnamed: i', repeats get '.1', '.2' ... */
const headerNames = (raw: string[]): string[] => {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  return raw.map((h, i) => {
    let name = h === '' ? `Unnamed: ${i}` : h;
    if (used.has(name)) {
      let n = seen.get(name) ?? 0;
      let candidate: string;
      do candidate = `${name}.${++n}`;
      while (used.has(candidate));
      seen.set(name, n);
      name = candidate;
    }
    used.add(name);
    return name;
  });
};

/** Parse CSV text as read_csv(dtype=str): every cell text or NaN (null). */
export const parseCsvFrame = (text: string, label = 'csv', sep = ','): Frame => {
  const rows = tokenizeCsv(text, sep);
  if (!rows.length) return Frame.empty();
  const header = headerNames(rows[0]);
  const width = header.length;
  const data: Cell[][] = header.map(() => new Array<Cell>(rows.length - 1));
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length > width) throw new Error(`${label}: line ${r + 1} has ${cells.length} cells, the header has ${width}`);
    for (let j = 0; j < width; j++) {
      const v = cells[j];
      data[j][r - 1] = v === undefined || NA_VALUES.has(v) ? null : v;
    }
  }
  return Frame.of(header, data, rows.length - 1);
};

/** read_csv(path, dtype=str) with the cp1252 fallback. */
export const readCsv = async (file: string): Promise<Frame> => parseCsvFrame(decodeText(await fs.readFile(file)), file);

/** io.clean_cols: header names trimmed, a stray BOM removed. */
export const cleanCols = (df: Frame): Frame =>
  df.rename(Object.fromEntries(df.columns.map((c) => [c, pyStrip(c).replace(new RegExp(`^${BOM}+`), '')])));

/** df.columns.str.strip() */
export const stripCols = (df: Frame): Frame => df.rename(Object.fromEntries(df.columns.map((c) => [c, pyStrip(c)])));
