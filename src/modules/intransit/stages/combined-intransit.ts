import { FACILITY_TO_GROUP, TEST_FACILITY } from '../../../constants';
import { Context, fmtInt } from '../context';
import { Cell, countTrue, fillna, Frame, keyOf, mapWith, not, pyStr, pyStrip, stripped, toNum } from '../frame';
import { stripCols } from '../io';
import { fillAll } from './common';

/* Combined_InTransit_Units: every in-transit source in one fixed layout (combined_intransit.py, legacy stageH). */

const TARGET_COLS = [
  'Entry Date', 'PO Date', 'Facility', 'Channel', 'Location', 'PO Number', 'Brand', 'Sr No', 'SKU Name', 'SKU Code', 'Channel SKU Code',
  'Quantity', 'GMV', 'PO Value', 'Updated Quantity', 'Updated GMV', 'Updated PO Value', 'Product Weight', 'Working Date', 'Dispatch Date',
  'Current Appointment Date', 'Status Planning', 'Status Warehouse', 'Status Logistics', 'Status (Planning)', 'Status (Warehouse)',
  'Status (Logistics)', 'Final Status', 'final Intransit units', 'Source', 'Final Planning Units',
];
/** Operational fields backfilled onto Export-B2B rows from Intransit_Stock. */
const LOOKUP_FIELDS = TARGET_COLS.filter(
  (c) => !['PO Number', 'SKU Code', 'Channel SKU Code', 'Final Status', 'final Intransit units', 'Source', 'Final Planning Units'].includes(c),
);
/** Attributes of the PO itself (safe to take from any line of the same PO). */
const PO_LEVEL_FIELDS = LOOKUP_FIELDS.filter(
  (c) => !['Sr No', 'SKU Name', 'Quantity', 'GMV', 'PO Value', 'Updated Quantity', 'Updated GMV', 'Updated PO Value', 'Product Weight'].includes(c),
);
const ALLOWED_CHANNELS = ['GGN_WAREHOUSE', 'Amazon', 'Myntra', 'McaffeineB2C', 'HYP_Website', 'MUM_WAREHOUSE2', 'Flipkart'];
/** Ambiguous statuses: kept only when backed by a positive-quantity sale order. */
const HOLD_MANUAL = new Set(['working hold', 'manual check']);

const SRC_NOT_FOUND = 'PO_Not_Found_in_Export_B2B';
const SRC_B2B = 'Export_B2B_InTransit_Orders';
const SRC_PO = 'Purchase_Order';

/** key -> the field values of the first row of each key. */
const lookup = (frame: Frame, keyCols: string[], fields: string[]): Map<string, Cell[]> => {
  const out = new Map<string, Cell[]>();
  const keys = frame.keys(keyCols);
  const data = fields.map((f) => frame.get(f));
  keys.forEach((k, i) => {
    if (!out.has(k)) out.set(k, data.map((d) => d[i]));
  });
  return out;
};

const lowerKey = (col: readonly Cell[]): string[] => col.map((c) => pyStrip(pyStr(c)).toLowerCase());

/**
 * Operational fields for each Export-B2B row: match on (PO, channel SKU), then (PO, SKU), then PO-only attributes.
 * Unmatched fields stay None.
 */
const backfill = (ctx: Context, b2bOut: Frame, intr: Frame): Frame => {
  const it = intr.assign({ _po: lowerKey(intr.get('PO Number')), _ch: lowerKey(intr.get('Channel SKU Code')), _sku: lowerKey(intr.get('SKU Code')) });
  const byCh = lookup(it, ['_po', '_ch'], LOOKUP_FIELDS);
  const bySku = lookup(it, ['_po', '_sku'], LOOKUP_FIELDS);
  const byPo = lookup(it, ['_po'], PO_LEVEL_FIELDS);

  const noneRow: Cell[] = LOOKUP_FIELDS.map(() => undefined);
  const poPos = PO_LEVEL_FIELDS.map((f) => LOOKUP_FIELDS.indexOf(f));
  const n = { 'channel-sku': 0, sku: 0, 'PO-level': 0 };
  const po = (b2bOut.get('PO Number') as string[]).map((s) => s.toLowerCase());
  const ch = (b2bOut.get('Channel SKU Code') as string[]).map((s) => s.toLowerCase());
  const sku = (b2bOut.get('SKU Code') as string[]).map((s) => s.toLowerCase());
  const rows = po.map((p, i): Cell[] => {
    let rec = byCh.get(keyOf([p, ch[i]]));
    if (rec) {
      n['channel-sku']++;
      return rec;
    }
    rec = bySku.get(keyOf([p, sku[i]]));
    if (rec) {
      n.sku++;
      return rec;
    }
    const poRec = byPo.get(keyOf([p]));
    if (poRec) {
      n['PO-level']++;
      const r = [...noneRow];
      poPos.forEach((pos, j) => (r[pos] = poRec[j]));
      return r;
    }
    return noneRow;
  });
  const matched = n['channel-sku'] + n.sku + n['PO-level'];
  ctx.log(`  backfilled: {'channel-sku': ${n['channel-sku']}, 'sku': ${n.sku}, 'PO-level': ${n['PO-level']}} | unmatched ${fmtInt(rows.length - matched)}`);
  return Frame.fromRows(LOOKUP_FIELDS, rows);
};

/**
 * Open purchase orders (status CREATED) as in-transit rows. Not cut by the start date: an open PO is expected stock
 * however old it is (user, 2026-10-21).
 */
const purchaseOrders = async (ctx: Context): Promise<Frame> => {
  let po = stripCols(fillAll(await ctx.readInput('Purchase_Order.csv'), ''));
  po = po.filter(stripped(po.get('Purchase Order Status')).map((s) => s.toUpperCase() === 'CREATED'));
  po = po.filter(stripped(po.get('Facility')).map((s) => s.toUpperCase() !== TEST_FACILITY));

  const fac = stripped(po.get('Facility'));
  const qty = toNum(po.get('Order Quantity'));
  const poValue = toNum(po.get('Total'));
  let out = Frame.from(Object.fromEntries(TARGET_COLS.map((c) => [c, ''])), po.length);
  out = out.assign({
    'Entry Date': po.get('Created'),
    'PO Date': po.get('Created'),
    Facility: fac,
    Channel: fillna(mapWith(fac.map((f) => f.toLowerCase()), FACILITY_TO_GROUP), fac),
    Location: fac,
    'PO Number': stripped(po.get('PO Code')),
    'SKU Name': po.get('Item Type Name'),
    'SKU Code': stripped(po.get('Item SkuCode')),
    'Channel SKU Code': stripped(po.get('Item SkuCode')),
    Quantity: qty,
    'Updated Quantity': qty,
    'PO Value': poValue,
    'Updated PO Value': poValue,
    'Current Appointment Date': po.get('Delivery Date'),
    'Final Status': 'PO Created',
    'final Intransit units': qty,
    'Final Planning Units': qty,
    Source: SRC_PO,
  });
  return out.select(TARGET_COLS);
};

export const run = async (ctx: Context): Promise<void> => {
  const nf = ctx.get('df_po_not_found').select(TARGET_COLS.filter((c) => c !== 'Source')).set('Source', SRC_NOT_FOUND);

  const b2b = ctx.get('df_b2b_intransit');
  let b2bOut = Frame.from({
    'PO Number': stripped(b2b.get('Display Order Code')),
    'SKU Code': stripped(b2b.get('Item SKU Code')),
    'Channel SKU Code': stripped(b2b.get('Channel Product ID')),
    'Final Status': b2b.get('Final Status'),
    'final Intransit units': b2b.get('final Intransit units'),
    'Final Planning Units': b2b.get('Final Planning Units'),
    Source: SRC_B2B,
  }, b2b.length);
  const filled = backfill(ctx, b2bOut, ctx.get('df_intransit_stock_v2'));
  b2bOut = b2bOut.assign(Object.fromEntries(filled.columns.map((c) => [c, filled.get(c)]))).select(TARGET_COLS);

  let combined = Frame.concat([nf, b2bOut]);
  const status = stripped(combined.get('Final Status')).map((s) => s.toLowerCase());
  const source = combined.get('Source');
  const units = toNum(combined.get('final Intransit units'));
  const keep = status.map((s, i) => !HOLD_MANUAL.has(s) || (source[i] === SRC_B2B && units[i] > 0));
  combined = combined.filter(keep);
  const allowed = new Set(ALLOWED_CHANNELS.map((c) => c.toLowerCase()));
  combined = combined.filter(stripped(combined.get('Channel')).map((c) => allowed.has(c.toLowerCase())));
  ctx.log(`  dropped ${fmtInt(countTrue(not(keep)))} unbacked hold/manual rows; ${fmtInt(combined.length)} rows after channel filter`);

  const poRows = await purchaseOrders(ctx);
  ctx.set('df_combined_intransit', Frame.concat([combined, poRows]));
  ctx.log(`combined in-transit: ${fmtInt(combined.length + poRows.length)} rows (${fmtInt(poRows.length)} open purchase orders)`);
};
