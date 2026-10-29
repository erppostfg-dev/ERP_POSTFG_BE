import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { FACILITY_GROUPS, INTRANSIT_FOLDERS, SKU_COMPONENT_STAGE, SkuComponentStage, TABLES } from '../../constants';
import { mastersDir } from './input-store';
import { decodeText, tokenizeCsv } from './io';
import { readXlsxSheet, textXlsx, TextSheet } from './sources/files';
import { Log } from './sources/http';
import { getItem, uniwareCatalog, UniwareItem } from './sources/uniware';

/*
 * npm run intransit:masters: the in-transit masters move from files into the database (user, 2026-10-22/23; plan
 * ~/.claude/plans/intransit-data-plan-v2.md, Parts B, C, D). DRY RUN by default: nothing is written, a change log
 * workbook is saved for review; --apply writes everything in ONE transaction.
 *
 * Rules (user):
 *   - existing rows only get values in the NEW columns; existing values are never changed;
 *   - Uniware's item master is the source of truth for combos and SKUs: a Split1 combo Uniware has as a BUNDLE gets
 *     Uniware's parts and quantities (logged old -> new); a SKU split into itself n times becomes qty 1 (logged);
 *     SKUs missing from master_skus are added from Uniware (disabled there = inactive; unknown = code only, inactive);
 *   - Sheet35(2) is kept as the user's own sheet (intransit_name / _type / _category / _mrp / _cogs);
 *   - in-transit-only locations are added INACTIVE (PO matching loads active locations only).
 * The new table master_sku_components and the temporary intransit_channel_sku_map are reloaded in full.
 */

export interface ImportResult {
  logFile: string;
  summary: [string, string][];
  applied: boolean;
}

const DAY_MS = 86_400_000;
const CACHE_FILE = 'uniware_item_master.json';
const CACHE_MAX_AGE_MS = DAY_MS;
const UNIWARE_PARALLEL = 4;
const CHUNK = 500;
const CHANNEL_SKU_WORKBOOK = 'Channel SKU Mapping - SKU Channel Code.xlsx';
/** Location Master channels that are not sales channels: added to master_channels inactive (slug, display name). */
const PSEUDO_CHANNELS: [string, string][] = [['website', 'Website'], ['hyp-website', 'HYP_Website'], ['darkstore', 'DarkStore']];
/** Code types that, in the rows proven from real data, belong to one channel only (review workbook rule). */
const CODE_TYPE_CHANNEL: [RegExp, string][] = [
  [/^X00[A-Z0-9]{7}$/i, 'Amazon'], [/^(MCFN|HYPN|HHHN)[A-Z0-9]{8,}$/i, 'Myntra'], [/^NY[A-Z0-9]+$/i, 'Nykaa'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Zepto'], [/^\d{5}$/, 'Scootsy Logistics'],
];

const lc = (s: unknown): string => String(s ?? '').trim().toLowerCase();
const key = (s: unknown): string => lc(s).replace(/[^a-z0-9]/g, '');
const txt = (s: unknown): string | null => (String(s ?? '').trim() ? String(s).trim() : null);
const num = (s: unknown): number | null => {
  const t = String(s ?? '').replace(/,/g, '').trim();
  return t !== '' && Number.isFinite(Number(t)) ? Number(t) : null;
};

const readCsv = (file: string): Record<string, string>[] => {
  const [h = [], ...rows] = tokenizeCsv(decodeText(new Uint8Array(fs.readFileSync(file))));
  const head = h.map((x) => x.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
};
const sheetRecords = (raw: Uint8Array, sheet: string): Record<string, string>[] => {
  const [h = [], ...rows] = readXlsxSheet(raw, sheet) ?? [];
  return rows.filter((r) => r.some((c) => (c ?? '').trim())).map((r) => Object.fromEntries(h.map((k, i) => [k.trim(), (r[i] ?? '').trim()])));
};

type Part = { sku: string; qty: number };

/** A split file as combo -> parts in first-appearance order, quantity = number of rows of that part. */
const splitOf = (rows: Record<string, string>[]): Map<string, { combo: string; parts: Part[] }> => {
  const out = new Map<string, { combo: string; parts: Part[] }>();
  for (const r of rows) {
    const combo = r['SKU Code']; const part = r['Split SKU'];
    if (!combo || !part) continue;
    const e = out.get(lc(combo)) ?? { combo, parts: [] };
    const p = e.parts.find((x) => lc(x.sku) === lc(part));
    if (p) p.qty++; else e.parts.push({ sku: part, qty: 1 });
    out.set(lc(combo), e);
  }
  return out;
};
const sameParts = (a: Part[], b: Part[]): boolean =>
  a.length === b.length && a.every((x) => b.some((y) => lc(y.sku) === lc(x.sku) && y.qty === x.qty));
const partsText = (p: Part[]): string => p.map((x) => `${x.sku} x${x.qty}`).join(', ');

/**
 * Uniware items, cached for a day in INTRANSIT_DIR/cache (null = Uniware does not know the SKU). With useUniware false
 * (`--no-uniware`, user 2026-10-25: Uniware refused the catalog with 403) nothing is looked up: an empty map, so every
 * SKU counts as "not checked".
 */
const uniwareItems = async (skus: string[], log: Log, useUniware = true): Promise<Map<string, UniwareItem | null>> => {
  if (!useUniware) return new Map();
  const cacheFile = path.join(path.resolve(env.intransit.dir), INTRANSIT_FOLDERS.CACHE, CACHE_FILE);
  let cache: { at: number; items: Record<string, UniwareItem | null> } = { at: Date.now(), items: {} };
  try {
    const c = JSON.parse(await fsp.readFile(cacheFile, 'utf8')) as typeof cache;
    if (Date.now() - c.at < CACHE_MAX_AGE_MS) cache = c;
  } catch {
    // no cache yet
  }
  const todo = [...new Set(skus.map(lc))].filter((s) => s && !(s in cache.items));
  if (todo.length) {
    const u = env.intransit.uniware;
    if (!u.tenant || !u.username || !u.password) throw new Error('Uniware login missing in .env (UNIWARE_*): it is the source of truth for SKUs and combos');
    const api = uniwareCatalog(u);
    log(`Uniware: looking up ${todo.length} SKUs (${Object.keys(cache.items).length} cached) ...`);
    const queue = [...todo];
    let done = 0;
    await Promise.all(Array.from({ length: UNIWARE_PARALLEL }, async () => {
      while (queue.length) {
        const s = queue.shift() as string;
        cache.items[s] = await getItem(api, s);
        if (++done % 200 === 0) log(`  ${done} / ${todo.length}`);
      }
    }));
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(cache));
  }
  return new Map(Object.entries(cache.items));
};

/**
 * A master_skus row for a SKU the masters name but the product master lacks: from Uniware's item (the source of truth;
 * disabled there = inactive), or the code alone, inactive, when Uniware has no item for it.
 */
export const skuRowFrom = (it: UniwareItem | null, spelling: string, name: string | null) => ({
  pep_code: it?.sku ?? spelling,
  product_name: it?.name || name || null,
  mrp: it?.mrp ?? null, ean_code: it?.ean ?? null, brand_name: it?.brand ?? null, hsn_code: it?.hsnCode ?? null,
  is_active: it ? (it.enabled ? 1 : 0) : 0,
  product_type: it && it.type.toUpperCase() === 'BUNDLE' ? 'Combo' : null,
  gst_tax_type: it?.gstTaxTypeCode ?? null,
  length_mm: it?.lengthMm ?? null, width_mm: it?.widthMm ?? null, height_mm: it?.heightMm ?? null, weight_g: it?.weightG ?? null,
  determine_expiry_from: it?.determineExpiryFrom ?? null, shelf_life: it?.shelfLife ?? null,
});

export const importIntransitMasters = async (opts: { apply: boolean; log: Log; outDir: string; uniware?: boolean }): Promise<ImportResult> => {
  const { log } = opts;
  const useUniware = opts.uniware !== false;
  if (!useUniware) log('Uniware NOT checked (--no-uniware): combos keep the files\' parts, missing SKUs are added code-only and inactive');
  const M = mastersDir();
  const file = (n: string) => path.join(M, n);
  const fsm = readCsv(file('Final SKU Mapping.csv'));
  const s35 = readCsv(file('Sheet35(2).csv'));
  const notConsider = readCsv(file('SKU-Not To Consider.csv')).map((r) => r['Item SkuCode'] ?? Object.values(r)[0]).filter(Boolean);
  const split1 = splitOf(readCsv(file('Split1.csv')));
  const split2 = splitOf(readCsv(file('Split2.csv')));
  const locMaster = readCsv(file('Location Master.csv'));
  const myntraWh = readCsv(file('MyntraWHIDs.csv'));
  const oldCsm = readCsv(file('Channel SKU Mapping.csv'));
  const csmBook = new Uint8Array(await fsp.readFile(path.join(path.resolve(env.intransit.dir), 'import', CHANNEL_SKU_WORKBOOK)));
  const csmRows = sheetRecords(csmBook, 'Mapping');
  const csmNoChannel = sheetRecords(csmBook, 'No channel found');
  log(`files: Final SKU Mapping ${fsm.length}, Sheet35(2) ${s35.length}, Not To Consider ${notConsider.length}, Split1 ${split1.size} combos, Split2 ${split2.size}, Location Master ${locMaster.length}, MyntraWHIDs ${myntraWh.length}, channel SKU rows ${csmRows.length} + ${csmNoChannel.length} without channel`);

  // ---- database state (read only)
  const q = <T>(sql: string, p: unknown[] = []) => AppDataSource.query(sql, p) as Promise<T[]>;
  const skuRows = await q<{ pep_code: string }>(`SELECT pep_code FROM ${TABLES.MASTER_SKUS}`);
  const skuCase = new Map(skuRows.map((r) => [lc(r.pep_code), r.pep_code]));
  const channels = await q<{ id: number; display_name: string; slug: string; db_aliases: string[] | string | null }>(`SELECT id, display_name, slug, db_aliases FROM ${TABLES.MASTER_CHANNELS}`);
  const locations = await q<{ id: string; channel_id: number; channel_location_code: string | null; intransit_location: string | null }>(
    `SELECT id, channel_id, channel_location_code, intransit_location FROM ${TABLES.DETAILS_CHANNELS}`);
  const facilities = await q<{ id: number; code: string; aliases: string[] | string | null; intransit_group: string | null; intransit_type: string | null }>(
    `SELECT id, code, aliases, intransit_group, intransit_type FROM ${TABLES.MASTER_FACILITIES}`);

  // ---- 1. combos: Uniware decides (Split1); self-splits fixed (both stages)
  const comboLog: string[][] = [['Stage', 'Combo', 'In the file', 'In Uniware', 'Stored', 'Why']];
  const items = await uniwareItems([...split1.values()].map((c) => c.combo), log, useUniware);
  const parts: { stage: SkuComponentStage; combo: string; parts: Part[] }[] = [];
  for (const [stage, split] of [[SKU_COMPONENT_STAGE.SPLIT1, split1], [SKU_COMPONENT_STAGE.SPLIT2, split2]] as const) {
    for (const { combo, parts: fileParts } of split.values()) {
      const it = stage === SKU_COMPONENT_STAGE.SPLIT1 ? items.get(lc(combo)) : undefined;
      let stored = fileParts;
      let why = '';
      if (it && it.type.toUpperCase() === 'BUNDLE' && it.components.length && !sameParts(fileParts, it.components)) {
        stored = it.components; why = 'Uniware bundle differs: Uniware used';
      } else if (fileParts.length === 1 && lc(fileParts[0].sku) === lc(combo) && fileParts[0].qty > 1) {
        stored = [{ sku: fileParts[0].sku, qty: 1 }]; why = `split into itself x${fileParts[0].qty}: qty 1`;
      } else if (stage === SKU_COMPONENT_STAGE.SPLIT1 && it === null) why = 'not in Uniware: file kept';
      if (why) comboLog.push([stage, combo, partsText(fileParts), it ? `${it.type} ${partsText(it.components)}` : it === null ? 'not in Uniware' : '', partsText(stored), why]);
      parts.push({ stage, combo, parts: stored });
    }
  }

  // ---- 2. every SKU the masters name must be a master_skus row (FK of the parts)
  const named = new Map<string, string>(); // lc -> spelling
  const name = (s: string | null | undefined) => { if (s && s.trim() && !named.has(lc(s))) named.set(lc(s), s.trim()); };
  fsm.forEach((r) => { name(r.Listing_SKU); name(r['Final SKU']); });
  s35.forEach((r) => name(r['SKU Code']));
  notConsider.forEach(name);
  parts.forEach((c) => { name(c.combo); c.parts.forEach((p) => name(p.sku)); });
  const missing = [...named.entries()].filter(([k]) => !skuCase.has(k));
  const missingItems = await uniwareItems(missing.map(([, s]) => s), log, useUniware);
  const s35By = new Map(s35.map((r) => [lc(r['SKU Code']), r]));
  const newSkus = missing.map(([k, spelling]) => {
    const it = missingItems.get(k) ?? null;
    return {
      ...skuRowFrom(it, spelling, s35By.get(k)?.['SKU Name'] || null),
      _from: it ? (it.enabled ? 'Uniware' : 'Uniware (disabled -> inactive)') : useUniware ? 'not in Uniware: code only, inactive' : 'Uniware not checked: code only, inactive',
    };
  });
  newSkus.forEach((n) => skuCase.set(lc(n.pep_code), n.pep_code));

  // ---- 3. new columns on master_skus
  type SkuCols = { final_pep_code?: string; intransit_consider?: number; intransit_name?: string | null; intransit_type?: string | null; intransit_category?: string | null; intransit_mrp?: number | null; intransit_cogs?: number | null };
  const cols = new Map<string, SkuCols>();
  const set = (sku: string, v: SkuCols) => { const k = lc(sku); cols.set(k, { ...(cols.get(k) ?? {}), ...v }); };
  const fsmSeen = new Set<string>();
  for (const r of fsm) { if (!r.Listing_SKU || fsmSeen.has(lc(r.Listing_SKU))) continue; fsmSeen.add(lc(r.Listing_SKU)); set(r.Listing_SKU, { final_pep_code: r['Final SKU'] }); }
  for (const r of s35) set(r['SKU Code'], { intransit_name: txt(r['SKU Name']), intransit_type: txt(r.Type), intransit_category: txt(r.Count), intransit_mrp: num(r.MRP), intransit_cogs: num(r['COGS (With TAX)']) });
  for (const s of notConsider) set(s, { intransit_consider: 0 });

  // ---- 4. channels and locations
  const chIdx = new Map<string, { id: number | null; name: string }>();
  for (const c of channels) {
    const aliases = Array.isArray(c.db_aliases) ? c.db_aliases : c.db_aliases ? (JSON.parse(c.db_aliases) as string[]) : [];
    for (const a of [c.display_name, c.slug, ...aliases]) if (!chIdx.has(key(a))) chIdx.set(key(a), { id: c.id, name: c.display_name });
  }
  const newChannels = PSEUDO_CHANNELS.filter(([slug, dn]) => !chIdx.has(key(dn)) && !chIdx.has(key(slug)));
  newChannels.forEach(([, dn]) => chIdx.set(key(dn), { id: null, name: dn }));
  const locIdx = new Map<string, typeof locations>();
  for (const l of locations) { const k = `${l.channel_id}|${lc(l.channel_location_code)}`; locIdx.set(k, [...(locIdx.get(k) ?? []), l]); }
  const locLog: string[][] = [['Channel', 'Code', 'Report location', 'From', 'Action']];
  const locUpdates: { id: string; loc: string }[] = [];
  const locInserts: { channel: string; code: string; loc: string }[] = [];
  const seenLoc = new Set<string>();
  const placeLoc = (chName: string, code: string, loc: string, from: string, last = false) => {
    const ch = chIdx.get(key(chName));
    if (!ch) { locLog.push([chName, code, loc, from, 'SKIPPED: channel not in master_channels']); return; }
    const k = `${ch.name}|${lc(code)}`;
    if (seenLoc.has(k) && !last) { locLog.push([ch.name, code, loc, from, 'duplicate in the file: first kept']); return; }
    if (last) { // MyntraWHIDs: the last row of an id wins (as the report reads it)
      const i = locInserts.findIndex((x) => `${x.channel}|${lc(x.code)}` === k);
      if (i >= 0) locInserts.splice(i, 1);
      for (let j = locUpdates.length - 1; j >= 0; j--) if (ch.id !== null && (locIdx.get(`${ch.id}|${lc(code)}`) ?? []).some((l) => l.id === locUpdates[j].id)) locUpdates.splice(j, 1);
    }
    seenLoc.add(k);
    const existing = ch.id === null ? [] : locIdx.get(`${ch.id}|${lc(code)}`) ?? [];
    if (existing.length) {
      existing.forEach((l) => { if (l.intransit_location !== loc) locUpdates.push({ id: l.id, loc }); });
      locLog.push([ch.name, code, loc, from, existing.some((l) => l.intransit_location !== loc) ? `existing location(s) ${existing.map((l) => l.id).join(', ')}: report location set` : 'same']);
    } else {
      locInserts.push({ channel: ch.name, code, loc });
      locLog.push([ch.name, code, loc, from, 'added INACTIVE (in-transit only)']);
    }
  };
  for (const r of locMaster) if (r['Fulfillment Centre-ID'] && r['Final Location']) placeLoc(r.Channel, r['Fulfillment Centre-ID'], r['Final Location'], 'Location Master');
  const lmMyntra = new Map(locMaster.filter((r) => key(r.Channel) === 'myntra').map((r) => [lc(r['Fulfillment Centre-ID']), r['Final Location']]));
  for (const r of myntraWh) {
    if (!r['WH Id'] || !r['WH location']) continue;
    if (lmMyntra.has(lc(r['WH Id'])) && lmMyntra.get(lc(r['WH Id'])) !== r['WH location']) { locLog.push(['Myntra', r['WH Id'], r['WH location'], 'MyntraWHIDs', 'CONFLICT with Location Master: skipped']); continue; }
    placeLoc('Myntra', r['WH Id'], r['WH location'], 'MyntraWHIDs', true);
  }

  // ---- 5. warehouse buckets (exactly FACILITY_GROUPS: the stock the report counts today)
  const facLog: string[][] = [['Facility', 'Report bucket', 'Type', 'Action']];
  const facUpdates: { id: number; group: string; type: string }[] = [];
  for (const [group, type, codes] of FACILITY_GROUPS) {
    for (const code of codes) {
      const hits = facilities.filter((f) => lc(f.code) === lc(code) || (Array.isArray(f.aliases) ? f.aliases : f.aliases ? (JSON.parse(f.aliases) as string[]) : []).some((a) => lc(a) === lc(code)));
      if (!hits.length) { facLog.push([code, group, type, 'NOT in master_facilities']); continue; }
      for (const f of hits) {
        if (f.intransit_group === group && f.intransit_type === type) { facLog.push([f.code, group, type, 'same']); continue; }
        facUpdates.push({ id: f.id, group, type });
        facLog.push([f.code, group, type, 'set']);
      }
    }
  }
  for (const f of facilities.filter((x) => !facUpdates.some((u) => u.id === x.id) && !facLog.some((l) => lc(l[0]) === lc(x.code)))) {
    facLog.push([f.code, '', '', 'not counted as stock today (unchanged)']);
  }

  // ---- 6. channel SKU mapping (temporary table)
  const srcOf = (how: string): string => (/^in your file/i.test(how) ? 'file' : /^PEPIMS/i.test(how) ? 'pepims_po' : /our database/i.test(how) ? 'master_channel_skus'
    : /stock file/i.test(how) ? 'stock_file' : /^by code type/i.test(how) ? 'code_type' : how || 'file');
  const csm: { sku: string; channel: string | null; code: string; final: string | null; source: string; note: string | null }[] = [];
  const seenCsm = new Set<string>();
  const addCsm = (r: (typeof csm)[number]) => { const k = `${lc(r.channel)}|${lc(r.code)}`; if (!r.code || !r.sku || seenCsm.has(k)) return; seenCsm.add(k); csm.push(r); };
  for (const r of csmRows) addCsm({ sku: r.SKU, channel: txt(r.Channel), code: r['Channel SKU Code'], final: txt(r['Final SKU']), source: srcOf(r['How the channel was found']), note: /^DIFFERENT/i.test(r.Check ?? '') ? r.Check : null });
  for (const r of csmNoChannel) addCsm({ sku: r.SKU, channel: txt(r['Channel (fill in)']), code: r['Channel SKU Code'], final: txt(r['Final SKU']), source: 'file', note: null });
  const known = new Set(csm.map((r) => lc(r.code)));
  let oldAdded = 0;
  for (const r of oldCsm) {
    const code = r['Channel Codes']; const sku = r['Listing SKU Codes at Channel'];
    if (!code || !sku || /e\+/i.test(code) || known.has(lc(code))) continue;
    addCsm({ sku, channel: CODE_TYPE_CHANNEL.find(([re]) => re.test(code))?.[1] ?? null, code, final: null, source: 'old_csv', note: 'only in the old Channel SKU Mapping.csv' });
    known.add(lc(code)); oldAdded++;
  }

  // ---- change log
  const counts = { skuCols: [...cols.keys()].filter((k) => skuCase.has(k)).length, parts: parts.reduce((n, c) => n + c.parts.length, 0) };
  const summary: [string, string][] = [
    ['Mode', opts.apply ? 'APPLIED (one transaction)' : 'DRY RUN: nothing written'],
    ['master_skus: new SKUs', String(newSkus.length)],
    ['  from Uniware (active / inactive)', `${newSkus.filter((n) => n._from === 'Uniware').length} / ${newSkus.filter((n) => n._from.startsWith('Uniware (')).length}`],
    ['  not in Uniware (code only, inactive)', String(newSkus.filter((n) => n._from.startsWith('not')).length)],
    ['  Uniware not checked (code only, inactive)', String(newSkus.filter((n) => n._from.startsWith('Uniware not')).length)],
    ['Uniware checks', useUniware ? 'done' : 'SKIPPED (--no-uniware): re-run with Uniware access to check combos and SKUs'],
    ['master_skus: SKUs getting the new columns', String(counts.skuCols)],
    ['master_sku_components: combos / part rows', `${parts.length} / ${counts.parts}`],
    ['  combos changed by the Uniware rule', String(comboLog.length - 1)],
    ['master_channels: new inactive channels', newChannels.map(([, d]) => d).join(', ') || 'none'],
    ['details_channels: report location set on existing rows', String(locUpdates.length)],
    ['details_channels: new INACTIVE in-transit locations', String(locInserts.length)],
    ['master_facilities: buckets set', String(facUpdates.length)],
    ['intransit_channel_sku_map: rows (with channel / without)', `${csm.length} (${csm.filter((r) => r.channel).length} / ${csm.filter((r) => !r.channel).length})`],
    ['  of which only in the old CSV', String(oldAdded)],
  ];
  const sheets: TextSheet[] = [
    { name: 'Summary', rows: [['What', 'Count'], ...summary], widths: [60, 50] },
    { name: 'New SKUs', rows: [['SKU', 'Name', 'Active', 'MRP', 'EAN', 'Type', 'From'], ...newSkus.map((n) => [n.pep_code, n.product_name ?? '', n.is_active ? 'yes' : 'no', n.mrp === null ? '' : String(n.mrp), n.ean_code ?? '', n.product_type ?? '', n._from])], widths: [22, 50, 8, 10, 16, 10, 36] },
    { name: 'Combo changes', rows: comboLog, widths: [8, 20, 50, 50, 50, 40] },
    { name: 'Combo parts', rows: [['Stage', 'Combo', 'Part', 'Qty', 'Position'], ...parts.flatMap((c) => c.parts.map((p, i) => [c.stage, c.combo, p.sku, String(p.qty), String(i + 1)]))], widths: [8, 22, 22, 6, 8] },
    { name: 'SKU columns', rows: [['SKU', 'final_pep_code', 'intransit_consider', 'intransit_name', 'intransit_type', 'intransit_category', 'intransit_mrp', 'intransit_cogs'],
      ...[...cols.entries()].map(([k, v]) => [skuCase.get(k) ?? k, v.final_pep_code ?? '', v.intransit_consider === 0 ? '0' : '', v.intransit_name ?? '', v.intransit_type ?? '', v.intransit_category ?? '', v.intransit_mrp === undefined || v.intransit_mrp === null ? '' : String(v.intransit_mrp), v.intransit_cogs === undefined || v.intransit_cogs === null ? '' : String(v.intransit_cogs)])], widths: [22, 22, 10, 40, 12, 16, 10, 10] },
    { name: 'Locations', rows: locLog, widths: [16, 22, 18, 16, 50] },
    { name: 'Facilities', rows: facLog, widths: [30, 14, 10, 36] },
    { name: 'Channel SKU map', rows: [['SKU', 'Channel', 'Channel SKU Code', 'Final SKU', 'Source', 'Review note'], ...csm.map((r) => [r.sku, r.channel ?? '', r.code, r.final ?? '', r.source, r.note ?? ''])], widths: [22, 18, 40, 22, 18, 40] },
  ];
  await fsp.mkdir(opts.outDir, { recursive: true });
  const logFile = path.join(opts.outDir, `masters-import-${opts.apply ? 'applied' : 'dry-run'}-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
  await fsp.writeFile(logFile, textXlsx(sheets));

  if (!opts.apply) return { logFile, summary, applied: false };

  // ---- apply, one transaction
  const now = new Date();
  await AppDataSource.transaction(async (m) => {
    const insert = async (table: string, rows: Record<string, unknown>[]) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const colsOf = Object.keys(chunk[0]);
        await m.query(`INSERT INTO ${table} (${colsOf.map((c) => `\`${c}\``).join(', ')}) VALUES ${chunk.map(() => `(${colsOf.map(() => '?').join(', ')})`).join(', ')}`,
          chunk.flatMap((r) => colsOf.map((c) => r[c])));
      }
    };
    for (const [slug, dn] of newChannels) {
      const res = (await m.query(`INSERT INTO ${TABLES.MASTER_CHANNELS} (slug, display_name, db_aliases, has_processor, is_active) VALUES (?, ?, ?, 0, 0)`, [slug, dn, JSON.stringify([dn, slug, dn.toLowerCase()])])) as { insertId: number };
      chIdx.set(key(dn), { id: res.insertId, name: dn });
    }
    if (newSkus.length) await insert(TABLES.MASTER_SKUS, newSkus.map(({ _from, ...r }) => ({ ...r, created_at: now, updated_at: now })));
    for (const [k, v] of cols) {
      const pep = skuCase.get(k);
      if (!pep) continue;
      const entries = Object.entries(v);
      if (entries.length) await m.query(`UPDATE ${TABLES.MASTER_SKUS} SET ${entries.map(([c]) => `\`${c}\` = ?`).join(', ')} WHERE pep_code = ?`, [...entries.map(([, x]) => x), pep]);
    }
    await m.query(`DELETE FROM ${TABLES.MASTER_SKU_COMPONENTS}`);
    await insert(TABLES.MASTER_SKU_COMPONENTS, parts.flatMap((c) => c.parts.map((p, i) => ({ stage: c.stage, combo_pep_code: skuCase.get(lc(c.combo)) ?? c.combo, component_pep_code: skuCase.get(lc(p.sku)) ?? p.sku, qty: p.qty, position: i + 1 }))));
    for (const u of locUpdates) await m.query(`UPDATE ${TABLES.DETAILS_CHANNELS} SET intransit_location = ? WHERE id = ?`, [u.loc, u.id]);
    if (locInserts.length) {
      await insert(TABLES.DETAILS_CHANNELS, locInserts.map((l) => {
        const ch = chIdx.get(key(l.channel)) as { id: number; name: string };
        return { channel_id: ch.id, channel_name: ch.name, channel_location_code: l.code, intransit_location: l.loc, is_active: 0, created_at: now, updated_at: now };
      }));
    }
    for (const u of facUpdates) await m.query(`UPDATE ${TABLES.MASTER_FACILITIES} SET intransit_group = ?, intransit_type = ? WHERE id = ?`, [u.group, u.type, u.id]);
    await m.query(`DELETE FROM ${TABLES.INTRANSIT_CHANNEL_SKU_MAP}`);
    await insert(TABLES.INTRANSIT_CHANNEL_SKU_MAP, csm.map((r) => ({ sku_code: r.sku, channel: r.channel, channel_sku_code: r.code, final_sku: r.final, source: r.source, review_note: r.note, is_active: 1 })));
  });
  return { logFile, summary, applied: true };
};
