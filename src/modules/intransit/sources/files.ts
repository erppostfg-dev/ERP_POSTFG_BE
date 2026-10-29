import fs from 'fs/promises';
import path from 'path';
import { gunzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { Cell, fmtVal, Frame } from '../frame';
import { cleanCols, decodeText, parseCsvFrame, tokenizeCsv } from '../io';
import { fillAll } from '../stages/common';

/*
 * Files the connectors download and write: plain / gzipped / zipped CSV, TSV or xlsx in, CSV out (always written to
 * a .part file first, so a half-written file never takes the real name).
 */

export type FileKind = 'gz' | 'zip' | 'xlsx' | 'csv';

export const fileKind = (raw: Uint8Array): FileKind => {
  if (raw[0] === 0x1f && raw[1] === 0x8b) return 'gz';
  if (raw[0] === 0x50 && raw[1] === 0x4b) return '[Content_Types].xml' in unzipSync(raw, { filter: (f) => f.name === '[Content_Types].xml' }) ? 'xlsx' : 'zip';
  return 'csv';
};

/** The one file inside a zip. */
const onlyMember = (raw: Uint8Array, what: string): Uint8Array => {
  const files = Object.entries(unzipSync(raw)).filter(([name]) => !name.endsWith('/'));
  if (files.length !== 1) throw new Error(`expected one file in the ${what} zip, found [${files.map(([n]) => n).join(', ')}]`);
  return files[0][1];
};

/** The file's bytes, whether it came plain, gzipped or zipped (uniware.py unpack). */
export const unpack = (raw: Uint8Array, what = 'export'): Uint8Array => {
  const kind = fileKind(raw);
  if (kind === 'gz') return gunzipSync(raw);
  if (kind === 'zip') return onlyMember(raw, what);
  return raw;
};

/** The first sheet of an xlsx as text rows (shared and inline strings, numbers as stored). */
export const readXlsxRows = (raw: Uint8Array): string[][] => {
  const files = unzipSync(raw);
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
  if (!sheetName) return [];
  return sheetRows(strFromU8(files[sheetName]), sharedOf(files['xl/sharedStrings.xml']));
};

const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const texts = (x: string): string => unesc([...x.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const sharedOf = (sst?: Uint8Array): string[] => (sst ? [...strFromU8(sst).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : []);

/** The tab names of an xlsx, in workbook order. */
export const xlsxSheetNames = (raw: Uint8Array): string[] => {
  const wbx = unzipSync(raw, { filter: (f) => f.name === 'xl/workbook.xml' })['xl/workbook.xml'];
  return wbx ? [...strFromU8(wbx).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unesc(m[1])) : [];
};

/**
 * One sheet of an xlsx, found by its tab name, as text rows. Only that sheet (and the shared strings) is decompressed,
 * so a single table can be read out of the 40 MB report quickly. Null when the workbook has no sheet of that name.
 */
export const readXlsxSheet = (raw: Uint8Array, sheet: string): string[][] | null => {
  const meta = unzipSync(raw, { filter: (f) => f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' });
  const wbx = meta['xl/workbook.xml'];
  const rels = meta['xl/_rels/workbook.xml.rels'];
  if (!wbx || !rels) return null;
  const rid = [...strFromU8(wbx).matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)].find((m) => unesc(m[1]) === sheet)?.[2];
  const target = rid && new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(strFromU8(rels))?.[1];
  if (!target) return null;
  const part = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const files = unzipSync(raw, { filter: (f) => f.name === part || f.name === 'xl/sharedStrings.xml' });
  return files[part] ? sheetRows(strFromU8(files[part]), sharedOf(files['xl/sharedStrings.xml'])) : null;
};

/** Text rows of a worksheet's XML (inline strings, shared strings, numbers as stored). */
const sheetRows = (xml: string, shared: string[]): string[][] => {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(cm[1])?.[1] ?? '';
      let idx = 0;
      for (const ch of ref) idx = idx * 26 + ch.charCodeAt(0) - 64;
      const t = /\bt="([^"]*)"/.exec(cm[1])?.[1];
      const body = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      row[(idx || row.length + 1) - 1] = t === 'inlineStr' ? texts(body) : t === 's' ? shared[Number(v)] ?? '' : unesc(v ?? '');
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
};

/**
 * A downloaded report as an all-text frame, whatever its format (CSV/TSV text, xlsx, gzip or a zip holding one of
 * those): header names cleaned, NaN as "" (pd.read_csv(dtype=str) / read_excel + clean_cols + fillna("")).
 */
export const readReport = (raw: Uint8Array, sep?: ',' | '\t'): Frame => {
  const kind = fileKind(raw);
  if (kind === 'gz') return readReport(gunzipSync(raw), sep);
  if (kind === 'zip') return readReport(onlyMember(raw, 'report'), sep);
  if (kind === 'xlsx') {
    const [header = [], ...body] = readXlsxRows(raw);
    return fillAll(cleanCols(Frame.fromRows(header, body.map((r) => header.map((_, j) => (r[j] === '' || r[j] === undefined ? null : r[j]))))), '');
  }
  const text = decodeText(raw);
  const first = text.split('\n', 1)[0];
  const delim = sep ?? ((first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ',');
  return fillAll(cleanCols(parseCsvFrame(text, 'report', delim)), '');
};

/** CSV text rows as csv.reader gives them (no NA conversion). */
export const readRows = (raw: Uint8Array): string[][] => tokenizeCsv(decodeText(raw));

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Rows as CSV (QUOTE_MINIMAL, as Python's csv.writer and pandas to_csv). */
export const toCsv = (rows: readonly (readonly string[])[]): string => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** frameToCsv in pieces of `rowsPerChunk` lines, so a big sheet can be streamed to a file without one huge string. */
export function* frameCsvChunks(df: Frame, rowsPerChunk = 1000): Generator<string> {
  const cols = df.columns.map((c) => df.get(c));
  yield toCsv([[...df.columns]]);
  for (let start = 0; start < df.length; start += rowsPerChunk) {
    const end = Math.min(start + rowsPerChunk, df.length);
    yield toCsv(Array.from({ length: end - start }, (_, k) => cols.map((col) => fmtVal(col[start + k] as Cell))));
  }
}

/** A frame as CSV (pandas to_csv(index=False): NaN blank, whole floats as ints). */
export const frameToCsv = (df: Frame): string => [...frameCsvChunks(df)].join('');

/** Write a file via <file>.part + rename. */
export const writeAtomic = async (file: string, data: string | Uint8Array): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
};

// ---- review workbooks (text only) ---------------------------------------------------------------------------------

export interface TextSheet {
  name: string;
  rows: string[][];
  /** Column widths in characters (default 20). */
  widths?: number[];
}

const xmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
const colName = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * A small xlsx whose every cell is text (inline strings, number format "@") with a bold, filtered, frozen header row:
 * long numeric codes (EANs, Myntra / Tira ids) open in Excel exactly as written, never rounded to 8.91E+12.
 */
export const textXlsx = (sheets: TextSheet[]): Uint8Array => {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>'),
    '_rels/.rels': strToU8(`${XML_HEAD}<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(
      `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_DOC_REL}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${NS_REL}">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_DOC_REL}/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(
      `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>` +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/></patternFill></fill></fills>' +
      '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>' +
      '<cellXfs count="2"><xf fontId="0" numFmtId="49" applyNumberFormat="1"/><xf fontId="1" fillId="2" numFmtId="49" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs></styleSheet>'),
  };
  sheets.forEach((s, si) => {
    const width = Math.max(1, s.rows[0]?.length ?? 1);
    const body = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) =>
      `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v ?? '')}</t></is></c>`).join('')}</row>`).join('');
    const cols = Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${s.widths?.[i] ?? 20}" customWidth="1"/>`).join('');
    const filter = s.rows.length > 1 ? `<autoFilter ref="A1:${colName(width - 1)}${s.rows.length}"/>` : '';
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `${XML_HEAD}<worksheet xmlns="${NS_MAIN}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${cols}</cols><sheetData>${body}</sheetData>${filter}</worksheet>`);
  });
  return zipSync(files);
};
