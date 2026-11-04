import path from 'path';
import { COGS_FROM_MRP, COMBO_CHECK } from '../../constants';
import { Cached, ComboAlert, pool, readCache } from './combo-check';
import { Context, fmtInt } from './context';
import { Frame, isNa, stripped, toNumber } from './frame';
import { writeAtomic } from './sources/files';
import { getItem, UniwareConfig, uniwareCatalog } from './sources/uniware';

/*
 * Missing Sheet35 values and new SKUs (user, 2026-11-02), in stage final_sku (inside the build's worker):
 *
 * Fill - a Sheet35(2) row counted (Consider? = Yes, units) with a blank SKU Name / MRP / COGS gets them from:
 *   name, MRP   our product master (master_skus: product_name / mrp, loaded from Uniware), else Uniware's item master;
 *   COGS        Uniware's costPrice when filled (it was empty for every SKU checked on 2026-11-02), else 20% of MRP.
 * Only blanks are filled; the values typed into Sheet35(2) always win. The server saves the fills to the master (marked
 * auto-filled) for SKUs it has; Uniware answers are cached with the combo check's item types.
 *
 * Issues - asked before the build finishes (user, 2026-11-02); each can also be ignored for this build (asked again
 * at the next one):
 *   sku        a SKU (after the combo splits) with no Sheet35(2) row, or one neither Final SKU Mapping nor our product
 *              master knows: Consider / Don't consider (never asked again);
 *   code       an Amazon / Flipkart / Myntra listing code with no Channel SKU Mapping (counted under the seller's SKU,
 *              as before, when considered): Consider / Don't consider;
 *   combo      a combo missing from Split1 that Uniware confirms (the combo check): add its parts to Split1, or map a
 *              variant to its base combo;
 *   final-sku  a _S combo code whose base is not mapped (Final SKU Code Missing): map it to the base;
 *   location   a fulfilment centre / Myntra warehouse id with no Final Location: pick its city.
 */

export interface SkuReviewSettings {
  /** Stop after final_sku when there are new SKUs to ask about (live server, masters in the database). */
  pause: boolean;
  /** SKUs answered before, lower-case. */
  reviewed: string[];
  /** Our product master, lower-case pep_code -> its name and MRP. */
  catalog: Record<string, { name: string | null; mrp: number | null }>;
  /** Uniware login for the lookups (null = none) and where the item cache is. */
  uniware: UniwareConfig | null;
  cacheDir: string;
}

/** Values filled for one SKU (only the filled fields are set). */
export interface SkuFill {
  sku: string;
  name?: string;
  mrp?: number;
  cogs?: number;
  /** e.g. "mrp:uniware; cogs:20% of MRP" (kept as master_skus.intransit_autofilled). */
  from: string;
}

export type NewSkuKind = 'sku' | 'code' | 'combo' | 'final-sku' | 'location';

export interface NewSku {
  kind: NewSkuKind;
  /** sku / combo / final-sku: the SKU; code: the seller's SKU it is counted under; location: '' */
  sku: string;
  /** code: the marketplace and its listing code; location: the channel and its fulfilment centre / warehouse id. */
  channel?: string;
  code?: string;
  /** combo: Uniware's parts (Add to Split1); combo variant / final-sku: the base it maps to (with its parts). */
  components?: { sku: string; qty: number }[];
  base?: { sku: string; components: { sku: string; qty: number }[] };
  name: string;
  mrp: number | null;
  cogs: number | null;
  units: number;
  /** Why it is asked: no Sheet35(2) row / not in any SKU master / no Channel SKU Mapping / ... */
  reasons: string[];
  channelTypes: string;
}

export const NEW_SKU_REASON = {
  NO_SHEET35: 'no Sheet35(2) row',
  UNKNOWN: 'not in any SKU master',
  NO_MAPPING: 'no Channel SKU Mapping',
  COMBO: 'combo not in Split1',
  FINAL_SKU: 'base combo not in Final SKU Mapping',
  LOCATION: 'no Final Location',
} as const;
export const CHANNEL_MAPPING_MISSING = 'SKU Mapping Not Found (Amazon/Flipkart/Myntra)';
/** Missing_Items rows of a fulfilment centre / Myntra warehouse with no Final Location (stage inventory). */
const LOCATION_MISSING = ['Final Location Not Found (used Fulfilment Centre)', 'Myntra WH Location Not Found (used WH Id)'];

const lc = (s: string): string => s.trim().toLowerCase();
const round2 = (n: number): number => Math.round(n * 100) / 100;
const blankCell = (v: unknown): boolean => isNa(v as never) || String(v).trim() === '';
/** The key of a new SKU / code (answers are matched on it). */
export const newSkuKey = (n: Pick<NewSku, 'kind' | 'sku' | 'channel' | 'code'>): string =>
  n.kind === 'code' || n.kind === 'location' ? `${n.kind}:${lc(n.channel ?? '')}:${lc(n.code ?? '')}` : `${n.kind}:${lc(n.sku)}`;

/** Uniware items of `skus` (lower-case -> item), from the cache or looked up (4 at a time); never throws. */
const uniwareItems = async (ctx: Context, skus: string[], cfg: SkuReviewSettings): Promise<Map<string, Cached>> => {
  const file = path.join(cfg.cacheDir, COMBO_CHECK.CACHE_FILE);
  const cache = await readCache(file);
  const fresh = Date.now() - COMBO_CHECK.CACHE_DAYS * 86400000;
  // an entry of the combo check has no mrp yet: looked up again here
  const toLook = skus.filter((s) => !cache[s] || Date.parse(cache[s].at) < fresh || (!cache[s].missing && !('mrp' in cache[s])));
  if (toLook.length && cfg.uniware?.tenant && cfg.uniware.username && cfg.uniware.password) {
    ctx.log(`  fill: ${fmtInt(toLook.length)} SKU(s) looked up in Uniware's item master`);
    try {
      const api = uniwareCatalog(cfg.uniware);
      await pool(toLook, COMBO_CHECK.PARALLEL, async (sku) => {
        const it = await getItem(api, sku);
        const at = new Date().toISOString();
        cache[sku] = it
          ? { sku: it.sku, name: it.name, type: it.type, components: it.components, at, mrp: it.mrp, cost: it.costPrice }
          : { sku, name: '', type: '', components: [], at, missing: true };
      });
    } catch (err) {
      ctx.warn(`Uniware's item master could not be read for the missing MRP / COGS (${err instanceof Error ? err.message : String(err)})`);
    }
    await writeAtomic(file, JSON.stringify(cache)).catch(() => undefined);
  } else if (toLook.length) ctx.warn(`${fmtInt(toLook.length)} SKU(s) with no MRP were not looked up in Uniware (no Uniware login)`);
  return new Map(skus.filter((s) => cache[s] && !cache[s].missing).map((s) => [s, cache[s]]));
};

/**
 * Fill the blank SKU Name / MRP / COGS of the counted Sheet35(2) rows (see the top); returns the frame and what was
 * filled per SKU.
 */
export const fillSheet35 = async (ctx: Context, s35: Frame, cfg: SkuReviewSettings): Promise<{ frame: Frame; fills: SkuFill[] }> => {
  if (!s35.length) return { frame: s35, fills: [] };
  const sku = stripped(s35.get('Split2 SKU'));
  const consider = s35.get('Consider?');
  const units = s35.get('Final Units').map((u) => toNumber(u) ?? 0);
  const name = s35.get('SKU Name');
  const mrp = s35.get('MRP');
  const cogs = s35.get('COGS (With TAX)');
  const rows = sku.flatMap((s, i) => (s && consider[i] === 'Yes' && units[i] !== 0 && (blankCell(name[i]) || blankCell(mrp[i]) || blankCell(cogs[i])) ? [i] : []));
  if (!rows.length) return { frame: s35, fills: [] };

  // per SKU: what the sheet has, then the product master
  const want = new Map<string, { sku: string; name: string | null; mrp: number | null; cogs: number | null }>();
  for (const i of rows) {
    const k = lc(sku[i]);
    if (want.has(k)) continue;
    want.set(k, {
      sku: sku[i],
      name: blankCell(name[i]) ? null : String(name[i]),
      mrp: blankCell(mrp[i]) ? null : toNumber(mrp[i]),
      cogs: blankCell(cogs[i]) ? null : toNumber(cogs[i]),
    });
  }
  const from = new Map<string, string[]>();
  const note = (k: string, what: string): void => void from.set(k, [...(from.get(k) ?? []), what]);
  for (const [k, w] of want) {
    const cat = cfg.catalog[k];
    if (w.name === null && cat?.name) { w.name = cat.name; note(k, 'name:product master'); }
    if (w.mrp === null && cat?.mrp) { w.mrp = cat.mrp; note(k, 'mrp:product master'); }
  }
  const ask = [...want].filter(([, w]) => w.mrp === null || w.name === null || w.cogs === null).map(([k]) => k);
  const items = ask.length ? await uniwareItems(ctx, ask, cfg) : new Map<string, Cached>();
  for (const [k, w] of want) {
    const it = items.get(k);
    if (w.name === null && it?.name) { w.name = it.name; note(k, 'name:uniware'); }
    if (w.mrp === null && it?.mrp) { w.mrp = it.mrp; note(k, 'mrp:uniware'); }
    if (w.cogs === null && it?.cost) { w.cogs = it.cost; note(k, 'cogs:uniware'); }
    if (w.cogs === null && w.mrp !== null) { w.cogs = round2(w.mrp * COGS_FROM_MRP); note(k, `cogs:${COGS_FROM_MRP * 100}% of MRP`); }
  }

  // the frame: blanks only
  let frame = s35;
  const fillCol = (col: string, value: (w: { name: string | null; mrp: number | null; cogs: number | null }) => string | number | null): void => {
    const cur = frame.get(col);
    const next = cur.map((c, i) => {
      if (!blankCell(c) || consider[i] !== 'Yes' || units[i] === 0) return c;
      const w = want.get(lc(sku[i]));
      const v = w ? value(w) : null;
      return v === null ? c : v;
    });
    frame = frame.set(col, next);
  };
  fillCol('SKU Name', (w) => w.name);
  fillCol('MRP', (w) => w.mrp);
  fillCol('COGS (With TAX)', (w) => w.cogs);

  const fills: SkuFill[] = [];
  for (const [k, w] of want) {
    const f = from.get(k);
    if (!f?.length) continue;
    const fill: SkuFill = { sku: w.sku, from: f.join('; ') };
    if (f.some((x) => x.startsWith('name:'))) fill.name = w.name as string;
    if (f.some((x) => x.startsWith('mrp:'))) fill.mrp = w.mrp as number;
    if (f.some((x) => x.startsWith('cogs:'))) fill.cogs = w.cogs as number;
    fills.push(fill);
  }
  const n = (what: string) => fills.filter((f) => f.from.includes(what)).length;
  ctx.log(`  fill: ${fmtInt(fills.length)} SKU(s) filled - MRP ${fmtInt(n('mrp:'))}, COGS ${fmtInt(n('cogs:'))} (${fmtInt(n('% of MRP'))} at ${COGS_FROM_MRP * 100}% of MRP), name ${fmtInt(n('name:'))}`);
  const still = [...want.values()].filter((w) => w.mrp === null).length;
  if (still) ctx.warn(`${fmtInt(still)} counted SKU(s) still have no MRP (not in our product master nor Uniware): their GMV / COGS count as 0`);
  return { frame, fills };
};

/** Sum of units and the channel types per key of `df`. */
const gather = (df: Frame, keyCol: string, unitCol: string, keep: (i: number) => boolean) => {
  const out = new Map<string, { sku: string; units: number; types: Set<string>; row: number }>();
  if (!df.length || !df.has(keyCol)) return out;
  const key = stripped(df.get(keyCol));
  const units = df.get(unitCol).map((u) => toNumber(u) ?? 0);
  const ct = df.has('Channel type') ? stripped(df.get('Channel type')) : key.map(() => '');
  key.forEach((k, i) => {
    if (!k || !keep(i)) return;
    const g = out.get(lc(k)) ?? { sku: k, units: 0, types: new Set<string>(), row: i };
    g.units += units[i];
    if (ct[i]) g.types.add(ct[i]);
    out.set(lc(k), g);
  });
  return out;
};

/**
 * The new SKUs and codes of this build not answered before (see the top), most units first. Reads the gap frames of
 * final_sku and the channel-mapping misses of inventory, and the filled Sheet35 values for the list.
 */
export const findNewSkus = (ctx: Context, s35: Frame, cfg: SkuReviewSettings, combos: ComboAlert[] = []): NewSku[] => {
  const reviewed = new Set(cfg.reviewed);
  const out = new Map<string, NewSku>();
  const valuesOf = new Map<string, { name: string; mrp: number | null; cogs: number | null }>();
  if (s35.length) {
    const sku = stripped(s35.get('Split2 SKU'));
    sku.forEach((s, i) => {
      if (valuesOf.has(lc(s))) return;
      valuesOf.set(lc(s), { name: String(s35.get('SKU Name')[i] ?? ''), mrp: toNumber(s35.get('MRP')[i]), cogs: toNumber(s35.get('COGS (With TAX)')[i]) });
    });
  }
  const add = (s: string, units: number, types: Set<string>, reason: string, name = ''): void => {
    const k = lc(s);
    if (reviewed.has(k) || units === 0) return;
    const cur = out.get(`sku:${k}`);
    if (cur) {
      if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
      return;
    }
    const v = valuesOf.get(k);
    out.set(`sku:${k}`, {
      kind: 'sku', sku: s, name: v?.name || name || cfg.catalog[k]?.name || '', mrp: v?.mrp ?? null, cogs: v?.cogs ?? null,
      units: Math.round(units), reasons: [reason], channelTypes: [...types].sort().join(', '),
    });
  };
  // a SKU with no Sheet35(2) row
  for (const g of gather(ctx.get('df_gap_sheet35'), 'Split2 SKU', 'Final Units', () => true).values()) add(g.sku, g.units, g.types, NEW_SKU_REASON.NO_SHEET35);
  // a SKU neither Final SKU Mapping nor our product master knows
  const nm = ctx.get('df_final_sku_not_mapped');
  const nmConsider = nm.length ? nm.get('Consider?') : [];
  for (const g of gather(nm, 'SKU Code', 'Final Units', (i) => nmConsider[i] === 'Yes').values()) {
    if (!cfg.catalog[lc(g.sku)]) add(g.sku, g.units, g.types, NEW_SKU_REASON.UNKNOWN, String(nm.get('SKU Name')[g.row] ?? ''));
  }
  // a marketplace code with no Channel SKU Mapping
  const mi = ctx.get('df_missing_items');
  if (mi.length && mi.has('Missing Type')) {
    const type = mi.get('Missing Type');
    const code = stripped(mi.get('Channel SKU Code'));
    const chan = stripped(mi.get('Channel Name'));
    const fallback = stripped(mi.get('SKU Code'));
    const nameCol = mi.get('SKU Name');
    const units = mi.get('Total Units').map((u) => toNumber(u) ?? 0);
    const ct = stripped(mi.get('Channel type'));
    type.forEach((t, i) => {
      if (t !== CHANNEL_MAPPING_MISSING || !code[i]) return;
      const key = newSkuKey({ kind: 'code', sku: '', channel: chan[i], code: code[i] });
      const cur = out.get(key);
      if (cur) {
        cur.units += units[i];
        return;
      }
      const v = valuesOf.get(lc(fallback[i]));
      out.set(key, {
        kind: 'code', sku: fallback[i], channel: chan[i], code: code[i], name: String(nameCol[i] ?? '') || v?.name || '', mrp: v?.mrp ?? null, cogs: v?.cogs ?? null,
        units: units[i], reasons: [NEW_SKU_REASON.NO_MAPPING], channelTypes: ct[i],
      });
    });
  }
  // a combo Uniware confirms (with its parts) or a variant of one: fixable here; a combo by its code only stays in the
  // combo check's list after the build
  for (const c of combos) {
    if (!c.components.length && !c.base) continue;
    out.set(`combo:${lc(c.sku)}`, {
      kind: 'combo', sku: c.sku, name: c.name, mrp: null, cogs: null, units: c.units, channelTypes: c.channelTypes,
      reasons: [c.base ? `${NEW_SKU_REASON.COMBO}: a variant of ${c.base.sku}` : NEW_SKU_REASON.COMBO],
      ...(c.components.length ? { components: c.components } : {}), ...(c.base ? { base: { sku: c.base.sku, components: c.base.components } } : {}),
    });
  }
  // a _S combo whose base is not in Final SKU Mapping
  const fm = ctx.frames.has('df_final_sku_code_missing') ? ctx.get('df_final_sku_code_missing') : Frame.empty([]);
  if (fm.length) {
    const consider = fm.get('Consider?');
    const units = fm.get('Final Units').map((u) => toNumber(u) ?? 0);
    const code = stripped(fm.get('SKU Code'));
    const base = stripped(fm.get('Final SKU Code'));
    code.forEach((s, i) => {
      if (!s || consider[i] !== 'Yes' || units[i] === 0 || out.has(`final-sku:${lc(s)}`)) return;
      out.set(`final-sku:${lc(s)}`, {
        kind: 'final-sku', sku: s, name: String(fm.get('SKU Name')[i] ?? ''), mrp: null, cogs: null, units: units[i], channelTypes: '',
        reasons: [`${NEW_SKU_REASON.FINAL_SKU} (${base[i]})`], base: { sku: base[i], components: [] },
      });
    });
  }
  // a fulfilment centre / Myntra warehouse with no Final Location
  if (mi.length && mi.has('Missing Type') && mi.has('Fulfilment Centre')) {
    const type = mi.get('Missing Type');
    const fc = stripped(mi.get('Fulfilment Centre'));
    const chan = stripped(mi.get('Channel Name'));
    const units = mi.get('Total Units').map((u) => toNumber(u) ?? 0);
    // units per location and missing type: a Myntra id is listed under both types for the same rows, so it counts once
    const byType = new Map<string, Map<string, number>>();
    type.forEach((t, i) => {
      if (!LOCATION_MISSING.includes(String(t)) || !fc[i]) return;
      const key = newSkuKey({ kind: 'location', sku: '', channel: chan[i], code: fc[i] });
      if (!out.has(key)) out.set(key, { kind: 'location', sku: '', channel: chan[i], code: fc[i], name: '', mrp: null, cogs: null, units: 0, reasons: [NEW_SKU_REASON.LOCATION], channelTypes: '' });
      const per = byType.get(key) ?? new Map<string, number>();
      per.set(String(t), (per.get(String(t)) ?? 0) + units[i]);
      byType.set(key, per);
    });
    for (const [key, per] of byType) (out.get(key) as NewSku).units = Math.max(...per.values());
  }
  const list = [...out.values()].map((n) => ({ ...n, units: Math.round(n.units) })).filter((n) => n.units !== 0);
  return list.sort((a, b) => Math.abs(b.units) - Math.abs(a.units) || (a.sku < b.sku ? -1 : 1));
};
