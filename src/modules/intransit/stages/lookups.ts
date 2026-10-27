import { Context, fmtInt } from '../context';
import { Frame, normKey, stripped, toNum, unquoted } from '../frame';
import { dropSupersededCancellations } from './common';

/* Quantity and status lookups from the Export-B2B sale order export (lookups.py, legacy stage1). */

const SOURCE = 'Export-B2B Sale Orders.csv';
export const QTY_COLS = [
  'Unallocated Quantity', 'Unfulfillable Quantity', 'Allocated Quantity', 'Cancelled Quantity', 'In Process Quantity', 'Complete Quantity',
];
const KEY_COLS = ['Display Order Code', 'Item SKU Code', 'Channel Product ID'];

/** groupby(keys)[QTY_COLS].sum() as a frame named by `names` (the lookup frames quantities.py merges on). */
const sumBy = (df: Frame, keys: string[], names: string[]): Frame =>
  df.groupBy(keys).agg(Object.fromEntries(QTY_COLS.map((c) => [c, [c, 'sum']]))).rename(Object.fromEntries(keys.map((k, i) => [k, names[i]])));

export const run = async (ctx: Context): Promise<void> => {
  let df = (await ctx.readInput(SOURCE)).select(['Sale Order Code', ...KEY_COLS, 'Sale Order Status', ...QTY_COLS]);
  for (const c of QTY_COLS) df = df.set(c, toNum(df.get(c)));
  for (const c of KEY_COLS) df = df.set(c, normKey(df.get(c)));
  df = df.set('Sale Order Code', unquoted(df.get('Sale Order Code')));
  df = df.set('Sale Order Status', stripped(df.get('Sale Order Status')));

  const n = df.length;
  df = dropSupersededCancellations(df, df.get('Display Order Code'));
  ctx.log(`Export-B2B: ${fmtInt(n)} rows, dropped ${fmtInt(n - df.length)} superseded cancelled sale orders`);

  // A PO can keep several live statuses: keep every distinct value, comma-joined.
  const withStatus = df.filter(df.get('Sale Order Status').map((s) => s !== '' && s !== 'nan'));
  const statusVals = withStatus.get('Sale Order Status');
  const status = new Map<string, string>();
  for (const g of withStatus.groupBy(['Display Order Code']).groups) {
    const vals = [...new Set(g.rows.map((i) => statusVals[i] as string))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    status.set(g.key[0] as string, vals.join(', '));
  }

  const po = sumBy(df, ['Display Order Code'], ['PO Number']);
  ctx.lookups = {
    po,
    channel: sumBy(df, ['Display Order Code', 'Channel Product ID'], ['PO Number', 'Channel SKU Code']),
    sku: sumBy(df, ['Display Order Code', 'Item SKU Code'], ['PO Number', 'SKU Code']),
    poKeys: new Set(po.get('PO Number') as string[]),
    status,
    qtyCols: QTY_COLS,
  };
  ctx.log(`lookups: ${fmtInt(po.length)} POs, ${fmtInt(status.size)} with a status`);
};
