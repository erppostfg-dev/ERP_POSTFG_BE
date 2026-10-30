import fsp from 'fs/promises';
import path from 'path';
import { INTRANSIT_STOCK_STATUSES, MAIL_FILES, MARKETPLACE_CHANNELS } from '../../constants';
import { Context, fmtInt } from './context';
import { Cell, Frame, pyStr, pyStrip, toNumber } from './frame';
import { reportBucket } from './stages/final-sku';
import { whRowOf } from './stages/wh-summary';
import { ColKind, XCell, XSheet, xlsxBytes } from './xlsx-lite';

/*
 * The two files the in-transit mail carries (user, 2026-10-30), written next to each report from the build's frames:
 *   Stock.xlsx   (format of Stock-01Oct'26.xlsx)
 *     Stock        per SKU, Consider? = Yes only: Mumbai / Gurgaon / Kolkata MWH (with their city's returns), D2C (with
 *                  DarkStore), B2C (marketplaces), Manu FG ('-': no source yet), Total Stock - Final Sheet35(2)'s buckets
 *     Sheet35(2)   every row, with its WH-table row (Check Location), GMV Final = units x MRP, Cost Final = units x COGS
 *     WH Summary   the mail's table; Location Map: each Final Location + channel and its WH-table row
 *   B2C-Format-Data-Planning.xlsx   (format of B2C-Format-Data-Planning-16Oct.xlsx)
 *     the PO lines of Amazon / Flipkart / Myntra in transit (Intransit_Stock: Final Status Working, Manual Check, RTS,
 *     Intransit, Working Hold), in the planning team's columns (Inward PO stays blank, as in their sheet).
 * The attachment names carry the day: Stock-30Oct'26.xlsx, B2C-Format-Data-Planning-30Oct.xlsx.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The name a file goes out with: Stock-30Oct'26.xlsx / B2C-Format-Data-Planning-30Oct.xlsx. */
export const mailFileName = (file: string, asOf: string): string => {
  const [y, m, d] = asOf.split('-');
  const day = `${d}${MONTHS[Number(m) - 1] ?? m}`;
  return file === MAIL_FILES.STOCK ? `Stock-${day}'${y.slice(2)}.xlsx` : `${path.basename(file, '.xlsx')}-${day}.xlsx`;
};

const num = (c: Cell): number | null => toNumber(pyStr(c).replace(/,/g, '').trim());
const str = (c: Cell): string => pyStrip(pyStr(c));
const colOf = (df: Frame, c: string): readonly Cell[] => (df.has(c) ? df.get(c) : new Array<Cell>(df.length).fill(''));

// ---- Stock.xlsx --------------------------------------------------------------------------------------------------

const BUCKET_COLUMNS: [string, string][] = [
  ['MUMMWH+ReturnMUM', 'Mumbai MWH'], ['GGNMWH+ReturnGGN', 'Gurgaon MWH'], ['KOLMWH+ReturnKOL', 'Kolkata MWH'], ['D2C+DarkStore', 'D2C'], ['B2C', 'B2C'],
];
const SKU_FIELDS = ['SKU Name', 'Type', 'Count', 'MRP', 'COGS (With TAX)'];
// Count is text in the Sheet35 master (a category such as Body Scrub), so it is kept as written
const NUMERIC: Record<string, ColKind> = { MRP: 'dec', 'COGS (With TAX)': 'dec', 'Final Units': 'int' };

const stockSheet = (s35: Frame, asOf: string): XSheet => {
  const sku = colOf(s35, 'Split2 SKU').map(str);
  const consider = colOf(s35, 'Consider?').map(str);
  const ct = colOf(s35, 'Channel type').map(str);
  const loc = colOf(s35, 'Final Location').map((c) => str(c).toLowerCase());
  const units = colOf(s35, 'Final Units').map((c) => num(c) ?? 0);
  const fields = SKU_FIELDS.map((f) => colOf(s35, f));
  const bySku = new Map<string, { attrs: XCell[]; buckets: number[]; total: number }>();
  for (let i = 0; i < s35.length; i++) {
    if (consider[i] !== 'Yes' || !sku[i]) continue;
    let r = bySku.get(sku[i]);
    if (!r) {
      r = { attrs: fields.map((f, j) => (NUMERIC[SKU_FIELDS[j]] ? num(f[i]) : str(f[i]))), buckets: BUCKET_COLUMNS.map(() => 0), total: 0 };
      bySku.set(sku[i], r);
    }
    const b = BUCKET_COLUMNS.findIndex(([k]) => k === reportBucket(ct[i], loc[i]));
    if (b >= 0) r.buckets[b] += units[i];
    r.total += units[i];
  }
  return {
    name: 'Stock',
    title: `Stock as of ${asOf} (on hand + in transit; Consider? = Yes)`,
    columns: [
      { header: 'SKU Code', width: 22 }, { header: 'SKU Name', width: 50 }, { header: 'Type', width: 12 }, { header: 'Count', width: 14 },
      { header: 'MRP', kind: 'dec', width: 10 }, { header: 'COGS (With TAX)', kind: 'dec', width: 14 },
      ...BUCKET_COLUMNS.map(([, h]) => ({ header: h, kind: 'int' as ColKind })), { header: 'Manu FG', width: 10 }, { header: 'Total Stock', kind: 'int' },
    ],
    rows: [...bySku].map(([code, r]) => [code, ...r.attrs, ...r.buckets.map(Math.round), '-', Math.round(r.total)]),
  };
};

const sheet35Sheet = (s35: Frame): XSheet => {
  const cols = s35.columns;
  const ct = colOf(s35, 'Channel type').map(str);
  const loc = colOf(s35, 'Final Location').map(str);
  const units = colOf(s35, 'Final Units').map((c) => num(c) ?? 0);
  const mrp = colOf(s35, 'MRP').map((c) => num(c) ?? 0);
  const cogs = colOf(s35, 'COGS (With TAX)').map((c) => num(c) ?? 0);
  const data = cols.map((c) => s35.get(c));
  return {
    name: 'Sheet35(2)',
    columns: [
      ...cols.map((c) => ({ header: c, kind: NUMERIC[c] ?? ('text' as ColKind), width: c === 'SKU Name' ? 45 : 16 })),
      { header: 'Check Location', width: 24 }, { header: 'GMV Final', kind: 'dec' }, { header: 'Cost Final', kind: 'dec' },
    ],
    rows: Array.from({ length: s35.length }, (_, i) => [
      ...data.map((d, j) => (NUMERIC[cols[j]] ? num(d[i]) : str(d[i]))),
      whRowOf(ct[i], loc[i]) ?? '', units[i] * mrp[i], units[i] * cogs[i],
    ]),
  };
};

const whSheets = (ctx: Context, s35: Frame): XSheet[] => {
  const keys = new Map<string, XCell[]>();
  const [loc, ch, ct] = ['Final Location', 'Channel Name', 'Channel type'].map((c) => colOf(s35, c).map(str));
  for (let i = 0; i < s35.length; i++) {
    const k = `${loc[i]}\u0000${ch[i]}\u0000${ct[i]}`;
    if (!keys.has(k)) keys.set(k, [loc[i], ch[i], ct[i], whRowOf(ct[i], loc[i]) ?? '(not in the table)']);
  }
  return [
    {
      name: 'WH Summary',
      title: `Stock on hand + in transit as of ${ctx.settings.asOf}`,
      columns: [{ header: 'WHs', width: 26 }, { header: 'GMV', kind: 'int', width: 16 }, { header: 'Units', kind: 'int' }, { header: 'COGS (With Tax)', kind: 'int', width: 16 }, { header: 'COGS Split', kind: 'pct' }],
      rows: (ctx.whSummary ?? []).map((r) => [r.wh, r.gmv, r.units, r.cogs, r.cogsSplit]),
    },
    {
      name: 'Location Map',
      columns: [{ header: 'Final Location' }, { header: 'Channel Name' }, { header: 'Channel type' }, { header: 'WHs', width: 26 }],
      rows: [...keys.values()].sort((a, b) => String(a[3]).localeCompare(String(b[3])) || String(a[0]).localeCompare(String(b[0]))),
    },
  ];
};

// ---- B2C-Format-Data-Planning.xlsx -------------------------------------------------------------------------------

const B2C_COLUMNS = [
  'Channel', 'Location', 'PO Number', 'Brand', 'Sr No', 'SKU Name', 'SKU Code', 'Channel SKU Code', 'Quantity', 'GMV', 'PO Value', 'Inward PO',
  'Updated Quantity', 'Updated GMV', 'Updated PO Value', 'Product Weight', 'Working Date', 'Dispatch Date', 'Current Appointment Date',
  'Status Planning', 'Status Warehouse', 'Status Logistics', 'Final Status',
];
const B2C_NUMERIC: Record<string, ColKind> = {
  'Sr No': 'int', Quantity: 'int', GMV: 'dec', 'PO Value': 'dec', 'Updated Quantity': 'int', 'Updated GMV': 'dec', 'Updated PO Value': 'dec', 'Product Weight': 'dec',
};

const b2cSheet = (stock: Frame): XSheet => {
  const channels = new Set(MARKETPLACE_CHANNELS.map((c) => c.toLowerCase()));
  const statuses = new Set(INTRANSIT_STOCK_STATUSES);
  const channel = colOf(stock, 'Channel').map(str);
  const status = colOf(stock, 'Final Status').map(str);
  const data = B2C_COLUMNS.map((c) => colOf(stock, c));
  const rows: XCell[][] = [];
  for (let i = 0; i < stock.length; i++) {
    if (!channels.has(channel[i].toLowerCase()) || !statuses.has(status[i])) continue;
    rows.push(data.map((d, j) => (B2C_NUMERIC[B2C_COLUMNS[j]] ? num(d[i]) : str(d[i]))));
  }
  return { name: 'Sheet1', columns: B2C_COLUMNS.map((h) => ({ header: h, kind: B2C_NUMERIC[h] ?? 'text', width: h === 'SKU Name' ? 45 : 16 })), rows };
};

/** Write both files into `outDir`; returns their names. */
export const writeMailFiles = async (ctx: Context, outDir: string): Promise<string[]> => {
  const s35 = ctx.get('df_sheet35');
  const stock = stockSheet(s35, ctx.settings.asOf);
  const b2c = b2cSheet(ctx.get('df_intransit_stock'));
  await fsp.writeFile(path.join(outDir, MAIL_FILES.STOCK), xlsxBytes([stock, sheet35Sheet(s35), ...whSheets(ctx, s35)]));
  await fsp.writeFile(path.join(outDir, MAIL_FILES.B2C), xlsxBytes([b2c]));
  ctx.log(`mail files: ${MAIL_FILES.STOCK} (${fmtInt(stock.rows.length)} SKUs), ${MAIL_FILES.B2C} (${fmtInt(b2c.rows.length)} PO lines)`);
  return [MAIL_FILES.STOCK, MAIL_FILES.B2C];
};
