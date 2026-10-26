import { FACILITY_GROUPS } from '../../../constants';
import { Context, fmtInt } from '../context';
import {
  canonValues, Col, fillna, Frame, keyOf, mapWith, pyStr, roundHalfEven, stripped, stripText as s, sum, toNumber, toNumeric, unquoted,
} from '../frame';
import { cleanCols } from '../io';

/* Stock on hand per channel/facility, combined with in-transit units (inventory.py, legacy stageI). */

const OUT_COLS = ['Channel SKU Code', 'SKU Code', 'SKU Name', 'Fulfilment Centre', 'Final Location', 'Channel Name', 'Channel type', 'Stock Type', 'Final Units'];
export const KEY = OUT_COLS.slice(0, -1);
const CANON_COLS = ['Channel SKU Code', 'SKU Code', 'Fulfilment Centre', 'Final Location', 'Channel Name', 'Channel type', 'Stock Type'];

/** Amazon removal/liquidation sites - not fulfilment centres. */
const AMZ_EXCLUDE_LOCATIONS = new Set(['rso6', 'rso7', 'rso8', 'rsoc']);
/** D2C facilities whose Stock In Transfer counts as stock. */
const D2C_SIT_FACILITIES = new Set(['mcaff_gurgaon3', 'mcaff_mumbai2']);
const FACILITY_LOCATION_OVERRIDE = new Map([
  ['mum_warehouse2', 'mumbai'], ['ggn_warehouse', 'gurgaon'], ['hyp_b2b_ggn', 'gurgaon'],
  ['hyp_b2b_mum2', 'mumbai'], ['return_mum2', 'mumbai'], ['return_ggn', 'gurgaon'],
]);
/** Warehouses reported under their own channel (name and type) instead of "MWH". */
const FC_CHANNEL_OVERRIDE = new Map([
  ['hyp_b2b_mum2', 'MUMMWH'], ['mum_warehouse2', 'MUMMWH'], ['mumbai', 'MUMMWH'],
  ['ggn_warehouse', 'GGNMWH'], ['hyp_b2b_ggn', 'GGNMWH'], ['gurgaon', 'GGNMWH'],
  // the Kolkata warehouse (Beyond-KOL), reported as KOLMWH at Final Location KOL_WAREHOUSE as in the reference report
  ['kol_warehouse', 'KOLMWH'],
]);
/** Bare city names are also Myntra WH locations: they only override rows that already belong to a warehouse channel. */
const CITY_FC = new Set(['mumbai', 'gurgaon']);
const WAREHOUSE_CHANNELS = new Set(['ggn_warehouse', 'mum_warehouse2', 'ggnmwh', 'mummwh', '']);
const CHANNEL_TYPE = new Map([
  ['flipkart', 'B2C'], ['amazon', 'B2C'], ['myntra', 'B2C'], ['d2c', 'D2C'], ['darkstore', 'DarkStore'], ['return', 'Return'],
  ['ggnmwh', 'MWH'], ['mummwh', 'MWH'], ['ggn_warehouse', 'MWH'], ['mum_warehouse2', 'MWH'], ['mcaffeineb2c', 'D2C'], ['hyp_website', 'D2C'],
  ['kolmwh', 'MWH'], ['kol_warehouse', 'MWH'],
  // D2C facilities added in Uniware in Oct 2026: their POs keep the facility as Channel Name (reference report)
  ['mcaff_kolkata3', 'D2C'], ['mcaff_hyderabad3', 'D2C'], ['hyp_byhyd', 'D2C'],
]);
const MARKETPLACES = new Set(['amazon', 'flipkart', 'myntra']);
const SCI_NOTATION_RE = /^\d+(\.\d+)?E\+\d+$/i;

export const readClean = async (ctx: Context, name: string): Promise<Frame> => cleanCols(await ctx.readInput(name));

const lowerAll = (col: readonly string[]): string[] => col.map((v) => v.toLowerCase());

/** io.num_col: numeric column tolerant of thousands separators; 0 if the column is absent. */
const numCol = (df: Frame, col: string): number[] =>
  df.has(col) ? df.get(col).map((c) => toNumber(pyStr(c).replace(/,/g, '').trim()) ?? 0) : new Array<number>(df.length).fill(0);

/** lower-cased SKU -> Item Type Name from the Export-Inventory Snapshot. */
export const skuNameMap = (ex: Frame): Map<string, string> => {
  const k = lowerAll(s(ex.get('Item SkuCode')));
  const v = s(ex.get('Item Type Name'));
  const out = new Map<string, string>();
  k.forEach((key, i) => {
    if (key !== '' && v[i] !== '' && !out.has(key)) out.set(key, v[i]);
  });
  return out;
};

/** (resolved SKU, missing mask). Falls back to the source's own SKU column. */
const mapChannelSku = (skuMap: Map<string, string>, channelSku: Col, nativeSku: Col): [Col, boolean[]] => {
  const mapped = mapWith(lowerAll(unquoted(channelSku)), skuMap);
  return [fillna(mapped, nativeSku), mapped.map((m) => m === null)];
};

interface Part {
  frame: Frame;
  skuMissing: boolean[];
  facMissing: boolean[];
}

const sohFrame = (csku: Col, sku: Col, name: Col | string, fc: Col, channel: string, units: number[]): Frame =>
  Frame.from({
    'Channel SKU Code': csku, 'SKU Code': sku, 'SKU Name': name, 'Fulfilment Centre': fc, 'Channel Name': channel, 'Channel type': 'B2C',
    'Stock Type': 'SOH', 'Final Units': units,
  }, csku.length);

const none = (n: number): boolean[] => new Array<boolean>(n).fill(false);

const marketplaceSoh = async (ctx: Context, skuMap: Map<string, string>): Promise<Part[]> => {
  const out: Part[] = [];
  const fk = await readClean(ctx, 'FK_SOH.csv');
  let csku: Col = s(fk.get('FSN'));
  let [sku, miss] = mapChannelSku(skuMap, csku, s(fk.get('SKU')));
  out.push({ frame: sohFrame(csku, sku, s(fk.get('Title')), s(fk.get('Warehouse Id')), 'Flipkart', numCol(fk, 'Live on Website')), skuMissing: miss, facMissing: none(fk.length) });

  let az = await readClean(ctx, 'Amazon_SOH.csv');
  // Only sellable stock, and not at removal sites (dropped here, before Location Master maps them onto Final Locations
  // shared with real FCs).
  az = az.filter(s(az.get('Disposition')).map((d) => d.toUpperCase() === 'SELLABLE'));
  az = az.filter(s(az.get('Location')).map((l) => !AMZ_EXCLUDE_LOCATIONS.has(l.toLowerCase())));
  csku = s(az.get('FNSKU'));
  [sku, miss] = mapChannelSku(skuMap, csku, s(az.get('MSKU')));
  out.push({ frame: sohFrame(csku, sku, s(az.get('Title')), s(az.get('Location')), 'Amazon', numCol(az, 'Ending Warehouse Balance')), skuMissing: miss, facMissing: none(az.length) });

  let my = await readClean(ctx, 'Myntra_SOH.csv');
  my = my.filter(s(my.get('po_type')).map((t) => t.toUpperCase() === 'SJIT'));
  const whm = await readClean(ctx, 'MyntraWHIDs.csv');
  const whId = s(whm.get('WH Id'));
  const whLoc = s(whm.get('WH location'));
  const whMap = new Map<string, string>();
  whId.forEach((id, i) => whMap.set(id.toLowerCase(), whLoc[i])); // keep="last"
  const wh = s(my.get('warehouse id'));
  const fac = mapWith(lowerAll(wh), whMap);
  csku = s(my.get('sku code'));
  [sku, miss] = mapChannelSku(skuMap, csku, s(my.get('seller sku code')));
  out.push({ frame: sohFrame(csku, sku, '', fillna(fac, wh), 'Myntra', numCol(my, 'inventory count')), skuMissing: miss, facMissing: fac.map((f) => f === null) });
  ctx.log(`  marketplace SOH rows: ${fmtInt(out.reduce((n, p) => n + p.frame.length, 0))}`);
  return out;
};

const facilitySoh = (ex: Frame): Part[] => {
  const inv = numCol(ex, 'Inventory');
  const putw = numCol(ex, 'Putaway Pending');
  const opur = numCol(ex, 'Open Purchase');
  const sit = numCol(ex, 'Stock In Transfer');
  const osal = numCol(ex, 'Open Sale');
  const facl = ex.get('_facl') as string[];
  const units: Record<string, (i: number) => number> = {
    D2C: (i) => (D2C_SIT_FACILITIES.has(facl[i]) ? inv[i] + putw[i] + opur[i] + sit[i] - osal[i] : inv[i] + putw[i] + opur[i] - osal[i]),
    DarkStore: (i) => inv[i] + putw[i] + opur[i] + sit[i] - osal[i],
    GGNMWH: (i) => inv[i] + putw[i] + opur[i] + sit[i],
    MUMMWH: (i) => inv[i] + putw[i] + opur[i] + sit[i],
    Return: (i) => inv[i], // returned stock physically held: bare Inventory only
  };
  const out: Part[] = [];
  for (const [group, ctype, facs] of FACILITY_GROUPS) {
    const lowerFacs = new Set(facs.map((f) => f.toLowerCase()));
    const idx = facl.flatMap((f, i) => (lowerFacs.has(f) ? [i] : []));
    if (!idx.length) continue;
    const sub = ex.take(idx);
    const g = Frame.from({
      'Channel SKU Code': s(sub.get('Item SkuCode')), 'SKU Code': s(sub.get('Item SkuCode')), 'SKU Name': s(sub.get('Item Type Name')),
      'Fulfilment Centre': sub.get('_fac'), 'Channel Name': group, 'Channel type': ctype, 'Stock Type': 'SOH', 'Final Units': idx.map(units[group]),
    }, idx.length);
    out.push({ frame: g, skuMissing: none(g.length), facMissing: none(g.length) });
  }
  return out;
};

type Resolver = (channel: Col, fc: Col) => [Col, boolean[]];

const locationResolver = (lm: Frame): Resolver => {
  const ch = lowerAll(s(lm.get('Channel')));
  const fc = lowerAll(s(lm.get('Fulfillment Centre-ID')));
  const loc = s(lm.get('Final Location'));
  const byPair = new Map<string, string>();
  const byFc = new Map<string, string>();
  loc.forEach((l, i) => {
    if (l === '') return;
    const k = keyOf([ch[i], fc[i]]);
    if (!byPair.has(k)) byPair.set(k, l);
    if (!byFc.has(fc[i])) byFc.set(fc[i], l);
  });
  /** override -> (channel, FC) -> FC -> the FC itself. Returns (location, unresolved mask). */
  return (channel, fcCol) => {
    const kCh = lowerAll(stripped(channel));
    const kFc = lowerAll(stripped(fcCol));
    const res = kFc.map((f, i) => FACILITY_LOCATION_OVERRIDE.get(f) ?? byPair.get(keyOf([kCh[i], f])) ?? byFc.get(f) ?? null);
    return [fillna(res, fcCol), res.map((r) => r === null)];
  };
};

const applyFcOverride = (df: Frame): Frame => {
  const k = lowerAll(stripped(df.get('Fulfilment Centre')));
  const ch = lowerAll(stripped(df.get('Channel Name')));
  const hit = k.map((f, i) => FC_CHANNEL_OVERRIDE.has(f) && (!CITY_FC.has(f) || WAREHOUSE_CHANNELS.has(ch[i])));
  if (!hit.some(Boolean)) return df;
  const over = k.map((f) => FC_CHANNEL_OVERRIDE.get(f) ?? null);
  return df.setWhere(hit, 'Channel Name', over).setWhere(hit, 'Channel type', over);
};

const canonicalise = (df: Frame): Frame => CANON_COLS.filter((c) => df.has(c)).reduce((f, c) => f.set(c, canonValues(f.get(c))), df);

const aggregate = (df: Frame): Frame => {
  const out = df.groupBy(KEY, false).sum('Final Units').select(OUT_COLS);
  return out.set('Final Units', out.get('Final Units').map((v) => roundHalfEven(v as number)));
};

export const run = async (ctx: Context): Promise<void> => {
  const csm = await readClean(ctx, 'Channel SKU Mapping.csv');
  const code = s(csm.get('Channel Codes'));
  const listing = s(csm.get('Listing SKU Codes at Channel'));
  // codes Excel turned into scientific notation (8.91E+12) can never match a marketplace code (fix plan W4)
  const sci = code.filter((c) => SCI_NOTATION_RE.test(c));
  if (sci.length) {
    ctx.log(`  WARNING Channel SKU Mapping: ${fmtInt(sci.length)} codes look like Excel scientific notation (e.g. ${[...new Set(sci)].slice(0, 3).join(', ')}) - they cannot match`);
  }
  const skuMap = new Map<string, string>();
  code.forEach((c, i) => {
    if (c !== '' && !skuMap.has(c.toLowerCase())) skuMap.set(c.toLowerCase(), listing[i]);
  });

  let ex = await readClean(ctx, 'Export-Inventory Snapshot.csv');
  const exFac = s(ex.get('Facility'));
  ex = ex.assign({ _fac: exFac, _facl: lowerAll(exFac) });

  const parts = [...(await marketplaceSoh(ctx, skuMap)), ...facilitySoh(ex)];
  let soh = Frame.concat(parts.map((p) => p.frame));
  const skuMissing = parts.flatMap((p) => p.skuMissing);
  const facMissing = parts.flatMap((p) => p.facMissing);

  const names = skuNameMap(ex);
  const blank = stripped(soh.get('SKU Name')).map((n) => n === '');
  soh = soh.setWhere(blank, 'SKU Name', soh.get('SKU Code').map((c) => names.get(pyStr(c).toLowerCase()) ?? ''));

  const resolve = locationResolver(await readClean(ctx, 'Location Master.csv'));
  const [sohLoc, sohLocMissing] = resolve(soh.get('Channel Name'), soh.get('Fulfilment Centre'));
  soh = soh.set('Final Location', sohLoc);

  const missing: Frame[] = [];
  const flag = (df: Frame, mask: boolean[], kind: string): void => {
    if (mask.some(Boolean)) missing.push(df.filter(mask).set('Missing Type', kind));
  };
  flag(soh, skuMissing, 'SKU Mapping Not Found (Amazon/Flipkart/Myntra)');
  flag(soh, facMissing, 'Myntra WH Location Not Found (used WH Id)');
  flag(soh, sohLocMissing, 'Final Location Not Found (used Fulfilment Centre)');

  soh = canonicalise(applyFcOverride(soh));
  const cur = aggregate(soh);
  ctx.set('df_current_inventory', cur);
  ctx.log(`current inventory: ${fmtInt(cur.length)} rows, ${fmtInt(sum(cur.get('Final Units')))} units`);

  // ---- in-transit side
  const combIt = ctx.get('df_combined_intransit');
  const itChannel = s(combIt.get('Channel'));
  const itCsku = s(combIt.get('Channel SKU Code'));
  const itNative = s(combIt.get('SKU Code'));
  const isMkt = itChannel.map((c) => MARKETPLACES.has(c.trim().toLowerCase()));
  const [mapped, mappedMissing] = mapChannelSku(skuMap, itCsku, itNative);
  const itSkuMissing = isMkt.map((m, i) => m && mappedMissing[i]);
  let it = Frame.from({
    'Channel SKU Code': itCsku,
    'SKU Code': isMkt.map((m, i) => (m ? mapped[i] : itNative[i])),
    'SKU Name': s(combIt.get('SKU Name')),
    'Fulfilment Centre': s(combIt.get('Location')),
    'Channel Name': itChannel,
    'Channel type': '',
    'Stock Type': 'Intransit',
    'Final Units': toNumeric(combIt.get('final Intransit units')).map((v) => v ?? 0),
  }, combIt.length);
  it = it.set('Channel type', fillna(mapWith(lowerAll(it.get('Channel Name') as string[]), CHANNEL_TYPE), ''));
  it = applyFcOverride(it);
  const [itLoc, itLocMissing] = resolve(it.get('Channel Name'), it.get('Fulfilment Centre'));
  it = it.set('Final Location', itLoc);
  flag(it, itSkuMissing, 'SKU Mapping Not Found (Amazon/Flipkart/Myntra)');
  flag(it, itLocMissing, 'Final Location Not Found (used Fulfilment Centre)');
  it = canonicalise(it);
  // Return stock counts only while physically on hand - never in transit.
  const ct = lowerAll(stripped(it.get('Channel type')));
  const cn = lowerAll(stripped(it.get('Channel Name')));
  it = it.filter(ct.map((t, i) => !(t === 'return' || cn[i] === 'return')));

  // SOH and in-transit were re-cased independently: canonicalise the union again.
  const combined = aggregate(canonicalise(Frame.concat([cur, aggregate(it)])));
  ctx.set('df_combined_soh', combined);
  ctx.log(`SOH + in-transit: ${fmtInt(combined.length)} rows, ${fmtInt(sum(combined.get('Final Units')))} units`);

  const dims = ['Channel Name', 'Channel type', 'Final Location'];
  let master = combined.select(dims).dropDuplicates().sortValues(dims);
  const units = combined.groupBy(dims, false).map((g) => sum(g.rows.map((i) => combined.get('Final Units')[i])));
  master = master.set('Total Units', master.keys(dims).map((k) => Math.trunc(units.get(k) ?? 0)));
  ctx.set('df_channel_location_master', master);

  const cols = ['Missing Type', ...KEY, 'Row Count', 'Total Units'];
  let rep: Frame;
  if (missing.length) {
    rep = Frame.concat(missing)
      .groupBy([...KEY, 'Missing Type'], false)
      .agg({ 'Total Units': ['Final Units', 'sum'], 'Row Count': ['Final Units', 'size'] })
      .select(cols)
      .sortValues(['Missing Type', 'Channel Name', 'Row Count'], [true, true, false]);
  } else {
    rep = Frame.empty(cols);
  }
  ctx.set('df_missing_items', rep);
  ctx.log(`missing items: ${fmtInt(rep.length)} rows`);
};
