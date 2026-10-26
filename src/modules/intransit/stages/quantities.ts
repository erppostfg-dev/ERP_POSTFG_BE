import { Context, fmtInt } from '../context';
import { countTrue, fillna, isNa, mapWith, normKey } from '../frame';

/* Attach Export-B2B quantities and Sale Order Status to the shipment tables (quantities.py, legacy stageB). */

export const run = async (ctx: Context): Promise<void> => {
  const L = ctx.getLookups();
  const qtyCols = L.qtyCols;

  // Full_Shipment_Enhanced: PO Number -> Display Order Code
  let full = ctx.get('df_full_shipment');
  full = full.set('_po_key', normKey(full.get('PO Number')));
  let merged = full.mergeLeft(L.po, ['_po_key'], ['PO Number'], ['', '_lu']);
  for (const c of qtyCols) merged = merged.set(c, fillna(merged.get(c), 0));
  const poKey = merged.get('_po_key');
  merged = merged.set('Sale Order Status', fillna(mapWith(poKey, L.status), ''));
  const nMatched = countTrue(poKey.map((k) => L.poKeys.has(k as string)));
  ctx.set('df_full_shipment_v2', merged.drop(['_po_key', 'PO Number_lu']));
  ctx.log(`full shipment: ${fmtInt(nMatched)} / ${fmtInt(merged.length)} rows matched an Export-B2B PO`);

  // Intransit_Stock: (PO, Channel SKU) first, then (PO, SKU)
  let it = ctx.get('df_intransit_stock');
  it = it.assign({
    _po_key: normKey(it.get('PO Number')),
    _chsku_key: normKey(it.get('Channel SKU Code')),
    _sku_key: normKey(it.get('SKU Code')),
  });
  const m1 = it.mergeLeft(L.channel, ['_po_key', '_chsku_key'], ['PO Number', 'Channel SKU Code'], ['', '_ch']);
  const m2 = it.mergeLeft(L.sku, ['_po_key', '_sku_key'], ['PO Number', 'SKU Code'], ['', '_sk']);
  const found1 = Array.from({ length: it.length }, (_, i) => qtyCols.every((c) => !isNa(m1.get(c)[i])));

  let result = it;
  for (const c of qtyCols) result = result.set(c, found1.map((f, i) => (f ? m1.get(c)[i] : m2.get(c)[i])));
  const nAny = countTrue(Array.from({ length: it.length }, (_, i) => qtyCols.some((c) => !isNa(result.get(c)[i]))));
  for (const c of qtyCols) result = result.set(c, fillna(result.get(c), 0));
  ctx.set('df_intransit_stock_v2', result.drop(['_po_key', '_chsku_key', '_sku_key']));
  ctx.log(`in-transit lines: ${fmtInt(countTrue(found1))} via channel SKU, ${fmtInt(nAny)} / ${fmtInt(it.length)} matched`);
};
