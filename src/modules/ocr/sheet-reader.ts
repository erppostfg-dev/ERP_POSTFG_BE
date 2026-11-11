import fs from 'fs/promises';
import path from 'path';
import { FILES } from '../../constants';
import { parseCsv } from '../po-processing/common/raw-reader';
import { excelRows } from './excel-rows';

/*
 * Sheet reader (2026-10-26): for channels whose attachment already IS the PO as a table (channels.config
 * reader: 'sheet'; first Tata 1mg). No OCR: every sheet is read as it is and written as the raw JSON
 * (FILES.OCR_RAW_JSON, the OCR team's shape: header {}, line_items [{ column: value }]), so the channel's handler and
 * the rest of the chain run exactly as after an OCR run. Several sheets (one per PO) go into one list; the handler
 * splits them by its PO column.
 * Excel too (2026-11-05, Noble Chemist's .xls): read through ocr-service sheet_rows.py (excel-rows.ts, no model call).
 * headerRow: the row holding the column names when it is not the first (the rows above -> header "Line 1", "Line 2" ...).
 * Blank rows between the lines are skipped.
 */

export interface SheetReadResult {
  files: string[];
  lines: number;
  columns: string[];
}

const CSV_EXT = /\.csv$/i;
const EXCEL_EXT = /\.(xls|xlsx)$/i;

const rowsOf = async (dir: string, file: string): Promise<string[][]> =>
  CSV_EXT.test(file)
    ? parseCsv((await fs.readFile(path.join(dir, file), 'utf8')).replace(/^﻿/, ''))
    : excelRows(path.join(dir, file));

export const readSheets = async (dir: string, files: string[], channel: string, opts: { headerRow?: RegExp } = {}): Promise<SheetReadResult> => {
  const unknown = files.filter((f) => !CSV_EXT.test(f) && !EXCEL_EXT.test(f));
  if (unknown.length) throw new Error(`the sheet reader reads CSV and Excel only; got ${unknown.join(', ')}`);
  if (!files.length) throw new Error('no sheet to read');

  const lines: Record<string, string>[] = [];
  const columns: string[] = [];
  const header: Record<string, string> = {};
  for (const file of files) {
    const rows = await rowsOf(dir, file);
    let at = 0;
    if (opts.headerRow) {
      at = rows.findIndex((r) => opts.headerRow!.test(r.join(' ')));
      if (at < 0) throw new Error(`${file}: no row with the column names (${String(opts.headerRow)})`);
      // the title rows above the column names (order no, date, buyer ...): kept for the handler, first file wins
      rows.slice(0, at).forEach((r, i) => {
        const text = r.map((c) => c.trim()).filter(Boolean).join(' ');
        if (text && header[`Line ${i + 1}`] === undefined) header[`Line ${i + 1}`] = text;
      });
    }
    const names = (rows[at] ?? []).map((h) => h.trim());
    for (const h of names) if (h && !columns.includes(h)) columns.push(h);
    for (const row of rows.slice(at + 1)) {
      if (row.every((c) => c.trim() === '')) continue;
      lines.push(Object.fromEntries(names.map((h, i) => [h, (row[i] ?? '').trim()]).filter(([h]) => h)));
    }
  }

  const raw = {
    channel,
    input: 'sheet',
    pdf: null,
    sheet: files[0],
    sheets: files,
    reader: 'sheet',
    header,
    totals: {},
    line_item_columns: columns,
    line_items: lines,
    warnings: [],
  };
  await fs.writeFile(path.join(dir, FILES.OCR_RAW_JSON), JSON.stringify(raw, null, 2), 'utf8');
  return { files, lines: lines.length, columns };
};
