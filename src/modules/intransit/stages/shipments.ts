import fs from 'fs';
import { INTRANSIT_STOCK_STATUSES } from '../../../constants';
import { Context, fmtInt } from '../context';
import { anyWordRe, Cell, Col, countTrue, fillna, Frame, isIn, normKey, pyStr, stripped, sum, toNum } from '../frame';
import { stripCols } from '../io';
import { fillAll } from './common';

/* GRN matching and Final Status for every shipment; SKU-level in-transit lines (shipments.py, legacy stageA). */

const FILES = {
  shipment_status: 'Shipment_Status.csv',
  fk_grn: 'FK_GRN.csv',
  myntra_grn: 'Myntra_GRN.csv',
  amazon_grn: 'Amazon_GRN.csv',
  purchase_order: 'Purchase_Order.csv',
  po_format: 'PO_Format.csv',
};
const COL = {
  ss_po: 'PO Number', ss_po_inward: 'PO Number (Inward - CWH)', ss_total_units: 'Total Units', ss_updated_qty: 'Updated Qty',
  ss_status_p: 'Status (Planning)', ss_status_w: 'Status (Warehouse)', ss_status_l: 'Status (Logistics)', ss_dispatch_date: 'Dispatch Date',
  ss_delivery_date: 'Delivery Date', ss_pick_list: 'Pick List No',
  fk_po: 'Consignment Id', fk_grn_status: 'GRN Status', fk_grn_units: 'GRN Qty',
  myn_po: 'STR Code', myn_grn_status: 'Lot Status', myn_grn_units: 'Inward Qty',
  amz_po: 'Shipment ID', amz_grn_status: 'Status', amz_grn_units: 'Units located',
  po_code: 'PO Code', po_ref: 'ReferenceOrder', po_grn_status: 'Purchase Order Status', po_grn_units: 'Recieved Quantity',
  pof_po: 'PO Number',
} as const;
const SS_REQUIRED = [
  'ss_po', 'ss_po_inward', 'ss_total_units', 'ss_updated_qty', 'ss_status_p', 'ss_status_w', 'ss_status_l', 'ss_dispatch_date',
  'ss_delivery_date', 'ss_pick_list',
] as const;

const CANCEL_KW = anyWordRe(['cancel', 'cancelled']);
const RTS_KW = anyWordRe(['rts', 'pack', 'packed', 'label pending']);
const DISP_KW = anyWordRe(['dispatch', 'dispatched', 'intransit', 'in transit']);
const PKV_KW = anyWordRe(['pkv', 'dw']);
const HOLD_KW = anyWordRe(['hold', 'order']);
const RTO_KW = anyWordRe(['rto']);
const INWARD_KW = anyWordRe(['inward']);
const DELIVERY_STALE_DAYS = 5;
/** Newest Entry Dates of Shipment_Status and PO_Format further apart than this are warned about. */
const INPUT_ENTRY_DATE_GAP_DAYS = 1;
/** % GRN Pending treated as "nothing received". */
const FULLY_PENDING = 0.9999;
/** At or below this, a partial GRN counts as done. */
const GRN_DONE_MAX_PENDING = 0.5;
/**
 * Marketplace-only assumption: delivered > DELIVERY_STALE_DAYS ago with no GRN means received but not yet booked.
 * Matched exactly - "Flipkart Qcom" and "Amazon RK World" are deliberately out of scope.
 */
const GRN_DELIVERED_CHANNELS = new Set(['flipkart', 'myntra', 'amazon']);

export const EXCLUDED = ['GRN Done', 'Partial GRN Done', "Don't Consider", 'GRN-Done(Delivered)'];
export const STATUS_ORDER = [
  'GRN Done', 'Partial GRN Done', 'PO Created', 'RTS', 'Intransit', 'Working', 'Working Hold', "Don't Consider", 'Manual Check',
  'GRN-Done(Delivered)',
];

const DAY_MS = 86400000;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const load = async (ctx: Context, name: string, key: string): Promise<Frame> => {
  if (!fs.existsSync(ctx.inputPath(name))) {
    ctx.log(`  WARNING not found: ${name}`);
    return Frame.empty();
  }
  const df = fillAll(stripCols(await ctx.readInput(name)), '');
  ctx.log(`  loaded ${key}: ${fmtInt(df.length)} rows x ${df.columns.length} cols`);
  return df;
};

/** Trimmed text column; blank if the column is absent. */
const text = (df: Frame, col: string): string[] => (df.has(col) ? stripped(fillna(df.get(col), '')) : new Array<string>(df.length).fill(''));

/** (status, units) from the FIRST row of each normalised key; later rows for the same key are ignored. */
const firstByKey = (df: Frame, keyCol: string, statusCol: string, unitsCol: string): Map<string, [string, string]> => {
  const out = new Map<string, [string, string]>();
  if (df.empty || !df.has(keyCol)) return out;
  const key = normKey(text(df, keyCol));
  const status = text(df, statusCol);
  const units = text(df, unitsCol);
  key.forEach((k, i) => {
    if (k !== '' && !out.has(k)) out.set(k, [status[i], units[i]]);
  });
  return out;
};

/** First source (in order) whose key matches with a non-blank status wins. */
const matchGrn = (checks: [string[], Map<string, [string, string]>, string][]): { status: string[]; units: string[]; source: string[] } => {
  const n = checks[0][0].length;
  const status = new Array<string>(n).fill('Not Found');
  const units = new Array<string>(n).fill('0');
  const source = new Array<string>(n).fill('None');
  const done = new Array<boolean>(n).fill(false);
  for (const [raw, table, name] of checks) {
    const key = normKey(raw);
    for (let i = 0; i < n; i++) {
      if (done[i] || key[i] === '') continue;
      const hit = table.get(key[i]);
      if (!hit || hit[0] === '') continue;
      status[i] = hit[0];
      units[i] = hit[1];
      source[i] = name;
      done[i] = true;
    }
  }
  return { status, units, source };
};

const utcDay = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number | null => {
  if (m < 1 || m > 12 || d < 1 || hh > 23 || mm > 59 || ss > 59) return null;
  const t = Date.UTC(y, m - 1, d, hh, mm, ss);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? t : null;
};
const fullYear = (y: string): number => (y.length <= 2 ? 2000 + Number(y) : Number(y));

/**
 * pd.to_datetime(raw, format="%d-%m-%Y"), then anything else day-first (pandas/dateutil). The fallback covers the
 * shapes seen in the tracker exports: ISO dates (with an optional time), d/m/y with - / or . (2- or 4-digit year),
 * "1-Sep-2026", "1 Sep 2026" and "Sep 1, 2026". Epoch ms at UTC midnight (or with the time), null when unparseable.
 */
export const parseDeliveryDate = (raw: string): number | null => {
  if (raw === '') return null;
  let m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(raw);
  if (m) return utcDay(Number(m[3]), Number(m[2]), Number(m[1]));
  const time = (h?: string, mi?: string, s?: string): [number, number, number] => [Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)];
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(raw);
  if (m) return utcDay(Number(m[1]), Number(m[2]), Number(m[3]), ...time(m[4], m[5], m[6]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (m) return utcDay(fullYear(m[3]), Number(m[2]), Number(m[1]), ...time(m[4], m[5], m[6]));
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[-, ]+(\d{2}|\d{4})$/.exec(raw);
  if (m && MONTHS[m[2].toLowerCase()]) return utcDay(fullYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  m = /^([A-Za-z]{3})[A-Za-z]* (\d{1,2}),? (\d{4})$/.exec(raw);
  if (m && MONTHS[m[1].toLowerCase()]) return utcDay(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
  return null;
};

/**
 * Drop rows whose Entry Date is before settings.fromDate. Blank or unreadable Entry Dates are kept (and counted), so a
 * malformed row is never lost silently.
 */
const fromStartDate = (ctx: Context, df: Frame, what: string): Frame => {
  const from = ctx.settings.fromDate;
  if (!from || df.empty) return df;
  if (!df.has('Entry Date')) {
    ctx.log(`  WARNING start date ${from}: ${what} has no 'Entry Date' - kept all rows`);
    return df;
  }
  const [y, m, d] = from.split('-').map(Number);
  const fromMs = Date.UTC(y, m - 1, d);
  const entry = text(df, 'Entry Date').map(parseDeliveryDate);
  const keep = entry.map((t) => t === null || t >= fromMs);
  const unreadable = countTrue(entry.map((t) => t === null));
  const out = df.filter(keep);
  ctx.log(`  start date ${from}: ${what} ${fmtInt(df.length)} -> ${fmtInt(out.length)} (dropped ${fmtInt(df.length - out.length)} earlier${unreadable ? `; kept ${fmtInt(unreadable)} with a blank/unreadable Entry Date` : ''})`);
  return out;
};

/** Newest readable Entry Date of a frame (epoch ms), null when none. */
const newestEntry = (df: Frame): number | null => {
  if (df.empty || !df.has('Entry Date')) return null;
  const d = text(df, 'Entry Date').map(parseDeliveryDate).filter((t): t is number => t !== null);
  return d.length ? d.reduce((a, b) => Math.max(a, b)) : null;
};

/**
 * Shipment_Status and PO_Format exported at different times (fix plan W5): their newest Entry Dates more than
 * INPUT_ENTRY_DATE_GAP_DAYS apart means shipments without lines, or lines without a shipment. A warning only.
 */
const checkEntryDateGap = (ctx: Context, ss: Frame, pof: Frame): void => {
  const a = newestEntry(ss);
  const b = newestEntry(pof);
  if (a === null || b === null) return;
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const gap = Math.abs(a - b) / DAY_MS;
  if (gap > INPUT_ENTRY_DATE_GAP_DAYS) {
    ctx.log(`  WARNING newest Entry Date: Shipment_Status ${day(a)} vs PO_Format ${day(b)} (${Math.round(gap)} days apart) - export both in the same session`);
  }
};

const finalStatus = (df: Frame, poCodeKeys: Map<string, unknown>, todayMs: number): string[] => {
  const gu = df.get('GRN Units') as number[];
  const pnd = df.get('% GRN Pending') as number[];
  const poi = text(df, COL.ss_po_inward);
  const poiKey = normKey(poi);
  const sp = text(df, COL.ss_status_p).map((s) => s.toLowerCase());
  const sw = text(df, COL.ss_status_w).map((s) => s.toLowerCase());
  const sl = text(df, COL.ss_status_l).map((s) => s.toLowerCase());
  const pl = text(df, COL.ss_pick_list).map((s) => s.toLowerCase());
  const channel = text(df, 'Channel').map((s) => s.toLowerCase());
  const dd = text(df, COL.ss_delivery_date).map(parseDeliveryDate);
  const source = df.get('GRN Lookup Source');

  return gu.map((_, i) => {
    const foundInPo = source[i] === 'PO_Code' || source[i] === 'PO_Ref';
    const d = dd[i];
    const stale =
      GRN_DELIVERED_CHANNELS.has(channel[i]) && pnd[i] >= FULLY_PENDING && d !== null && Math.floor((todayMs - d) / DAY_MS) > DELIVERY_STALE_DAYS;
    const inwardPo = poi[i] !== '' && poCodeKeys.has(poiKey[i]);
    const cancelled = CANCEL_KW.test(sp[i]) || CANCEL_KW.test(sw[i]) || CANCEL_KW.test(sl[i]);
    // first match wins
    if (RTO_KW.test(sl[i])) return "Don't Consider";
    if (INWARD_KW.test(sw[i]) || INWARD_KW.test(sl[i])) return 'GRN Done';
    if (stale && inwardPo) return 'PO Created';
    if (stale) return 'GRN-Done(Delivered)';
    if (cancelled) return "Don't Consider";
    if (gu[i] > 0 && pnd[i] <= GRN_DONE_MAX_PENDING) return 'GRN Done';
    if (gu[i] > 0) return 'Partial GRN Done';
    if (poi[i] !== '' || foundInPo) return 'PO Created';
    if (RTS_KW.test(sw[i])) return 'RTS';
    if (DISP_KW.test(sw[i])) return 'Intransit';
    if (PKV_KW.test(pl[i])) return 'Working';
    if (HOLD_KW.test(pl[i])) return 'Working Hold';
    return 'Manual Check';
  });
};

const summary = (df: Frame): Frame => {
  const fs = df.get('Final Status');
  const tu = df.has(COL.ss_total_units) ? toNum(df.get(COL.ss_total_units)) : [];
  const uq = df.has(COL.ss_updated_qty) ? toNum(df.get(COL.ss_updated_qty)) : [];
  const row = (label: string, keep: (s: Cell) => boolean, flag: string): Cell[] => {
    const idx = fs.flatMap((s, i) => (keep(s) ? [i] : []));
    return [label, idx.length, Math.trunc(sum(idx.map((i) => tu[i] ?? 0))), Math.trunc(sum(idx.map((i) => uq[i] ?? 0))), flag];
  };
  const rows = STATUS_ORDER.map((s) => row(s, (v) => v === s, EXCLUDED.includes(s) ? 'No' : 'Yes'));
  rows.push(row('TOTAL INTRANSIT', (v) => !EXCLUDED.includes(v as string), 'TOTAL'));
  return Frame.fromRows(['Final Status', 'Shipments', 'Total Units', 'Updated Qty', 'Intransit?'], rows);
};

export const run = async (ctx: Context): Promise<void> => {
  const ssAll = await load(ctx, FILES.shipment_status, 'shipment_status');
  const pofAll = await load(ctx, FILES.po_format, 'po_format');
  checkEntryDateGap(ctx, ssAll, pofAll);
  const ss = fromStartDate(ctx, ssAll, 'Shipment_Status');
  const fk = await load(ctx, FILES.fk_grn, 'fk_grn');
  const myn = await load(ctx, FILES.myntra_grn, 'myntra_grn');
  let amz = await load(ctx, FILES.amazon_grn, 'amazon_grn');
  const po = await load(ctx, FILES.purchase_order, 'purchase_order');
  let pof = fromStartDate(ctx, pofAll, 'PO_Format');

  // Amazon_GRN lost its 'Shipment ID' column (31 Aug); the FBA id is the trailing "(...)" token of 'Shipment name'.
  if (!amz.empty && !amz.has('Shipment ID') && amz.has('Shipment name')) {
    amz = amz.set('Shipment ID', amz.get('Shipment name').map((v) => /\(([^()]*)\)\s*$/.exec(pyStr(v))?.[1] ?? null));
  }

  // PO_Format exports can end in a block of fully blank rows - drop them.
  if (!pof.empty) {
    const keyCols = [COL.pof_po, 'SKU Code', 'Quantity'].filter((c) => pof.has(c)).map((c) => stripped(pof.get(c)));
    pof = pof.filter(Array.from({ length: pof.length }, (_, i) => !keyCols.every((col) => col[i] === '')));
  }

  const poCode = firstByKey(po, COL.po_code, COL.po_grn_status, COL.po_grn_units);
  const poRef = firstByKey(po, COL.po_ref, COL.po_grn_status, COL.po_grn_units);
  const fkT = firstByKey(fk, COL.fk_po, COL.fk_grn_status, COL.fk_grn_units);
  const mynT = firstByKey(myn, COL.myn_po, COL.myn_grn_status, COL.myn_grn_units);
  const amzT = firstByKey(amz, COL.amz_po, COL.amz_grn_status, COL.amz_grn_units);

  let df = ss;
  for (const k of SS_REQUIRED) {
    if (!df.has(COL[k])) {
      df = df.set(COL[k], '');
      ctx.log(`  WARNING '${COL[k]}' missing - added blank`);
    }
  }

  const poInward = text(df, COL.ss_po_inward);
  const poNum = text(df, COL.ss_po);
  const grn = matchGrn([
    [poInward, poCode, 'PO_Code'],
    [poNum, poRef, 'PO_Ref'],
    [poNum, fkT, 'FK'],
    [poNum, mynT, 'Myntra'],
    [poNum, amzT, 'Amazon'],
  ]);
  const gu = toNum(grn.units);
  const uq = toNum(df.get(COL.ss_updated_qty));
  df = df.assign({
    'GRN Status': grn.status,
    'GRN Units': gu,
    'GRN Lookup Source': grn.source,
    '% GRN Pending': uq.map((q, i) => Math.min(1, Math.max(0, q > 0 ? (q - gu[i]) / q : 1.0))),
  });
  const [y, m, d] = ctx.settings.asOf.split('-').map(Number);
  df = df.set('Final Status', finalStatus(df, poCode, Date.UTC(y, m - 1, d)));
  const nEx = countTrue(isIn(df.get('Final Status'), EXCLUDED));
  ctx.log(`shipments: ${fmtInt(df.length)} | excluded ${fmtInt(nEx)} | in transit ${fmtInt(df.length - nEx)}`);

  // SKU-level detail: PO_Format lines joined to their shipment (first shipment per PO).
  const lookupCols = [
    COL.ss_po, 'GRN Status', 'GRN Units', '% GRN Pending', 'Final Status', COL.ss_status_p, COL.ss_status_w, COL.ss_status_l,
    COL.ss_total_units, COL.ss_updated_qty, COL.ss_pick_list, 'GRN Lookup Source',
  ].filter((c) => df.has(c));
  let ssLu = df.select(lookupCols);
  ssLu = ssLu.set('_po_join', normKey(ssLu.get(COL.ss_po))).dropDuplicates(['_po_join']);

  let report: Frame;
  if (!pof.empty && pof.has(COL.pof_po)) {
    pof = pof.set('_po_join', normKey(pof.get(COL.pof_po)));
    report = pof.mergeLeft(ssLu, ['_po_join'], ['_po_join'], ['', '_ss']).drop(['_po_join']);
    const fill = (c: string, v: Cell): Col => fillna(report.get(c), v);
    report = report.assign({
      'Final Status': fill('Final Status', 'Manual Check'),
      'GRN Status': fill('GRN Status', 'Not Found'),
      'GRN Units': fill('GRN Units', 0),
      '% GRN Pending': fill('% GRN Pending', 1.0),
    });
  } else {
    ctx.log('  WARNING PO_Format missing - using Shipment Status only');
    report = df;
  }

  ctx.set('df_intransit_stock', report.filter(isIn(report.get('Final Status'), INTRANSIT_STOCK_STATUSES)));
  const expCols = [...new Set([...ss.columns, ...['GRN Status', 'GRN Units', '% GRN Pending', 'Final Status', 'GRN Lookup Source'].filter((c) => df.has(c))])];
  ctx.set('df_full_shipment', df.select(expCols));
  ctx.set('df_summary', summary(df));
  ctx.log(`in-transit SKU lines: ${fmtInt(ctx.get('df_intransit_stock').length)}`);
};
