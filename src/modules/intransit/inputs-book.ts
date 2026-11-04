import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Zip, ZipDeflate } from 'fflate';
import { decodeText, eachCsvRow } from './io';
import { colName, NS_MAIN, textXlsxShell, XML_HEAD, xmlEsc } from './sources/files';

/*
 * Every daily input of a build in one workbook (user, 2026-11-02): Uniware's exports, PEPIMS' Shipment_Status /
 * PO_Format, Amazon, Flipkart and Myntra files, one tab per file named with the file's day ("Purchase_Order 02Nov").
 * Too big to mail (~100 MB of CSV), so the mail links to it. Every cell is text (codes stay as written).
 * Written in its own worker after the report: one input read at a time, the zip streamed to disk.
 */

/** Excel's limits: rows per sheet (header included) and characters per cell. */
const MAX_ROWS = 1_048_576;
const MAX_CELL = 32_767;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface BookInput {
  /** The input's file name in the build's input folder. */
  name: string;
  /** The day of the copy used (YYYY-MM-DD). */
  day: string;
}

/** "2026-11-02" -> "02Nov". */
const dayLabel = (day: string): string => {
  const [, m, d] = day.split('-');
  return `${d ?? ''}${MONTHS[Number(m) - 1] ?? ''}`;
};

/**
 * Tab names: "<file without Export- / .csv> <DDMon>", within Excel's 31 characters even with a " (2)" suffix, without
 * the characters Excel refuses or an apostrophe at either end, never "History", all different.
 */
export const tabNames = (files: BookInput[]): string[] => {
  const used = new Set<string>();
  return files.map((f) => {
    const label = ` ${dayLabel(f.day)}`;
    const base = f.name.replace(/\.csv$/i, '').replace(/^Export-/i, '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    let name = `${base.slice(0, 31 - label.length - 4).trim()}${label}`.replace(/^'+|'+$/g, '');
    if (name.toLowerCase() === 'history') name = `${name}_`;
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${name} (${n})`;
    used.add(unique.toLowerCase());
    return unique;
  });
};

const sheetHead = (width: number): string => {
  const cols = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="18" customWidth="1"/>`).join('');
  return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>`;
};

const rowXml = (cells: string[], r: number, header: boolean): string =>
  `<row r="${r}">${cells.map((v, ci) => `<c r="${colName(ci)}${r}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v)}</t></is></c>`).join('')}</row>`;

/**
 * Write the workbook to `outFile` from the CSVs in `inputDir` (missing files are skipped); returns its tabs. A file over
 * Excel's row limit continues in "<tab> (2)".
 */
export const writeInputsBook = async (
  inputDir: string, files: BookInput[], outFile: string, log: (line: string) => void, maxRows = MAX_ROWS,
): Promise<{ tabs: { tab: string; file: string; rows: number }[]; bytes: number }> => {
  const present: BookInput[] = [];
  for (const f of files) {
    if (await fs.stat(path.join(inputDir, f.name)).then(() => true, () => false)) present.push(f);
    else log(`  inputs workbook: ${f.name} not in this build's inputs - left out`);
  }
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const part = `${outFile}.part`;
  const out = createWriteStream(part);
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err;
    else out.write(chunk);
  });
  const encoder = new TextEncoder();
  const tabs: { tab: string; file: string; rows: number }[] = [];
  const names = tabNames(present);
  let sheetNo = 0;

  for (const [i, f] of present.entries()) {
    const text = decodeText(new Uint8Array(await fs.readFile(path.join(inputDir, f.name))));
    let header: string[] | null = null;
    let entry: ZipDeflate | null = null;
    let r = 0;
    let parts = 0;
    let buf: string[] = [];
    const flush = (): void => {
      if (buf.length && entry) entry.push(encoder.encode(buf.join('')));
      buf = [];
    };
    const close = (): void => {
      if (!entry) return;
      flush();
      const width = header?.length ?? 1;
      entry.push(encoder.encode(`</sheetData>${r > 1 ? `<autoFilter ref="A1:${colName(width - 1)}${r}"/>` : ''}</worksheet>`), true);
      tabs.push({ tab: parts > 1 ? `${names[i]} (${parts})` : names[i], file: f.name, rows: r - 1 });
      entry = null;
    };
    const open = (): void => {
      parts++;
      sheetNo++;
      entry = new ZipDeflate(`xl/worksheets/sheet${sheetNo}.xml`, { level: 3 });
      zip.add(entry);
      r = 1;
      buf.push(sheetHead(header?.length ?? 1), rowXml(header ?? [], 1, true));
    };
    eachCsvRow(text, ',', (cells) => {
      if (!header) {
        header = cells;
        open();
        return;
      }
      if (r >= maxRows) {
        close();
        open();
      }
      r++;
      buf.push(rowXml(cells, r, false));
      if (buf.length >= 2000) flush();
    });
    if (!header) {
      header = [];
      open();
    }
    close();
    await new Promise<void>((resolve) => (out.writableLength > 8 * 1024 * 1024 ? out.once('drain', resolve) : resolve()));
    log(`  inputs workbook: ${f.name} (${f.day})${parts > 1 ? ` in ${parts} tabs (over Excel's row limit)` : ''}`);
  }

  for (const [name, raw] of Object.entries(textXlsxShell(tabs.map((t) => t.tab)))) {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(raw, true);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });
  if (zipError) throw zipError;
  await fs.rename(part, outFile);
  const { size } = await fs.stat(outFile);
  return { tabs, bytes: size };
};
