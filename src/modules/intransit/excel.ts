import fs from 'fs/promises';
import path from 'path';
import { strFromU8, unzipSync, Zip, ZipDeflate } from 'fflate';
import { BASE_SHEETS, EXTRA_SHEETS } from '../../constants';
import { Context, fmtInt } from './context';
import { fmtVal, Frame } from './frame';

/*
 * The workbook writer (excel.py). The template supplies sheets 1-3 (styles, conditional formats, validations) and
 * their data is swapped in; the 17 generated sheets are appended as sheets 4-20. Every value is an inline string,
 * as in the Python. Sheet XML is streamed into the zip in chunks (the big sheets are ~100 MB of text), written to a
 * .part file, then renamed, so only a complete workbook ever lands at the report path.
 */

const FIRST_EXTRA_SHEET = 4;
const DATA_STYLE = 2;
const EXTRA_HEADER_STYLE = 3;
const ROWS_PER_CHUNK = 1000;
const WORKSHEET_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const WORKSHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

/** Characters illegal in XML 1.0 (Excel refuses the file if any reach a sheet), and lone surrogate halves. */
const ILLEGAL_XML_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const EXTRA_NUM = '(?:[4-9]|[1-9][0-9]+)';
const EXTRA_PART_RE = new RegExp(`xl/worksheets/sheet${EXTRA_NUM}\\.xml$`);
const DIM_RE = /<dimension ref="[^"]*"\/>/;
const SHEETDATA_RE = /<sheetData>[\s\S]*?<\/sheetData>/;
// sqref of conditionalFormatting / dataValidation only - never <selection sqref>.
const CF_DV_SQREF_RE = /(<(?:conditionalFormatting|dataValidation)\b[^>]*?\bsqref=")([^"]*)(")/g;
const HDR_ROW_RE = /<row\b[^>]*?\br="1"[^>]*>([\s\S]*?)<\/row>/;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const T_RE = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
const V_RE = /<v>([\s\S]*?)<\/v>/;

// ---- cell XML --------------------------------------------------------------------------------------------------

export const esc = (s: string): string => s.replace(ILLEGAL_XML_RE, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

/** openpyxl get_column_letter: 1 -> A, 27 -> AA. */
export const columnLetter = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

/** <sheetData> with a header row and every value as an inline string, in chunks of rows. */
function* sheetDataXml(df: Frame, headerStyle: number): Generator<string> {
  const letters = df.columns.map((_, i) => columnLetter(i + 1));
  const cols = df.columns.map((c) => df.get(c));
  const hdr = df.columns.map((h, i) => `<c r="${letters[i]}1" s="${headerStyle}" t="inlineStr"><is><t>${esc(h)}</t></is></c>`).join('');
  yield `<sheetData><row r="1" ht="30" customHeight="1">${hdr}</row>`;
  let parts: string[] = [];
  for (let r = 0; r < df.length; r++) {
    const ri = r + 2;
    let row = `<row r="${ri}">`;
    for (let j = 0; j < cols.length; j++) {
      const sval = fmtVal(cols[j][r]);
      row += sval === '' ? `<c r="${letters[j]}${ri}" s="${DATA_STYLE}"/>` : `<c r="${letters[j]}${ri}" s="${DATA_STYLE}" t="inlineStr"><is><t>${esc(sval)}</t></is></c>`;
    }
    parts.push(`${row}</row>`);
    if (parts.length === ROWS_PER_CHUNK) {
      yield parts.join('');
      parts = [];
    }
  }
  yield `${parts.join('')}</sheetData>`;
}

const dimensionXml = (df: Frame): string => `<dimension ref="A1:${columnLetter(df.columns.length)}${df.length + 1}"/>`;

/** A generated sheet: frozen header, fixed widths. */
function* worksheetXml(df: Frame): Generator<string> {
  const cols = `<cols><col min="1" max="1" width="40.7109375" customWidth="1"/><col min="2" max="${df.columns.length}" width="18.7109375" customWidth="1"/></cols>`;
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    dimensionXml(df) +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" ' +
    'activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' + cols;
  yield* sheetDataXml(df, EXTRA_HEADER_STYLE);
  yield '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
}

// ---- template sheets -------------------------------------------------------------------------------------------

const xmlUnescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const tTexts = (xml: string): string => [...xml.matchAll(T_RE)].map((m) => m[1]).join('');

const sharedStrings = (files: Record<string, Uint8Array>): string[] => {
  const raw = files['xl/sharedStrings.xml'];
  if (!raw) return [];
  return [...strFromU8(raw).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => xmlUnescape(tTexts(m[1])));
};

/** {column letter: header text} from row 1 of a template sheet. */
const templateHeaders = (xml: string, shared: string[]): Map<string, string> => {
  const out = new Map<string, string>();
  const m = HDR_ROW_RE.exec(xml);
  if (!m) return out;
  for (const cm of m[1].matchAll(CELL_RE)) {
    const attrs = cm[1];
    const body = cm[2] ?? '';
    const ref = /\br="([A-Z]+)1"/.exec(attrs);
    if (!ref) continue;
    const t = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? '';
    let text: string;
    if (t === 's') {
      const v = V_RE.exec(body);
      text = (v ? shared[Number.parseInt(v[1], 10)] : '') ?? '';
    } else if (t === 'inlineStr') text = xmlUnescape(tTexts(body));
    else {
      const v = V_RE.exec(body);
      text = v ? xmlUnescape(v[1]) : '';
    }
    out.set(ref[1], text.trim());
  }
  return out;
};

/**
 * A template sheet with the data swapped in: [before the data, the data chunks, after]. Each conditional format /
 * validation range is pointed at its header's current column (upstream stages may insert columns).
 */
const patchBaseSheet = (ctx: Context, xml: string, df: Frame, headerStyle: number, fallbackCol: string, label: string, shared: string[]): [string, Iterable<string>, string] => {
  const tplHdrs = templateHeaders(xml, shared); // read before sheetData is replaced
  const lastRow = df.length + 1;
  const dfCols = df.columns.map((c) => c.trim());
  const retarget = (_: string, open: string, sqref: string, close: string): string => {
    const tokens = sqref.split(/\s+/).filter(Boolean);
    const tplCol = /^\$?([A-Z]+)/.exec(tokens[0] ?? '')?.[1];
    const hdr = tplCol ? tplHdrs.get(tplCol) : undefined;
    let col: string;
    if (hdr && dfCols.includes(hdr)) col = columnLetter(dfCols.indexOf(hdr) + 1);
    else {
      col = fallbackCol;
      ctx.log(`  WARNING ${label}: template column ${tplCol ? `'${tplCol}'` : 'None'} (header ${hdr ? `'${hdr}'` : 'None'}) not found - using ${col}`);
    }
    return `${open}${col}2:${col}${lastRow}${close}`;
  };
  const withDim = xml.replace(DIM_RE, () => dimensionXml(df));
  const m = SHEETDATA_RE.exec(withDim);
  if (!m) return [withDim.replace(CF_DV_SQREF_RE, retarget), [], ''];
  const before = withDim.slice(0, m.index).replace(CF_DV_SQREF_RE, retarget);
  const after = withDim.slice(m.index + m[0].length).replace(CF_DV_SQREF_RE, retarget);
  return [before, sheetDataXml(df, headerStyle), after];
};

// ---- workbook structure ----------------------------------------------------------------------------------------

/** Remove sheet 4+ references (the template may be a previous output). */
const dropExtraSheets = (ct: string, wbx: string, rels: string): [string, string, string] => [
  ct.replace(new RegExp(`<Override\\b[^>]*\\bPartName="/xl/worksheets/sheet${EXTRA_NUM}\\.xml"[^>]*/>`, 'g'), ''),
  wbx.replace(new RegExp(`<sheet name="[^"]*" sheetId="${EXTRA_NUM}" r:id="[^"]*"/>`, 'g'), ''),
  rels.replace(new RegExp(`<Relationship Id="[^"]*" Type="${WORKSHEET_REL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}" Target="worksheets/sheet${EXTRA_NUM}\\.xml"/>`, 'g'), ''),
];

/**
 * Add sheets 4.. to the workbook, content types and relationships. New rIds continue after the highest existing one
 * (the template reserves ids for theme/sharedStrings/styles; colliding with them blanks sheets).
 */
const registerExtraSheets = (ct: string, wbx: string, rels: string): [string, string, string] => {
  const rids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rid = rids.length ? Math.max(...rids) + 1 : 1;
  const sheetTags: string[] = [];
  const relTags: string[] = [];
  const ctTags: string[] = [];
  EXTRA_SHEETS.forEach(([name], i) => {
    const n = FIRST_EXTRA_SHEET + i;
    sheetTags.push(`<sheet name="${escAttr(name)}" sheetId="${n}" r:id="rId${rid + i}"/>`);
    relTags.push(`<Relationship Id="rId${rid + i}" Type="${WORKSHEET_REL}" Target="worksheets/sheet${n}.xml"/>`);
    ctTags.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="${WORKSHEET_CT}"/>`);
  });
  return [
    ct.replace('</Types>', () => `${ctTags.join('')}</Types>`),
    wbx.replace('</sheets>', () => `${sheetTags.join('')}</sheets>`),
    rels.replace('</Relationships>', () => `${relTags.join('')}</Relationships>`),
  ];
};

/** Writes the 20-sheet report next to the run's other files; returns its path. */
export const writeReport = async (ctx: Context, reportPath: string): Promise<string> => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const tmp = `${reportPath}.part`;
  const files = unzipSync(new Uint8Array(await fs.readFile(ctx.settings.templateXlsx)));
  const shared = sharedStrings(files);
  const text = (name: string): string => {
    const raw = files[name];
    if (!raw) throw new Error(`template has no ${name}`);
    return strFromU8(raw);
  };

  const replaced = new Map<string, Iterable<string>>();
  for (const [part, frame, headerStyle, fallback, label] of BASE_SHEETS) {
    const [before, data, after] = patchBaseSheet(ctx, text(part), ctx.get(frame), headerStyle, fallback, label, shared);
    replaced.set(part, (function* () {
      yield before;
      yield* data;
      yield after;
    })());
  }
  const [ct, wbx, rels] = registerExtraSheets(...dropExtraSheets(text('[Content_Types].xml'), text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels')));
  replaced.set('[Content_Types].xml', [ct]);
  replaced.set('xl/workbook.xml', [wbx]);
  replaced.set('xl/_rels/workbook.xml.rels', [rels]);

  const chunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err;
    else chunks.push(chunk);
  });
  const encoder = new TextEncoder();
  const addFile = (name: string, parts: Iterable<string> | Uint8Array): void => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    if (parts instanceof Uint8Array) {
      entry.push(parts, true);
      return;
    }
    for (const p of parts) if (p) entry.push(encoder.encode(p));
    entry.push(new Uint8Array(0), true);
  };

  for (const [name, raw] of Object.entries(files)) {
    if (EXTRA_PART_RE.test(name)) continue;
    addFile(name, replaced.get(name) ?? raw);
  }
  EXTRA_SHEETS.forEach(([sheet, frame], i) => {
    const df = ctx.get(frame);
    addFile(`xl/worksheets/sheet${FIRST_EXTRA_SHEET + i}.xml`, worksheetXml(df));
    ctx.log(`  sheet '${sheet}': (${df.length}, ${df.columns.length})`);
  });
  zip.end();
  if (zipError) throw zipError;

  await fs.writeFile(tmp, Buffer.concat(chunks));
  await fs.rename(tmp, reportPath);
  const { size } = await fs.stat(reportPath);
  ctx.log(`report: ${reportPath} (${fmtInt(size)} bytes)`);
  return reportPath;
};
