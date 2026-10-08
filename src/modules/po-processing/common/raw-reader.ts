import fs from 'fs/promises';
import path from 'path';
import { ERROR_CODES, FILES } from '../../../constants';
import { appError } from '../../../utils/AppError';

/*
 * Reads a PO's raw OCR output into plain field/value maps, the same for every channel.
 * Two raw formats, both with the same field names (so a channel's mapping works on either):
 *
 * 1. Raw JSON, the OCR team's format (their po-results/<channel>/*.json; what the queue will deliver):
 *      { channel, input, pdf, sheet, header: {field: value}, totals: {field: value},
 *        line_item_columns: [...], line_items: [{column: value}], warnings: [...] }
 *    Used when one of RAW_JSON_FILES in the PO folder has this shape.
 * 2. Otherwise the OCR's ocr-output.csv (from our own dev OCR runs):
 *      Field,Value,Confidence ...      <- header fields and totals, one per row
 *      (blank line)
 *      #,Item Code,HSN Code,...         <- the line-item table: a header row, then one row per line
 */

export const RAW_OUTPUT_FILE = FILES.OCR_OUTPUT_CSV;
export const RAW_RESULT_FILE = FILES.OCR_OUTPUT_RESULT;
/**
 * Where the raw JSON may be, first match wins. The final file name is still to be agreed with the OCR team
 * (ocr-result.json is also the name of our own dev OCR summary, which has another shape and is skipped).
 */
export const RAW_JSON_FILES = [FILES.OCR_RAW_JSON, FILES.OCR_RESULT];

/** The OCR team's raw JSON (see above). */
interface RawJson {
  input?: string;
  pdf?: string | null;
  sheet?: string | null;
  header: Record<string, unknown>;
  totals?: Record<string, unknown>;
  line_item_columns?: string[];
  line_items: Record<string, unknown>[];
}

const isRawJson = (v: unknown): v is RawJson => {
  const o = v as RawJson;
  return !!o && typeof o.header === 'object' && !Array.isArray(o.header) && Array.isArray(o.line_items);
};

const asText = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const asTextMap = (o: Record<string, unknown> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, asText(v)]));

/** The raw JSON in the PO folder and its file name, or undefined. */
const findRawJson = async (folder: string): Promise<{ file: string; json: RawJson } | undefined> => {
  for (const file of RAW_JSON_FILES) {
    try {
      const json: unknown = JSON.parse(await fs.readFile(path.join(folder, file), 'utf8'));
      if (isRawJson(json)) return { file, json };
    } catch {
      // missing or not JSON: try the next name
    }
  }
  return undefined;
};

export interface RawOcr {
  /** Header field name (as the OCR wrote it) -> value. */
  header: Record<string, string>;
  /** One map per line item: column name -> value. */
  lines: Record<string, string>[];
  /** Line-item column names, in order. */
  lineColumns: string[];
  /** "pdf", "sheet" or "pdf+sheet", from the OCR's run summary. */
  inputType: string;
  /** File names (in the PO folder) the OCR read: the pdf and/or the sheet. */
  inputFiles: string[];
  /** The raw output file that was read (raw JSON or ocr-output.csv). */
  sourceFile: string;
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
const parseCsv = (content: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

const isBlank = (row: string[]): boolean => row.every((c) => c.trim() === '');

/** True when the PO folder has a raw OCR output to process (raw JSON or ocr-output.csv). */
export const hasRawOutput = async (folder: string): Promise<boolean> =>
  !!(await findRawJson(folder)) ||
  fs.access(path.join(folder, RAW_OUTPUT_FILE)).then(
    () => true,
    () => false,
  );

export const readRawOcr = async (folder: string): Promise<RawOcr> => {
  const found = await findRawJson(folder);
  if (found) {
    const { json, file } = found;
    return {
      // Totals (Total Quantity, Total Amount, ...) are mapped like header fields, as in the CSV.
      header: { ...asTextMap(json.header), ...asTextMap(json.totals) },
      lines: json.line_items.map((l) => asTextMap(l)),
      lineColumns: json.line_item_columns ?? Object.keys(json.line_items[0] ?? {}),
      inputType: json.input ?? '',
      inputFiles: [json.pdf, json.sheet].filter((f): f is string => !!f).map((f) => path.basename(f)),
      sourceFile: file,
    };
  }
  return readRawCsv(folder);
};

const readRawCsv = async (folder: string): Promise<RawOcr> => {
  const rows = parseCsv((await fs.readFile(path.join(folder, RAW_OUTPUT_FILE), 'utf8')).replace(/^﻿/, ''));

  // Header block: from the "Field,Value,..." row to the first blank row.
  const header: Record<string, string> = {};
  let i = rows.findIndex((r) => r[0]?.trim() === 'Field');
  if (i < 0) throw appError(ERROR_CODES.RAW_OUTPUT_INVALID, RAW_OUTPUT_FILE);
  for (i++; i < rows.length && !isBlank(rows[i]); i++) {
    const [field, value = ''] = rows[i];
    if (field?.trim()) header[field.trim()] = value;
  }

  // Line-item table: the next non-blank row is its header, the rows after it are the lines.
  while (i < rows.length && isBlank(rows[i])) i++;
  const lineColumns = (rows[i] ?? []).map((c) => c.trim());
  const lines: Record<string, string>[] = [];
  for (i++; i < rows.length && !isBlank(rows[i]); i++) {
    const line: Record<string, string> = {};
    lineColumns.forEach((col, j) => (line[col] = rows[i][j] ?? ''));
    lines.push(line);
  }

  // The OCR's run summary says which files it used.
  let inputType = '';
  const inputFiles: string[] = [];
  try {
    const summary = JSON.parse(await fs.readFile(path.join(folder, RAW_RESULT_FILE), 'utf8')) as {
      input?: string;
      pdf?: string | null;
      sheet?: string | null;
    };
    inputType = summary.input ?? '';
    for (const f of [summary.pdf, summary.sheet]) if (f) inputFiles.push(path.basename(f));
  } catch {
    // no run summary: input type and files stay empty
  }

  return { header, lines, lineColumns, inputType, inputFiles, sourceFile: RAW_OUTPUT_FILE };
};
