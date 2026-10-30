import { strToU8, zipSync } from 'fflate';
import { columnLetter, esc } from './excel';

/*
 * A plain workbook from scratch (2026-10-30, the in-transit mail's attachments): a few sheets of values with a green
 * bold header, frozen first row and per-column number formats. No template, no formulas, inline strings only.
 */

/** text = as is; int = #,##0; dec = #,##0.00; pct = 0.0% (a share 0..1). */
export type ColKind = 'text' | 'int' | 'dec' | 'pct';
export type XCell = string | number | null | undefined;

export interface XSheet {
  name: string;
  columns: { header: string; kind?: ColKind; width?: number }[];
  rows: XCell[][];
  /** Rows above the header (e.g. a title); the header row follows them. */
  title?: string;
}

const STYLE: Record<ColKind | 'header' | 'title', number> = { text: 0, header: 1, int: 2, dec: 3, pct: 4, title: 5 };

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>'
  + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="6">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
  + '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

const text = (ref: string, v: string, s: number): string => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;

const cell = (ref: string, v: XCell, kind: ColKind): string => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}" s="${STYLE[kind === 'text' ? 'dec' : kind]}"><v>${v}</v></c>` : '';
  return text(ref, v, STYLE.text);
};

const sheetXml = (sh: XSheet): string => {
  const top = sh.title ? 2 : 0;
  const hr = top + 1;
  const n = sh.columns.length;
  const widths = sh.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? (c.kind && c.kind !== 'text' ? 14 : 22)}" customWidth="1"/>`).join('');
  const rows: string[] = [];
  if (sh.title) rows.push(`<row r="1">${text('A1', sh.title, STYLE.title)}</row>`);
  rows.push(`<row r="${hr}">${sh.columns.map((c, i) => text(`${columnLetter(i + 1)}${hr}`, c.header, STYLE.header)).join('')}</row>`);
  sh.rows.forEach((r, j) => {
    const ri = hr + 1 + j;
    rows.push(`<row r="${ri}">${sh.columns.map((c, i) => cell(`${columnLetter(i + 1)}${ri}`, r[i], c.kind ?? 'text')).join('')}</row>`);
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<dimension ref="A1:${columnLetter(Math.max(n, 1))}${hr + sh.rows.length}"/>`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${hr}" topLeftCell="A${hr + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${rows.join('')}</sheetData>`
    + (n ? `<autoFilter ref="A${hr}:${columnLetter(n)}${hr + sh.rows.length}"/>` : '')
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
};

/** Excel sheet names: at most 31 characters, none of : \ / ? * [ ]. */
const sheetName = (s: string): string => s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);

/** The .xlsx bytes of `sheets`. */
export const xlsxBytes = (sheets: XSheet[]): Uint8Array => {
  const names = sheets.map((s) => sheetName(s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + names.map((n, i) => `<sheet name="${esc(n).replace(/"/g, '&quot;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES_XML),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
};
