import fs from 'fs/promises';
import path from 'path';
import { FILES } from '../../constants';
import { parseCsv } from '../po-processing/common/raw-reader';

/*
 * Sheet reader (2026-10-26): for channels whose attachment already IS the PO as a table (channels.config
 * reader: 'sheet'; first Tata 1mg). No OCR: every CSV is read as it is and written as the raw JSON
 * (FILES.OCR_RAW_JSON, the OCR team's shape: header {}, line_items [{ column: value }]), so the channel's handler and
 * the rest of the chain run exactly as after an OCR run. Several CSVs (one per PO) go into one list; the handler
 * splits them by its PO column. CSV only for now; an Excel channel would add a reader here.
 */

export interface SheetReadResult {
  files: string[];
  lines: number;
  columns: string[];
}

const SHEET_EXT = /\.csv$/i;

export const readSheets = async (dir: string, files: string[], channel: string): Promise<SheetReadResult> => {
  const notCsv = files.filter((f) => !SHEET_EXT.test(f));
  if (notCsv.length) throw new Error(`the sheet reader reads CSV only; got ${notCsv.join(', ')}`);
  if (!files.length) throw new Error('no sheet to read');

  const lines: Record<string, string>[] = [];
  const columns: string[] = [];
  for (const file of files) {
    const rows = parseCsv((await fs.readFile(path.join(dir, file), 'utf8')).replace(/^﻿/, ''));
    const header = (rows[0] ?? []).map((h) => h.trim());
    for (const h of header) if (h && !columns.includes(h)) columns.push(h);
    for (const row of rows.slice(1)) {
      if (row.every((c) => c.trim() === '')) continue;
      lines.push(Object.fromEntries(header.map((h, i) => [h, (row[i] ?? '').trim()]).filter(([h]) => h)));
    }
  }

  const raw = {
    channel,
    input: 'sheet',
    pdf: null,
    sheet: files[0],
    sheets: files,
    reader: 'sheet',
    header: {},
    totals: {},
    line_item_columns: columns,
    line_items: lines,
    warnings: [],
  };
  await fs.writeFile(path.join(dir, FILES.OCR_RAW_JSON), JSON.stringify(raw, null, 2), 'utf8');
  return { files, lines: lines.length, columns };
};
