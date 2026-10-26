import { INTRANSIT_STOCK_STATUSES } from '../../../constants';
import { Context, fmtInt } from '../context';
import { isIn, normKey, stripped, toNum, unquoted, upper } from '../frame';
import { stripCols } from '../io';
import { dropSupersededCancellations, fillAll } from './common';

/* Split in-transit POs into those found / not found in the Export-B2B export (b2b_orders.py, legacy stageF). */

const SOURCE = 'Export-B2B Sale Orders.csv';

export const run = async (ctx: Context): Promise<void> => {
  const intr = ctx.get('df_intransit_stock_v2');
  const leaked = (intr.get('Final Status') as string[]).filter((s) => !INTRANSIT_STOCK_STATUSES.includes(s));
  if (leaked.length) throw new Error(`unexpected status leaked into Intransit_Stock: ${[...new Set(leaked)].join(', ')}`);

  const intrPo = normKey(intr.get('PO Number'));
  const lookupPo = ctx.getLookups().poKeys;
  const qualifying = new Set(intrPo);
  const found = new Set([...qualifying].filter((p) => lookupPo.has(p)));
  const notFound = new Set([...qualifying].filter((p) => !found.has(p)));

  // PO_Not_Found_in_Export_B2B: the in-transit lines themselves
  let nf = intr.filter(isIn(intrPo, notFound));
  nf = nf.assign({ 'final Intransit units': toNum(nf.get('Updated Quantity')), 'Final Planning Units': toNum(nf.get('Updated Quantity')) });
  ctx.set('df_po_not_found', nf);

  // Export_B2B_InTransit_Orders: live Export-B2B rows for the POs that ARE found
  let raw = stripCols(fillAll(await ctx.readInput(SOURCE), ''));
  raw = raw.set('Display Order Code', unquoted(raw.get('Display Order Code')));
  raw = raw.set('_po_key', normKey(raw.get('Display Order Code')));
  raw = dropSupersededCancellations(raw, raw.get('_po_key'));
  let b2b = raw.filter(isIn(raw.get('_po_key'), found));

  const full = ctx.get('df_full_shipment');
  const ship = full
    .select(['PO Number', 'Channel', 'Final Status'])
    .set('_po_key', normKey(full.get('PO Number')))
    .dropDuplicates(['_po_key'])
    .drop(['PO Number'])
    .rename({ Channel: 'Channel (Shipment Status)' });
  b2b = b2b.mergeLeft(ship, ['_po_key'], ['_po_key'], ['', '_ss']).drop(['PO Number', '_po_key']);

  for (const c of ['Allocated Quantity', 'In Process Quantity', 'Complete Quantity']) b2b = b2b.set(c, toNum(b2b.get(c)));
  const complete = upper(stripped(b2b.get('Sale Order Status'))).map((s) => s === 'COMPLETE');
  const alloc = b2b.get('Allocated Quantity') as number[];
  const inProc = b2b.get('In Process Quantity') as number[];
  const compl = b2b.get('Complete Quantity') as number[];
  b2b = b2b.set('final Intransit units', complete.map((c, i) => (c ? compl[i] : alloc[i] + inProc[i] + compl[i])));
  for (const c of ['Total Quantity', 'Cancelled Quantity']) b2b = b2b.set(c, toNum(b2b.get(c)));
  const total = b2b.get('Total Quantity') as number[];
  const cancelled = b2b.get('Cancelled Quantity') as number[];
  b2b = b2b.set('Final Planning Units', total.map((t, i) => t - cancelled[i]));
  ctx.set('df_b2b_intransit', b2b);
  ctx.log(`in-transit POs: ${fmtInt(found.size)} in Export-B2B (${fmtInt(b2b.length)} rows), ${fmtInt(notFound.size)} not found (${fmtInt(nf.length)} lines)`);
};
