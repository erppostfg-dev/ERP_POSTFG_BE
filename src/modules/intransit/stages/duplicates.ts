import { Context, fmtInt } from '../context';
import { fillna, isIn, normKey, stripped, unquoted, upper } from '../frame';
import { stripCols } from '../io';
import { fillAll, yesNo } from './common';

/* Duplicate_PO_Report: Purchase_Order lines sharing SKU | Reference No | ReferenceOrder (duplicates.py, legacy stageD). */

const SOURCE = 'Purchase_Order.csv';
const EXCLUDE_STATUS = ['CANCELLED', 'AMENDED', 'REJECTED'];
const EXCLUDE_FACILITIES = ['Return_MUM2', 'Return_GGN', 'TEST_FACILITY'];
/** References Excel turned into scientific notation make the UID unreliable. */
const SCI_NOTATION = /^\d(?:\.\d+)?E\+\d+$/i;

export const run = async (ctx: Context): Promise<void> => {
  let df = stripCols(fillAll(await ctx.readInput(SOURCE), ''));
  const origCols = [...df.columns];

  df = df.set('Purchase Order Status', stripped(df.get('Purchase Order Status')));
  let kept = df.filter(upper(df.get('Purchase Order Status') as string[]).map((s) => !EXCLUDE_STATUS.includes(s)));
  const excl = new Set(EXCLUDE_FACILITIES.map((f) => f.toLowerCase()));
  kept = kept.filter(stripped(kept.get('Facility')).map((f) => !excl.has(f.toLowerCase())));

  kept = kept.assign({
    _sku: unquoted(kept.get('Item SkuCode')),
    _refno: unquoted(kept.get('Reference No')),
    _reforder: unquoted(kept.get('ReferenceOrder')),
  });
  let valid = kept.filter(Array.from({ length: kept.length }, (_, i) => ['_sku', '_refno', '_reforder'].every((c) => kept.get(c)[i] !== '')));
  valid = valid.set('Duplicate UID', valid.get('_sku').map((s, i) => `${s} | ${valid.get('_refno')[i]} | ${valid.get('_reforder')[i]}`));

  const counts = new Map<string, number>();
  for (const uid of valid.get('Duplicate UID') as string[]) counts.set(uid, (counts.get(uid) ?? 0) + 1);
  const dupIds = new Set([...counts].filter(([, n]) => n > 1).map(([uid]) => uid));
  let dups = valid.filter(isIn(valid.get('Duplicate UID'), dupIds));
  dups = dups.set('Duplicate Count', (dups.get('Duplicate UID') as string[]).map((u) => counts.get(u) ?? 0));
  dups = dups.sortValues(['Duplicate Count', 'Duplicate UID', 'PO Code'], [false, true, true]);
  dups = dups.set('Ref Sci-Notation?', yesNo(dups.get('_refno').map((r, i) => SCI_NOTATION.test(r as string) || SCI_NOTATION.test(dups.get('_reforder')[i] as string))));

  const full = ctx.get('df_full_shipment');
  const ship = full
    .select(['PO Number', 'Final Status'])
    .set('_po_key', normKey(full.get('PO Number')))
    .dropDuplicates(['_po_key'])
    .drop(['PO Number'])
    .rename({ 'Final Status': 'Final Status (Shipment Status)' });
  dups = dups.set('_reforder_key', normKey(dups.get('_reforder')));
  dups = dups.mergeLeft(ship, ['_reforder_key'], ['_po_key']);
  dups = dups.set('Final Status (Shipment Status)', fillna(dups.get('Final Status (Shipment Status)'), 'Not Found'));

  ctx.set('df_dup_report', dups.select(['Duplicate UID', 'Duplicate Count', 'Ref Sci-Notation?', 'Final Status (Shipment Status)', ...origCols]));
  ctx.log(`duplicate UIDs: ${fmtInt(dupIds.size)} covering ${fmtInt(dups.length)} PO lines`);
};
