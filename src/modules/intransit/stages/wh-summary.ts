import { Context, fmtInt } from '../context';
import { Cell, Frame, pyStr, toNumber } from '../frame';

/*
 * WH summary (user, 2026-10-29; the table the in-transit mail will carry): GMV, units and COGS of the stock on hand +
 * in transit, per warehouse row, from Sheet35(2) - only rows marked Consider? = Yes (the SKU-Not To Consider list left
 * out, as the team's own table). GMV = Final Units x MRP, COGS (With Tax) = Final Units x COGS (With TAX), COGS Split =
 * the row's share of the total COGS. Sheet35(2) holds a city (Final Location), not a facility, so the rows are:
 *   MWH - Delhivery GGN      Channel type GGNMWH, and Return in Gurgaon
 *   D2C WH - Delhivery GGN   D2C in Gurgaon
 *   MWH - Delhivery MUM      MUMMWH, and Return in Mumbai
 *   D2C WH - Delhivery MUM   D2C in Mumbai
 *   D2C WH - SR & DL         every other D2C row (Gurgaon-SR, HYP_*, the other cities)
 *   DarkStore                DarkStore
 *   B2C (Amazon/FK/Myntra)   B2C
 * KOL MWH is not shown (user). A SKU with no MRP / COGS in the Sheet35 master counts in Units only (logged).
 */

export const WH_ROWS = [
  'MWH - Delhivery GGN', 'D2C WH - Delhivery GGN', 'MWH - Delhivery MUM', 'D2C WH - Delhivery MUM', 'D2C WH - SR & DL', 'DarkStore',
  'B2C (Amazon/FK/Myntra)',
] as const;
export type WhRow = (typeof WH_ROWS)[number];

export interface WhSummaryRow {
  wh: WhRow;
  gmv: number;
  units: number;
  cogs: number;
  /** Share of the total COGS, 0..1. */
  cogsSplit: number;
}

export const WH_COLUMNS = ['WHs', 'GMV', 'Units', 'COGS (With Tax)', 'COGS Split'] as const;

/** The row a Sheet35(2) line counts in (null = not shown). */
export const whRowOf = (channelType: string, location: string): WhRow | null => {
  const ct = channelType.trim();
  const loc = location.trim().toLowerCase();
  if (ct === 'GGNMWH' || (ct === 'Return' && loc === 'gurgaon')) return 'MWH - Delhivery GGN';
  if (ct === 'MUMMWH' || (ct === 'Return' && loc === 'mumbai')) return 'MWH - Delhivery MUM';
  if (ct === 'D2C' && loc === 'gurgaon') return 'D2C WH - Delhivery GGN';
  if (ct === 'D2C' && loc === 'mumbai') return 'D2C WH - Delhivery MUM';
  if (ct === 'D2C') return 'D2C WH - SR & DL';
  if (ct === 'DarkStore') return 'DarkStore';
  if (ct === 'B2C') return 'B2C (Amazon/FK/Myntra)';
  return null;
};

const num = (c: Cell): number => toNumber(pyStr(c).replace(/,/g, '')) ?? 0;

export const whSummary = (s35: Frame): { rows: WhSummaryRow[]; unpricedUnits: number } => {
  const acc = new Map<WhRow, { gmv: number; units: number; cogs: number }>(WH_ROWS.map((r) => [r, { gmv: 0, units: 0, cogs: 0 }]));
  const col = (c: string): readonly Cell[] => (s35.has(c) ? s35.get(c) : new Array<Cell>(s35.length).fill(''));
  const [ct, loc, consider, units, mrp, cogs] = ['Channel type', 'Final Location', 'Consider?', 'Final Units', 'MRP', 'COGS (With TAX)'].map(col);
  let unpricedUnits = 0;
  for (let i = 0; i < s35.length; i++) {
    if (pyStr(consider[i]).trim() !== 'Yes') continue;
    const row = whRowOf(pyStr(ct[i]), pyStr(loc[i]));
    if (!row) continue;
    const u = num(units[i]);
    const price = num(mrp[i]);
    if (u && !price) unpricedUnits += u;
    const a = acc.get(row)!;
    a.units += u;
    a.gmv += u * price;
    a.cogs += u * num(cogs[i]);
  }
  const total = [...acc.values()].reduce((t, a) => t + a.cogs, 0);
  const rows = WH_ROWS.map((wh) => {
    const a = acc.get(wh)!;
    return { wh, gmv: Math.round(a.gmv), units: Math.round(a.units), cogs: Math.round(a.cogs), cogsSplit: total ? a.cogs / total : 0 };
  });
  return { rows, unpricedUnits: Math.round(unpricedUnits) };
};

/** The workbook's WH_Summary sheet. */
export const whSummaryFrame = (rows: WhSummaryRow[]): Frame =>
  Frame.fromRows([...WH_COLUMNS], rows.map((r) => [r.wh, r.gmv, r.units, r.cogs, `${(r.cogsSplit * 100).toFixed(1)}%`]));

export const run = async (ctx: Context): Promise<void> => {
  const { rows, unpricedUnits } = whSummary(ctx.get('df_sheet35'));
  ctx.whSummary = rows;
  ctx.set('df_wh_summary', whSummaryFrame(rows));
  ctx.log(`  WH summary: ${rows.map((r) => `${r.wh} ${fmtInt(r.units)}`).join(' | ')}`);
  if (unpricedUnits) ctx.log(`  WH summary: ${fmtInt(unpricedUnits)} units have no MRP / COGS in the Sheet35 master (counted in Units only)`);
};
