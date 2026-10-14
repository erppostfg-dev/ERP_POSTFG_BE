/*
 * A small CSV reader (RFC 4180: commas, double-quoted cells with "" for a quote, CRLF or LF, a UTF-8 BOM) for the
 * master files masters:load reads. Excel's "CSV UTF-8" export fits it.
 */

/** All rows as cells; a blank line is skipped. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
};

/** Rows as objects keyed by the (trimmed) header; cells trimmed, an empty cell is ''. */
export const csvRecords = (text: string): { header: string[]; records: Record<string, string>[] } => {
  const [head = [], ...body] = parseCsv(text);
  const header = head.map((h) => h.trim());
  return { header, records: body.map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]))) };
};

/** One CSV cell: quoted when it holds a comma, quote or line break. */
export const csvCell = (value: string | number | null | undefined): string => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
