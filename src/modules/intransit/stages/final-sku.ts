import { COMBO_CODE_RE } from '../../../constants';
import { Context, fmtInt } from '../context';
import { canonValues, Cell, Col, countTrue, fillna, Frame, isNa, mapWith, roundHalfEven, stripped, stripText as s, toNumeric, unquoted } from '../frame';
import { present, yesNo } from './common';
import { readClean, skuNameMap } from './inventory';

/* Final SKU Code on every SKU-level sheet, combo splits, Sheet35 and gap sheets (final_sku.py, legacy stageJ). */

/** [frame, sheet label, channel-SKU column, SKU column] that get a Final SKU Code. */
const SKU_LEVEL_FRAMES: [string, string, string, string][] = [
  ['df_intransit_stock_v2', 'Intransit_Stock', 'Channel SKU Code', 'SKU Code'],
  ['df_po_not_found', 'PO_Not_Found_in_Export_B2B', 'Channel SKU Code', 'SKU Code'],
  ['df_combined_intransit', 'Combined_InTransit_Units', 'Channel SKU Code', 'SKU Code'],
  ['df_current_inventory', 'Current_Inventory', 'Channel SKU Code', 'SKU Code'],
  ['df_combined_soh', 'Combined_SOH_Intransit', 'Channel SKU Code', 'SKU Code'],
  ['df_b2b_intransit', 'Export_B2B_InTransit_Orders', 'Channel Product ID', 'Item SKU Code'],
];
const CHAN_COLS = ['Channel Name', 'Channel type', 'Stock Type'];
const GROUP_KEY = ['Split SKU', 'SKU Code', 'Final Location', ...CHAN_COLS, 'Split Source'];
const GAP_CHAN_COLS = ['Channel type', 'Stock Type'];
/** Final Sheet35(2) reporting buckets, in column order. */
const CT_ORDER = ['B2C', 'D2C+DarkStore', 'MUMMWH+ReturnMUM', 'GGNMWH+ReturnGGN', 'KOLMWH+ReturnKOL'];
const KOL_LOCATIONS = new Set(['kolkata', 'kol_warehouse']);
const GGN_LOCATIONS = new Set(['gurgoan', 'gurgaon']);
const SHEET35_FIELDS = ['SKU Name', 'Type', 'Count', 'MRP', 'COGS (With TAX)'];
const COMBO_RE = COMBO_CODE_RE;
const MISS_TYPE = 'Final SKU Mapping Not Found';

const lowerAll = (col: readonly string[]): string[] => col.map((v) => v.toLowerCase());
const units0 = (col: Col): number[] => toNumeric(col).map((v) => v ?? 0);
const roundUnits = (df: Frame, col = 'Final Units'): Frame => df.set(col, units0(df.get(col)).map(roundHalfEven));

const finalMap = async (ctx: Context): Promise<Map<string, string>> => {
  const fsm = await readClean(ctx, 'Final SKU Mapping.csv');
  const listing = s(fsm.get('Listing_SKU'));
  const final = canonValues(s(fsm.get('Final SKU')));
  const out = new Map<string, string>();
  listing.forEach((l, i) => {
    if (l !== '' && final[i] !== '' && !out.has(l.toLowerCase())) out.set(l.toLowerCase(), final[i]);
  });
  return out;
};

/**
 * Insert 'Final SKU Code' after skuCol (SKU Code -> Final SKU Mapping, falling back to the SKU Code itself;
 * fallbacks are recorded in misses).
 */
const addFinalSku = (df: Frame, fmap: Map<string, string>, misses: Frame[], chanCol: string, skuCol: string, label: string): [Frame, number] => {
  if (!df.has(skuCol)) return [df, 0];
  const skuKey = unquoted(df.get(skuCol));
  const chanKey = df.has(chanCol) ? unquoted(df.get(chanCol)) : skuKey;
  const mapped = mapWith(lowerAll(skuKey), fmap);
  const missing = mapped.map((m) => m === null);
  const hits = missing.length - countTrue(missing);
  const final = fillna(mapped, skuKey) as string[];
  if (missing.some(Boolean)) {
    const pick = <T>(col: T[]): T[] => col.filter((_, i) => missing[i]);
    misses.push(
      Frame.from({
        Sheet: label,
        'Channel SKU Code': pick(chanKey),
        'SKU Code': pick(skuKey),
        'Listing SKU (looked up)': pick(skuKey),
        'Final SKU Code (used)': pick(final),
        Remark: 'SKU Code not found in Final SKU Mapping - used SKU Code',
      }, countTrue(missing)),
    );
  }
  let out = df.drop(['Final SKU Code']);
  out = out.insert(out.columns.indexOf(skuCol) + 1, 'Final SKU Code', canonValues(final));
  out = out.set(skuCol, canonValues(out.get(skuCol)));
  if (out.has(chanCol)) out = out.set(chanCol, canonValues(out.get(chanCol)));
  return [out, hits];
};

/**
 * Split file -> one row per (parent, component) with Split Qty. A component listed N times under a parent means
 * the parent holds N of it.
 */
const loadSplit = async (ctx: Context, fname: string): Promise<Frame> => {
  let d = await readClean(ctx, fname);
  d = d.assign({ 'SKU Code': s(d.get('SKU Code')), 'Split SKU': canonValues(s(d.get('Split SKU'))) });
  d = d.filter(d.get('SKU Code').map((c, i) => c !== '' && d.get('Split SKU')[i] !== ''));
  d = d.assign({ _joinkey: lowerAll(d.get('SKU Code') as string[]), _splitl: lowerAll(d.get('Split SKU') as string[]) });
  return d
    .groupBy(['_joinkey', '_splitl'])
    .agg({ 'Split SKU': ['Split SKU', 'first'], 'Split Qty': ['Split SKU', 'size'] })
    .select(['_joinkey', 'Split SKU', 'Split Qty']);
};

/**
 * Explode rows matching splitDf into their components (units x Split Qty). Rows missing on idCol retry on their
 * raw 'SKU Code'. Unmatched rows pass through as themselves if they carry non-zero units.
 */
const explode = (base: Frame, idCol: string, splitDf: Frame): Frame => {
  let key = stripped(base.get(idCol));
  let keyl = lowerAll(key);
  const mapped = new Set(splitDf.get('_joinkey'));
  let hasSplit = keyl.map((k) => mapped.has(k));
  if (base.has('SKU Code') && idCol !== 'SKU Code') {
    const raw = stripped(base.get('SKU Code'));
    const fallback = raw.map((r, i) => !hasSplit[i] && mapped.has(r.toLowerCase()));
    if (fallback.some(Boolean)) {
      key = key.map((k, i) => (fallback[i] ? raw[i] : k));
      keyl = lowerAll(key);
      hasSplit = hasSplit.map((h, i) => h || fallback[i]);
    }
  }
  const b = base.assign({ _key: key, _keyl: keyl });
  const hit = b.filter(hasSplit);
  const miss = b.filter(hasSplit.map((h) => !h));

  let ex = hit.mergeLeft(splitDf, ['_keyl'], ['_joinkey'], ['', '_sp']);
  ex = ex.set('Split SKU', fillna(ex.get('Split SKU'), ex.get('_key')));
  ex = ex.set('Split Source', 'Split mapping');
  const qty = toNumeric(ex.get('Split Qty')).map((q) => q ?? 1);
  ex = ex.set('Final Units', units0(ex.get('Final Units')).map((u, i) => u * qty[i]));
  ex = ex.drop(['Split Qty', '_joinkey']);

  let passthru = miss.filter(units0(miss.get('Final Units')).map((u) => u !== 0));
  passthru = passthru.assign({ 'Split SKU': passthru.get('_key'), 'Split Source': 'Pass-through (no split mapping)' });
  return Frame.concat([ex, passthru]);
};

/** 'No' when any of skuCols is on the not-to-consider list. */
const markConsider = (df: Frame, skuCols: string[], notConsider: Set<string>): string[] => {
  const flag = new Array<boolean>(df.length).fill(false);
  for (const c of skuCols) {
    if (!df.has(c)) continue;
    stripped(df.get(c)).forEach((v, i) => {
      if (notConsider.has(v.toLowerCase())) flag[i] = true;
    });
  }
  return flag.map((f) => (f ? 'No' : 'Yes'));
};

const buildSplit = (base: Frame, idCol: string, splitDf: Frame, outName: string, notConsider: Set<string>): Frame => {
  let ex = explode(base, idCol, splitDf);
  ex = ex.set('Split SKU', canonValues(ex.get('Split SKU')));
  let out = ex.groupBy(GROUP_KEY, false).sum('Final Units').rename({ 'Split SKU': outName });
  out = out.set('Consider?', markConsider(out, [outName, 'SKU Code'], notConsider));
  out = out.select([outName, 'SKU Code', 'Final Location', ...CHAN_COLS, 'Split Source', 'Consider?', 'Final Units']);
  return roundUnits(out).sortValues([outName, 'Final Location', 'Channel Name']);
};

const sheet35Master = async (ctx: Context): Promise<Frame> => {
  let m = await readClean(ctx, 'Sheet35(2).csv');
  m = m.set('SKU Code', s(m.get('SKU Code')));
  m = m.set('_m_key', lowerAll(m.get('SKU Code') as string[])).dropDuplicates(['_m_key']);
  return m.select(present(m, ['_m_key', ...SHEET35_FIELDS]));
};

const buildSheet35 = async (ctx: Context, split2: Frame, master: Frame, notConsider: Set<string>): Promise<Frame> => {
  let s35 = split2.groupBy(['Split2 SKU', 'Final Location', ...CHAN_COLS], false).sum('Final Units');
  s35 = s35.set('_key', lowerAll(stripped(s35.get('Split2 SKU'))));
  s35 = s35.mergeLeft(master, ['_key'], ['_m_key']).drop(['_m_key', '_key']);
  s35 = s35.set('Found in Sheet35 Master', yesNo(s35.get('SKU Name').map((v) => !isNa(v))));
  // Unmatched rows survive only with non-zero units.
  const units = units0(s35.get('Final Units'));
  s35 = s35.filter(s35.get('Found in Sheet35 Master').map((f, i) => f === 'Yes' || units[i] !== 0));
  s35 = s35.set('Consider?', markConsider(s35, ['Split2 SKU'], notConsider));
  for (const c of SHEET35_FIELDS) if (s35.has(c)) s35 = s35.set(c, fillna(s35.get(c), ''));
  const blank = stripped(s35.get('SKU Name')).map((n) => n === '');
  const names = skuNameMap(await readClean(ctx, 'Export-Inventory Snapshot.csv'));
  s35 = s35.setWhere(blank, 'SKU Name', lowerAll(stripped(s35.get('Split2 SKU'))).map((k) => names.get(k) ?? ''));
  const order = ['Split2 SKU', ...SHEET35_FIELDS, 'Final Location', ...CHAN_COLS, 'Consider?', 'Final Units', 'Found in Sheet35 Master'];
  s35 = roundUnits(s35.select(present(s35, order)));
  return s35.sortValues(['Split2 SKU', 'Final Location', 'Channel Name']);
};

/**
 * The reporting bucket of a Sheet35(2) row (a Final Sheet35(2) column): each warehouse absorbs the returned stock at
 * its own city; DarkStore folds into D2C. `channelType` already stripped ('' = '(blank)'); `location` lower-cased.
 */
export const reportBucket = (channelType: string, location: string): string => {
  const c = channelType === '' ? '(blank)' : channelType;
  const l = c.toLowerCase();
  // returns, and warehouse rows typed only "MWH", go to the warehouse of their city
  const byCity = l === 'return' || l === 'mwh';
  if (byCity && location === 'mumbai') return 'MUMMWH+ReturnMUM';
  if (byCity && GGN_LOCATIONS.has(location)) return 'GGNMWH+ReturnGGN';
  if (byCity && KOL_LOCATIONS.has(location)) return 'KOLMWH+ReturnKOL';
  if (l === 'mummwh') return 'MUMMWH+ReturnMUM';
  if (l === 'ggnmwh') return 'GGNMWH+ReturnGGN';
  if (l === 'kolmwh') return 'KOLMWH+ReturnKOL';
  if (l === 'd2c' || l === 'darkstore') return 'D2C+DarkStore';
  return c;
};

/** Sheet35(2) pivoted: one Final Units column per reporting bucket (reportBucket). */
const buildFinalSheet35 = (s35: Frame): Frame => {
  const pivotKey = present(s35, ['Split2 SKU', ...SHEET35_FIELDS, 'Stock Type', 'Consider?', 'Found in Sheet35 Master']);
  const ctRaw = stripped(s35.get('Channel type'));
  const loc = lowerAll(stripped(s35.get('Final Location')));
  const ct = ctRaw.map((c, i) => reportBucket(c, loc[i]));
  const fs = s35.set('Channel type', ct);

  // groupby(pivotKey + [Channel type]).sum().unstack("Channel type", fill_value=0)
  const units = fs.get('Final Units') as number[];
  const rows = fs.groupBy(pivotKey, false);
  const present_ = [...new Set(ct)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ctCols = [...CT_ORDER.filter((c) => present_.includes(c)), ...present_.filter((c) => !CT_ORDER.includes(c))];
  for (const c of CT_ORDER) if (!ctCols.includes(c)) ctCols.push(c);
  const data: Cell[][] = rows.groups.map((g) => {
    const byCt = new Map<string, number>();
    for (const i of g.rows) byCt.set(ct[i], (byCt.get(ct[i]) ?? 0) + units[i]);
    const vals = ctCols.map((c) => roundHalfEven(byCt.get(c) ?? 0));
    return [...g.key, ...vals, vals.reduce((t, v) => t + v, 0)];
  });
  return Frame.fromRows([...pivotKey, ...ctCols, 'Total Final Units'], data).sortValues(['Total Final Units'], false);
};

/** SKUs (Consider? = Yes) in src with no entry in the next reference file. */
const buildGap = (src: Frame, skuCol: string, knownKeys: Set<Cell>, extraCols: string[] = []): Frame => {
  const k = lowerAll(stripped(src.get(skuCol)));
  const consider = src.get('Consider?');
  const gap = src.filter(k.map((key, i) => !knownKeys.has(key) && consider[i] === 'Yes'));
  const grp = [skuCol, ...present(src, [...extraCols, ...GAP_CHAN_COLS, 'Consider?'])];
  if (gap.empty) return Frame.empty([...grp, 'Row Count', 'Final Units']);
  const out = gap
    .groupBy(grp, false)
    .agg({ 'Final Units': ['Final Units', 'sum'], 'Row Count': ['Final Units', 'size'] })
    .select([...grp, 'Row Count', 'Final Units']);
  return roundUnits(out).sortValues(['Final Units'], false);
};

/** (SKUs missing from Final SKU Mapping, the _S combo subset with a proposed code). */
const buildFinalSkuGaps = (comb: Frame, fmap: Map<string, string>, notConsider: Set<string>): [Frame, Frame] => {
  const sku = stripped(comb.get('SKU Code'));
  let c = comb.assign({ _sku: sku, 'Final Units': units0(comb.get('Final Units')) });
  c = c.filter(sku.map((v) => !fmap.has(v.toLowerCase())));
  let notMapped = c
    .groupBy(['_sku'], false)
    .agg({ 'SKU Name': ['SKU Name', 'first'], 'Row Count': ['Final Units', 'size'], 'Final Units': ['Final Units', 'sum'] })
    .rename({ _sku: 'SKU Code' });
  notMapped = roundUnits(notMapped);
  notMapped = notMapped.set('Consider?', markConsider(notMapped, ['SKU Code'], notConsider));
  notMapped = notMapped.select(['SKU Code', 'SKU Name', 'Consider?', 'Row Count', 'Final Units']).sortValues(['Final Units'], false);

  const codes = notMapped.get('SKU Code') as string[];
  let cand = notMapped.filter(codes.map((code) => COMBO_RE.test(code) && code.toLowerCase().endsWith('_s')));
  const finalCode = (cand.get('SKU Code') as string[]).map((code) => code.replace(/_[sS]$/, ''));
  cand = cand.assign({
    'Final SKU Code': finalCode,
    'Is Available in Final SKU Mapping': yesNo(finalCode.map((f) => fmap.has(f.toLowerCase()))),
  });
  cand = cand
    .select(['SKU Code', 'SKU Name', 'Final SKU Code', 'Is Available in Final SKU Mapping', 'Consider?', 'Row Count', 'Final Units'])
    .sortValues(['Final Units'], false);
  return [notMapped, cand];
};

/** Add the Final SKU Mapping misses to Missing_Items_Report (replacing earlier ones). */
const appendFinalSkuMisses = (mi: Frame, misses: Frame[]): Frame => {
  const kept = mi.has('Missing Type') ? mi.filter(mi.get('Missing Type').map((t) => t !== MISS_TYPE)) : mi;
  if (!misses.length) return kept;
  const fm = Frame.concat(misses)
    .groupBy(['Sheet', 'Channel SKU Code', 'SKU Code', 'Listing SKU (looked up)', 'Final SKU Code (used)', 'Remark'], false)
    .agg({ 'Row Count': ['Sheet', 'size'] });
  const out = Frame.from({
    'Missing Type': MISS_TYPE,
    'Channel SKU Code': fm.get('Channel SKU Code'),
    'SKU Code': fm.get('SKU Code'),
    'SKU Name': '',
    'Fulfilment Centre': fm.get('Sheet'),
    'Final Location': fm.get('Listing SKU (looked up)'),
    'Channel Name': '',
    'Channel type': '',
    'Stock Type': fm.get('Remark'),
    'Row Count': fm.get('Row Count'),
    'Total Units': 0,
  }, fm.length);
  return Frame.concat([kept, out.select(kept.columns.filter((c) => out.has(c)))]);
};

export const run = async (ctx: Context): Promise<void> => {
  const fmap = await finalMap(ctx);
  const ntc = await readClean(ctx, 'SKU-Not To Consider.csv');
  const notConsider = new Set(lowerAll(s(ntc.get(ntc.columns[0]))).filter((v) => v !== ''));

  const misses: Frame[] = [];
  for (const [frame, label, chanCol, skuCol] of SKU_LEVEL_FRAMES) {
    const [df, hits] = addFinalSku(ctx.get(frame), fmap, misses, chanCol, skuCol, label);
    ctx.set(frame, df);
    ctx.log(`  ${label}: Final SKU mapped on ${fmtInt(hits)} / ${fmtInt(df.length)} rows`);
  }

  const combSoh = ctx.get('df_combined_soh');
  const comb = combSoh.set('Final Units', units0(combSoh.get('Final Units')));

  const sp1 = await loadSplit(ctx, 'Split1.csv');
  const sp2 = await loadSplit(ctx, 'Split2.csv');
  const split1 = buildSplit(comb, 'Final SKU Code', sp1, 'Split1 SKU', notConsider);
  const split2 = buildSplit(split1, 'Split1 SKU', sp2, 'Split2 SKU', notConsider); // chains off Split1
  const master = await sheet35Master(ctx);
  const s35 = await buildSheet35(ctx, split2, master, notConsider);
  ctx.set('df_split1', split1);
  ctx.set('df_split2', split2);
  ctx.set('df_sheet35', s35);
  ctx.set('df_final_sheet35', buildFinalSheet35(s35));
  ctx.log(`splits: Split1 ${fmtInt(split1.length)} | Split2 ${fmtInt(split2.length)} | Sheet35 ${fmtInt(s35.length)} rows`);

  const combGap = comb.set('Consider?', markConsider(comb, ['Final SKU Code', 'SKU Code'], notConsider));
  ctx.set('df_gap_split1', buildGap(combGap, 'Final SKU Code', new Set(sp1.get('_joinkey')), ['SKU Name']).rename({ 'Final SKU Code': 'SKU Code' }));
  ctx.set('df_gap_split2', buildGap(split1, 'Split1 SKU', new Set(sp2.get('_joinkey'))));
  ctx.set('df_gap_sheet35', buildGap(split2, 'Split2 SKU', new Set(master.get('_m_key'))));

  const [notMapped, codeMissing] = buildFinalSkuGaps(comb, fmap, notConsider);
  ctx.set('df_final_sku_not_mapped', notMapped);
  ctx.set('df_final_sku_code_missing', codeMissing);
  ctx.set('df_missing_items', appendFinalSkuMisses(ctx.get('df_missing_items'), misses));
  ctx.log(`missing items: ${fmtInt(ctx.get('df_missing_items').length)} rows`);
};
