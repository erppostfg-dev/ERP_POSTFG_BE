import fs from 'fs/promises';
import path from 'path';
import { COMBO_CHECK, COMBO_CODE_RE, COMBO_VARIANT_SUFFIX_RE } from '../../constants';
import { Frame, toNum } from './frame';
import { toCsv, writeAtomic } from './sources/files';
import { Log } from './sources/http';
import { getItemType, UniwareConfig, uniwareCatalog, UniwareItemType } from './sources/uniware';

/*
 * Combo check (user, 2026-10-19): a combo whose SKU is not in Split1 is never split into its components, so its stock
 * is counted under the combo instead of the products in it. After a report is built, every SKU of "SKU not available
 * in Split1" (Consider? = Yes, with units) is judged on two signals:
 *   - Uniware's item master: type BUNDLE = a combo (with its components), SIMPLE = a single product;
 *   - its code: CMB / SCMB / COMB in the SKU code (COMBO_CODE_RE) names a combo.
 *
 *   code   Uniware          -> found by
 *   yes    BUNDLE           -> 'uniware+code'  combo; Split1 rows written from Uniware's components
 *   no     BUNDLE           -> 'uniware'       combo; Split1 rows written
 *   yes    SIMPLE           -> 'code-only'     flagged to check: the code says combo, Uniware a single product
 *   yes    unknown/no check -> 'code-only'     combo by its code, not confirmed (no components, no Split1 rows)
 *   yes    SIMPLE/unknown, its base code (variant suffix _S / B2b / _WB / _C stripped) is a BUNDLE
 *                           -> 'variant'       a pack of that combo (CMB47B2b of CMB47): map it to the base in Final SKU
 *                                              Mapping so it follows the base's split (user, 2026-10-19)
 *   no     SIMPLE/unknown   -> not flagged
 *
 * So code-named combos are flagged even without a Uniware login or when Uniware is down. Item types are cached for
 * COMBO_CHECK.CACHE_DAYS (SKUs rarely change), so only new SKUs are looked up. It never fails the report.
 */

export type ComboFoundBy = 'uniware+code' | 'uniware' | 'variant' | 'code-only';

export interface ComboAlert {
  sku: string;
  name: string;
  channelTypes: string;
  units: number;
  foundBy: ComboFoundBy;
  /** What Uniware said: BUNDLE / SIMPLE / unknown (not in Uniware) / not checked. */
  uniwareType: string;
  components: { sku: string; qty: number }[];
  /** foundBy variant: the base combo Uniware calls a bundle, with its components. */
  base?: { sku: string; name: string; components: { sku: string; qty: number }[] };
}

export interface ComboCheckResult {
  /** done = Uniware answered; skipped / failed = only the code rule was applied. */
  status: 'done' | 'skipped' | 'failed';
  /** Why Uniware was not asked / did not answer. */
  reason?: string;
  /** SKUs of "SKU not available in Split1" looked at (Consider? = Yes, units not 0). */
  checked: number;
  /** Combos missing from Split1, confirmed ones first, then most units. */
  combos: ComboAlert[];
  /** SKUs Uniware does not know (e.g. channel / listing codes). */
  unknownInUniware: number;
  /** Looked up in Uniware this time (the rest came from the cache). */
  lookedUp: number;
}

type Cached = UniwareItemType & { at: string; missing?: boolean };
type Gap = { name: string; units: number; channelTypes: Set<string> };

const readCache = async (file: string): Promise<Record<string, Cached>> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, Cached>;
  } catch {
    return {};
  }
};

/** Run `fn` over `items`, `n` at a time. */
const pool = async <T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
};

/** The SKUs to check, from df_gap_split1 (SKU Code, SKU Name, Channel type, Stock Type, Consider?, Row Count, Final Units). */
const gapSkus = (gap: Frame): Map<string, Gap> => {
  const out = new Map<string, Gap>();
  if (!gap.length) return out;
  const sku = gap.get('SKU Code');
  const name = gap.has('SKU Name') ? gap.get('SKU Name') : sku.map(() => '');
  const ct = gap.has('Channel type') ? gap.get('Channel type') : sku.map(() => '');
  const consider = gap.get('Consider?');
  const units = toNum(gap.get('Final Units'));
  sku.forEach((s, i) => {
    if (consider[i] !== 'Yes' || !units[i] || !s) return;
    const key = String(s);
    const g = out.get(key) ?? { name: String(name[i] ?? ''), units: 0, channelTypes: new Set<string>() };
    g.units += units[i];
    if (ct[i]) g.channelTypes.add(String(ct[i]));
    out.set(key, g);
  });
  return out;
};

/** The base combo of a variant code (CMB47B2b -> CMB47, SCMB112_S -> SCMB112), or null when it has no variant suffix. */
export const baseOf = (sku: string): string | null => {
  let b = sku;
  while (COMBO_VARIANT_SUFFIX_RE.test(b)) b = b.replace(COMBO_VARIANT_SUFFIX_RE, '');
  return b && b !== sku ? b : null;
};

/** Judge every SKU on its code and (when known) Uniware's answer; see the table at the top. */
const classify = (skus: Map<string, Gap>, uniware: (sku: string) => Cached | 'not checked' | undefined): ComboAlert[] => {
  const combos: ComboAlert[] = [];
  for (const [sku, g] of skus) {
    const it = uniware(sku);
    const byCode = COMBO_CODE_RE.test(sku);
    const type = it === 'not checked' || it === undefined ? 'not checked' : it.missing ? 'unknown' : it.type.toUpperCase() || 'unknown';
    const bundle = type === 'BUNDLE';
    if (!bundle && !byCode) continue;
    const known = typeof it === 'object' && !it.missing ? it : null;
    // a single item / unknown with a combo code: is it a pack of a base combo?
    const baseSku = !bundle ? baseOf(sku) : null;
    const bi = baseSku ? uniware(baseSku) : undefined;
    const base = typeof bi === 'object' && !bi.missing && bi.type.toUpperCase() === 'BUNDLE' ? { sku: bi.sku || (baseSku as string), name: bi.name, components: bi.components } : undefined;
    combos.push({
      sku,
      name: known?.name || g.name,
      channelTypes: [...g.channelTypes].sort().join(', '),
      units: Math.round(g.units),
      foundBy: bundle ? (byCode ? 'uniware+code' : 'uniware') : base ? 'variant' : 'code-only',
      uniwareType: type,
      components: bundle && known ? known.components : [],
      ...(base ? { base } : {}),
    });
  }
  const rank = (c: ComboAlert) => (c.foundBy === 'code-only' ? 2 : c.foundBy === 'variant' ? 1 : 0);
  return combos.sort((a, b) => rank(a) - rank(b) || b.units - a.units || (a.sku < b.sku ? -1 : 1));
};

const FOUND_BY_LABEL: Record<ComboFoundBy, string> = {
  'uniware+code': 'Uniware bundle + CMB code',
  uniware: 'Uniware bundle',
  variant: 'Variant of a combo',
  'code-only': 'CMB code only',
};

const writeFiles = async (outDir: string, combos: ComboAlert[]): Promise<void> => {
  await writeAtomic(path.join(outDir, COMBO_CHECK.ALERT_FILE), toCsv([
    ['Combo SKU', 'Combo Name', 'Found by', 'Uniware type', 'Base combo', 'Channel types', 'Final Units', 'Components (Uniware)', 'Component count'],
    ...combos.map((c) => {
      const parts = c.components.length ? c.components : c.base?.components ?? [];
      return [
        c.sku, c.name, FOUND_BY_LABEL[c.foundBy], c.uniwareType, c.base?.sku ?? '', c.channelTypes, String(c.units),
        parts.map((x) => `${x.sku} x${x.qty}`).join('; '), parts.length ? String(parts.reduce((t, x) => t + x.qty, 0)) : '',
      ];
    }),
  ]));
  // Split1 lists a component once per unit in the combo (2 of a product = 2 rows), as load_split counts them; only
  // combos whose components Uniware gave.
  await writeAtomic(path.join(outDir, COMBO_CHECK.SPLIT1_ROWS_FILE), toCsv([
    ['SKU Code', 'Split SKU'],
    ...combos.flatMap((c) => c.components.flatMap((x) => Array.from({ length: x.qty }, () => [c.sku, x.sku]))),
  ]));
};

const summary = (combos: ComboAlert[]): string => {
  const n = (f: ComboFoundBy[]) => combos.filter((c) => f.includes(c.foundBy)).length;
  const list = combos.slice(0, 10).map((c) => c.sku).join(', ');
  return `${combos.length} combo(s) not in Split1 (${n(['uniware+code', 'uniware'])} confirmed by Uniware, ${n(['variant'])} variant(s) of a combo, ${n(['code-only'])} by CMB code only)${combos.length ? `: ${list}${combos.length > 10 ? ' ...' : ''}` : ''}`;
};

export const checkCombos = async (
  gap: Frame,
  cfg: UniwareConfig | null,
  dirs: { cacheDir: string; outDir: string },
  log: Log,
): Promise<ComboCheckResult> => {
  const skus = gapSkus(gap);
  const cacheFile = path.join(dirs.cacheDir, COMBO_CHECK.CACHE_FILE);
  const cache = await readCache(cacheFile);

  /** Without Uniware: the code rule alone (cached Uniware answers still used). */
  const codeOnly = async (status: 'skipped' | 'failed', reason: string, lookedUp: number): Promise<ComboCheckResult> => {
    const combos = classify(skus, (s) => cache[s] ?? 'not checked');
    await writeFiles(dirs.outDir, combos);
    log(`combo check ${status} (${reason}); by code: ${summary(combos)}`);
    return { status, reason, checked: skus.size, combos, unknownInUniware: 0, lookedUp };
  };

  if (!cfg?.tenant || !cfg.username || !cfg.password) return codeOnly('skipped', 'No Uniware login in .env', 0);
  const fresh = Date.now() - COMBO_CHECK.CACHE_DAYS * 86400000;
  const toLook = [...skus.keys()].filter((s) => !cache[s] || Date.parse(cache[s].at) < fresh);
  log(`combo check: ${skus.size} SKUs not in Split1, ${toLook.length} to look up in Uniware (${skus.size - toLook.length} from the cache)`);

  let done = 0;
  try {
    const api = uniwareCatalog(cfg);
    await pool(toLook, COMBO_CHECK.PARALLEL, async (sku) => {
      const it = await getItemType(api, sku);
      cache[sku] = it ? { ...it, at: new Date().toISOString() } : { sku, name: '', type: '', components: [], at: new Date().toISOString(), missing: true };
      if (++done % 200 === 0) log(`  ... ${done} / ${toLook.length} looked up`);
    });
  } catch (err) {
    await writeAtomic(cacheFile, JSON.stringify(cache)).catch(() => undefined); // keep what was looked up
    return codeOnly('failed', err instanceof Error ? err.message : String(err), done);
  }
  // the base codes of combo-coded single items / unknowns (CMB47B2b -> CMB47): is the base a bundle?
  const bases = [...new Set([...skus.keys()]
    .filter((s) => COMBO_CODE_RE.test(s) && cache[s] && (cache[s].missing || cache[s].type.toUpperCase() !== 'BUNDLE'))
    .map(baseOf).filter((b): b is string => !!b && (!cache[b] || Date.parse(cache[b].at) < fresh)))];
  try {
    const api = uniwareCatalog(cfg);
    await pool(bases, COMBO_CHECK.PARALLEL, async (sku) => {
      const it = await getItemType(api, sku);
      cache[sku] = it ? { ...it, at: new Date().toISOString() } : { sku, name: '', type: '', components: [], at: new Date().toISOString(), missing: true };
    });
  } catch (err) {
    log(`combo check: base codes not looked up (${err instanceof Error ? err.message : String(err)})`);
  }
  await writeAtomic(cacheFile, JSON.stringify(cache));

  const combos = classify(skus, (s) => cache[s]);
  await writeFiles(dirs.outDir, combos);
  const unknown = [...skus.keys()].filter((s) => cache[s]?.missing).length;
  log(`combo check: ${summary(combos)}; ${unknown} SKU(s) unknown in Uniware`);
  return { status: 'done', checked: skus.size, combos, unknownInUniware: unknown, lookedUp: toLook.length };
};
