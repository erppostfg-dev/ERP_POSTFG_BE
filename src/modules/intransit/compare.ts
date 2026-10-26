import { parseDeliveryDate } from './stages/shipments';
import { readXlsxSheet, xlsxSheetNames } from './sources/files';

/*
 * Report comparison (fix plan W6, 2026-10-19): a built workbook against a reference workbook, tab by tab, telling
 * real differences from format-only ones (date style, letter case, encoding, number formatting). Used by
 * `npm run intransit:compare` and meant for the regression check of a rebuilt reference.
 *
 * Per tab: tabs and columns present and in the same order; rows paired by a key (detected, or given), rows only in
 * one file; for paired rows each shared cell is equal, format-only or real.
 */

export type CellKind = 'real' | 'format';
export type Verdict = 'match' | 'format-only' | 'differs' | 'missing';

export interface SheetResult {
  sheet: string;
  inRun: boolean;
  inRef: boolean;
  missingColumns: string[];
  extraColumns: string[];
  columnOrderSame: boolean;
  rowsRun: number;
  rowsRef: number;
  /** Columns that pair rows; null = whole rows compared (no unique key found). */
  key: string[] | null;
  matched: number;
  onlyRun: number;
  onlyRef: number;
  realCells: number;
  formatCells: number;
  /** Real differences per column. */
  realByColumn: Record<string, number>;
  /** UNIT_COLS present in both: [run total, reference total]. */
  unitTotals: Record<string, [number, number]>;
  verdict: Verdict;
}

export interface CellDiff {
  sheet: string;
  key: string;
  column: string;
  run: string;
  ref: string;
  kind: CellKind;
}

export interface CompareResult {
  tabOrderSame: boolean;
  sheets: SheetResult[];
  /** Differing cells, at most maxCells of each kind per sheet. */
  cells: CellDiff[];
  /** Rows only in one file, at most maxCells per sheet and side. */
  rows: { sheet: string; side: 'run' | 'ref'; key: string }[];
}

export interface CompareOptions {
  /** Only these tabs. */
  sheets?: string[];
  /** Tab -> key columns, overriding the detected key. */
  keys?: Record<string, string[]>;
  maxCells?: number;
}

/**
 * Business keys per tab, from the comparison that found the gaps (handoff/report_compare/cmp_run.py KEYS). Used when
 * all their columns are in both files; otherwise a key is detected.
 */
export const DEFAULT_KEYS: Record<string, string[]> = {
  Intransit_Stock: ['PO Number', 'SKU Code', 'Sr No'],
  Full_Shipment_Enhanced: ['PO Number'],
  Summary_Dashboard: ['Final Status'],
  Duplicate_PO_Report: ['Duplicate UID', 'PO Code', 'Item SkuCode'],
  Export_B2B_InTransit_Orders: ['Sale Order Code', 'Item SKU Code'],
  PO_Not_Found_in_Export_B2B: ['PO Number', 'SKU Code', 'Sr No'],
  Combined_InTransit_Units: ['Source', 'PO Number', 'SKU Code', 'Sr No'],
  Current_Inventory: ['Channel Name', 'Fulfilment Centre', 'Channel SKU Code', 'SKU Code', 'Stock Type'],
  Combined_SOH_Intransit: ['Channel Name', 'Fulfilment Centre', 'Channel SKU Code', 'SKU Code', 'Stock Type'],
  Channel_Location_Master: ['Channel Name', 'Channel type', 'Final Location'],
  Missing_Items_Report: ['Missing Type', 'Channel SKU Code', 'SKU Code', 'Fulfilment Centre', 'Channel Name', 'Stock Type'],
  'SOH+Intransit-Split1': ['Split1 SKU', 'SKU Code', 'Final Location', 'Channel Name', 'Channel type', 'Stock Type', 'Split Source'],
  'SOH+Intransit-Split2': ['Split2 SKU', 'SKU Code', 'Final Location', 'Channel Name', 'Channel type', 'Stock Type', 'Split Source'],
  'Sheet35(2)': ['Split2 SKU', 'Final Location', 'Channel Name', 'Channel type', 'Stock Type'],
  'Final Sheet35(2)': ['Split2 SKU', 'Stock Type', 'Consider?'],
  'SKU not available in Split1': ['SKU Code', 'Channel type', 'Stock Type', 'Consider?'],
  'SKU not available in Split2': ['Split1 SKU', 'Channel type', 'Stock Type', 'Consider?'],
  'SKU not available in Sheet35(2)': ['Split2 SKU', 'Channel type', 'Stock Type', 'Consider?'],
  'Final SKU Not Mapped': ['SKU Code', 'Consider?'],
  'Final SKU Code Missing': ['SKU Code'],
};
/** Unit columns whose totals are printed per tab (cmp_run.py UNIT_COLS). */
export const UNIT_COLS = [
  'Final Units', 'Updated Qty', 'Updated Quantity', 'Total Units', 'final Intransit units', 'Final Planning Units', 'GRN Units', 'Units',
  'Total Final Units', 'Quantity',
];

const KEY_NAME_RE = /(^|[^a-z])(id|uid|code|codes|number|no|sku|po|fsn|msku|fnsku|location|facility|channel|warehouse|status|type|wh)([^a-z]|$)/i;
const MAX_KEY_COLS = 4;
const NUM_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const NULLISH = new Set(['', 'nan', 'none', 'null', 'nat', '#n/a', '-']);
/** Excel day serials of 1955..2119: a number there may be a date written as a serial. */
const SERIAL_MIN = 20000;
const SERIAL_MAX = 80000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The value with formatting taken out: numbers rounded, dates as days, text lower-cased, ASCII only, spaces collapsed. */
export const canon = (raw: string): string => {
  const v = raw.trim();
  if (NULLISH.has(v.toLowerCase())) return '';
  if (NUM_RE.test(v)) return `n:${Math.round(Number(v.replace(/,/g, '')) * 1e6) / 1e6}`;
  const d = parseDeliveryDate(v);
  if (d !== null) {
    // a day, or a day and time to the minute (the reference drops seconds: "18-08-2026 17:11")
    const iso = new Date(d).toISOString();
    return `d:${iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16)}`;
  }
  return v.normalize('NFKC').toLowerCase().replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
};

/** A date canon (d:YYYY-MM-DD) against an Excel serial canon (n:45678). */
const serialMatchesDate = (a: string, b: string): boolean => {
  const [num, day] = a.startsWith('n:') ? [a, b] : [b, a];
  if (!num.startsWith('n:') || !day.startsWith('d:')) return false;
  const n = Number(num.slice(2));
  return n >= SERIAL_MIN && n <= SERIAL_MAX && isoDay(EXCEL_EPOCH_MS + Math.floor(n) * DAY_MS) === day.slice(2, 12);
};

const NON_ASCII_RE = /[^\x20-\x7e]/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Characters lost to encoding: in `lossy`, every non-ASCII character or "?" run stands for 0-4 characters of `other`
 * ("De??an" matches "De‑Tan"), case ignored (cmp_run.py).
 */
const encodingMatch = (lossy: string, other: string): boolean => {
  const x = lossy.replace(NON_ASCII_RE, '?');
  if (!x.includes('?')) return false;
  const re = new RegExp(`^${x.split(/\?+/).map(escapeRe).join('.{0,4}')}$`, 'is');
  return re.test(other.replace(NON_ASCII_RE, '?'));
};

/** null = equal, else the kind of difference. */
export const cellDiff = (run: string, ref: string): CellKind | null => {
  if (run === ref) return null;
  const a = canon(run);
  const b = canon(ref);
  if (a === b || serialMatchesDate(a, b)) return 'format';
  return encodingMatch(ref.trim(), run.trim()) || encodingMatch(run.trim(), ref.trim()) ? 'format' : 'real';
};

type Table = { header: string[]; body: string[][] };

const tableOf = (rows: string[][] | null): Table | null => {
  if (!rows) return null;
  const [header = [], ...body] = rows;
  // trailing blank rows of a sheet are not data
  while (body.length && body[body.length - 1].every((c) => c === '')) body.pop();
  return { header: header.map((h) => h.trim()), body };
};

/** Index of each column name (first occurrence). */
const indexOf = (header: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  header.forEach((h, i) => {
    if (!m.has(h)) m.set(h, i);
  });
  return m;
};

const keyOf = (row: string[], idx: number[]): string => idx.map((i) => canon(row[i] ?? '')).join('\u0001');

/** Fewest id-like columns (most distinct first) whose values are unique in both tables; null when none within MAX_KEY_COLS. */
const detectKey = (run: Table, ref: Table, shared: string[]): string[] | null => {
  const ri = indexOf(run.header);
  const fi = indexOf(ref.header);
  const distinct = (c: string): number => new Set(ref.body.map((r) => canon(r[fi.get(c) as number] ?? ''))).size;
  const candidates = shared.filter((c) => KEY_NAME_RE.test(c)).map((c) => [c, distinct(c)] as const).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const unique = (t: Table, idx: number[]): boolean => new Set(t.body.map((r) => keyOf(r, idx))).size === t.body.length;
  const key: string[] = [];
  for (const c of candidates) {
    key.push(c);
    if (unique(ref, key.map((k) => fi.get(k) as number)) && unique(run, key.map((k) => ri.get(k) as number))) return key;
    if (key.length === MAX_KEY_COLS) break;
  }
  return null;
};

const compareSheet = (sheet: string, run: Table | null, ref: Table | null, opts: CompareOptions, out: CompareResult): SheetResult => {
  const base: SheetResult = {
    sheet, inRun: !!run, inRef: !!ref, missingColumns: [], extraColumns: [], columnOrderSame: true, rowsRun: run?.body.length ?? 0,
    rowsRef: ref?.body.length ?? 0, key: null, matched: 0, onlyRun: 0, onlyRef: 0, realCells: 0, formatCells: 0, realByColumn: {}, unitTotals: {}, verdict: 'missing',
  };
  if (!run || !ref) return base;
  const maxCells = opts.maxCells ?? 500;
  const runCols = new Set(run.header);
  const refCols = new Set(ref.header);
  const shared = ref.header.filter((c) => c !== '' && runCols.has(c));
  const res: SheetResult = {
    ...base,
    missingColumns: ref.header.filter((c) => c !== '' && !runCols.has(c)),
    extraColumns: run.header.filter((c) => c !== '' && !refCols.has(c)),
    columnOrderSame: shared.join('\u0001') === run.header.filter((c) => refCols.has(c)).join('\u0001'),
  };
  const ri = indexOf(run.header);
  const fi = indexOf(ref.header);
  const total = (t: Table, i: number): number => t.body.reduce((s, r) => s + (Number(String(r[i] ?? '').replace(/,/g, '')) || 0), 0);
  for (const c of UNIT_COLS.filter((u) => runCols.has(u) && refCols.has(u))) {
    res.unitTotals[c] = [Math.round(total(run, ri.get(c) as number)), Math.round(total(ref, fi.get(c) as number))];
  }
  // a --key override, else the business key when all its columns are in both files, else a detected one
  const inBoth = (cols?: string[]): string[] | null => (cols?.length && cols.every((c) => runCols.has(c) && refCols.has(c)) ? cols : null);
  res.key = inBoth(opts.keys?.[sheet]) ?? inBoth(DEFAULT_KEYS[sheet]) ?? detectKey(run, ref, shared);
  // no key: whole rows (shared columns) are the key, so a changed value shows as one row only in each file
  const keyCols = res.key ?? shared;
  const runKey = keyCols.map((c) => ri.get(c) as number);
  const refKey = keyCols.map((c) => fi.get(c) as number);

  // pair the n-th run row of a key with the n-th reference row of that key
  const refRows = new Map<string, number[]>();
  ref.body.forEach((r, i) => {
    const k = keyOf(r, refKey);
    const list = refRows.get(k);
    if (list) list.push(i);
    else refRows.set(k, [i]);
  });
  const kinds = { real: 0, format: 0 };
  const label = (row: string[], idx: number[]): string => idx.map((i) => row[i] ?? '').join(' | ');
  let onlyRunShown = 0;
  for (const row of run.body) {
    const k = keyOf(row, runKey);
    const refIdx = refRows.get(k)?.shift();
    if (refIdx === undefined) {
      res.onlyRun++;
      if (onlyRunShown++ < maxCells) out.rows.push({ sheet, side: 'run', key: label(row, runKey) });
      continue;
    }
    res.matched++;
    const refRow = ref.body[refIdx];
    for (const c of shared) {
      const a = row[ri.get(c) as number] ?? '';
      const b = refRow[fi.get(c) as number] ?? '';
      const kind = cellDiff(a, b);
      if (!kind) continue;
      if (kind === 'real') {
        res.realCells++;
        res.realByColumn[c] = (res.realByColumn[c] ?? 0) + 1;
      } else res.formatCells++;
      if (kinds[kind]++ < maxCells) out.cells.push({ sheet, key: label(row, runKey), column: c, run: a, ref: b, kind });
    }
  }
  let onlyRefShown = 0;
  for (const idx of refRows.values()) {
    for (const i of idx) {
      res.onlyRef++;
      if (onlyRefShown++ < maxCells) out.rows.push({ sheet, side: 'ref', key: label(ref.body[i], refKey) });
    }
  }

  const structural = res.missingColumns.length || res.extraColumns.length || !res.columnOrderSame;
  res.verdict = structural || res.onlyRun || res.onlyRef || res.realCells ? 'differs' : res.formatCells ? 'format-only' : 'match';
  return res;
};

/** Compare two workbooks (their bytes); tabs in the reference's order, then tabs only in the run. */
export const compareWorkbooks = (runXlsx: Uint8Array, refXlsx: Uint8Array, opts: CompareOptions = {}, onSheet?: (s: SheetResult) => void): CompareResult => {
  const runTabs = xlsxSheetNames(runXlsx);
  const refTabs = xlsxSheetNames(refXlsx);
  const shared = refTabs.filter((t) => runTabs.includes(t));
  const out: CompareResult = { tabOrderSame: shared.join('\u0001') === runTabs.filter((t) => refTabs.includes(t)).join('\u0001'), sheets: [], cells: [], rows: [] };
  const tabs = [...refTabs, ...runTabs.filter((t) => !refTabs.includes(t))].filter((t) => !opts.sheets?.length || opts.sheets.includes(t));
  for (const tab of tabs) {
    const run = runTabs.includes(tab) ? tableOf(readXlsxSheet(runXlsx, tab)) : null;
    const ref = refTabs.includes(tab) ? tableOf(readXlsxSheet(refXlsx, tab)) : null;
    const s = compareSheet(tab, run, ref, opts, out);
    out.sheets.push(s);
    onSheet?.(s);
  }
  return out;
};
