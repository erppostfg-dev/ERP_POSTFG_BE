import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { SKU_COMPONENT_STAGE, TABLES } from '../../constants';
import { writeAtomic } from './sources/files';

/*
 * The in-transit masters as the pipeline reads them, written FROM THE DATABASE into a build's snapshot (user,
 * 2026-10-23; INTRANSIT_MASTERS_SOURCE=db). Same file names, headers and value forms as the uploaded files, so the
 * pipeline does not change:
 *   Final SKU Mapping.csv   master_skus.final_pep_code
 *   Split1.csv / Split2.csv master_sku_components (one row per unit, parts in position order, combos in load order)
 *   Sheet35(2).csv          master_skus.intransit_name / _type / _category / _mrp / _cogs
 *   SKU-Not To Consider.csv master_skus.intransit_consider = 0
 *   Location Master.csv     details_channels.intransit_location (Myntra warehouse ids excluded)
 *   MyntraWHIDs.csv         details_channels.intransit_location of Myntra rows whose code is a number (warehouse id)
 *   Channel SKU Mapping.csv intransit_channel_sku_map (Amazon / Flipkart / Myntra rows first: the report keeps the
 *                           first SKU of a code)
 */

const MARKETPLACES = ['amazon', 'flipkart', 'myntra'];
export const DB_MASTER_FILES = [
  'Final SKU Mapping.csv', 'Split1.csv', 'Split2.csv', 'Sheet35(2).csv', 'SKU-Not To Consider.csv', 'Location Master.csv', 'MyntraWHIDs.csv',
  'Channel SKU Mapping.csv',
] as const;

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const toCsv = (rows: string[][]): string => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
/** A decimal as the sheets write it: "449.00" -> "449", "98.69" -> "98.69"; blank for null. */
const dec = (v: unknown): string => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The 8 files from the database, as CSV text by file name (nothing is written: previews and builds use the bytes). */
export const mastersFromDb = async (): Promise<Record<(typeof DB_MASTER_FILES)[number], string>> => {
  const q = <T>(sql: string, p: unknown[] = []) => AppDataSource.query(sql, p) as Promise<T[]>;
  const out: Record<string, string[][]> = {};

  const fsm = await q<{ pep_code: string; final_pep_code: string }>(`SELECT pep_code, final_pep_code FROM ${TABLES.MASTER_SKUS} WHERE final_pep_code IS NOT NULL ORDER BY id`);
  out['Final SKU Mapping.csv'] = [['Listing_SKU', 'Final SKU'], ...fsm.map((r) => [r.pep_code, r.final_pep_code])];

  const comp = await q<{ stage: string; combo_pep_code: string; component_pep_code: string; qty: number }>(
    `SELECT stage, combo_pep_code, component_pep_code, qty FROM ${TABLES.MASTER_SKU_COMPONENTS} ORDER BY id`);
  for (const [stage, file] of [[SKU_COMPONENT_STAGE.SPLIT1, 'Split1.csv'], [SKU_COMPONENT_STAGE.SPLIT2, 'Split2.csv']] as const) {
    out[file] = [['SKU Code', 'Split SKU'], ...comp.filter((c) => c.stage === stage).flatMap((c) => Array.from({ length: Math.max(1, Number(c.qty)) }, () => [c.combo_pep_code, c.component_pep_code]))];
  }

  const s35 = await q<Record<string, unknown>>(
    `SELECT pep_code, intransit_name, intransit_type, intransit_category, intransit_mrp, intransit_cogs FROM ${TABLES.MASTER_SKUS}
     WHERE intransit_name IS NOT NULL OR intransit_type IS NOT NULL OR intransit_category IS NOT NULL OR intransit_mrp IS NOT NULL OR intransit_cogs IS NOT NULL ORDER BY id`);
  out['Sheet35(2).csv'] = [['SKU Code', 'SKU Name', 'Type', 'Count', 'MRP', 'COGS (With TAX)'],
    ...s35.map((r) => [s(r.pep_code), s(r.intransit_name), s(r.intransit_type), s(r.intransit_category), dec(r.intransit_mrp), dec(r.intransit_cogs)])];

  const nc = await q<{ pep_code: string }>(`SELECT pep_code FROM ${TABLES.MASTER_SKUS} WHERE intransit_consider = 0 ORDER BY id`);
  out['SKU-Not To Consider.csv'] = [['Item SkuCode'], ...nc.map((r) => [r.pep_code])];

  const loc = await q<{ channel_name: string; channel_location_code: string; intransit_location: string }>(
    `SELECT channel_name, channel_location_code, intransit_location FROM ${TABLES.DETAILS_CHANNELS} WHERE intransit_location IS NOT NULL ORDER BY id`);
  const isWh = (r: { channel_name: string; channel_location_code: string }) => r.channel_name.toLowerCase() === 'myntra' && /^\d+$/.test(r.channel_location_code.trim());
  out['Location Master.csv'] = [['UID', 'Channel', 'Fulfillment Centre-ID', 'Final Location'],
    ...loc.filter((r) => !isWh(r)).map((r) => [`${r.channel_name}${r.channel_location_code}`, r.channel_name, r.channel_location_code, r.intransit_location])];
  out['MyntraWHIDs.csv'] = [['WH Id', 'WH location'], ...loc.filter(isWh).map((r) => [r.channel_location_code, r.intransit_location])];

  const csm = await q<{ sku_code: string; channel: string | null; channel_sku_code: string }>(
    `SELECT sku_code, channel, channel_sku_code FROM ${TABLES.INTRANSIT_CHANNEL_SKU_MAP} WHERE is_active = 1 ORDER BY id`);
  const rank = (c: string | null) => { const i = MARKETPLACES.indexOf((c ?? '').toLowerCase()); return i >= 0 ? i : c ? MARKETPLACES.length : MARKETPLACES.length + 1; };
  out['Channel SKU Mapping.csv'] = [['Listing SKU Codes at Channel', 'Channel Codes'],
    ...csm.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.channel) - rank(b.r.channel) || a.i - b.i).map(({ r }) => [r.sku_code, r.channel_sku_code])];

  return Object.fromEntries(DB_MASTER_FILES.map((name) => [name, toCsv(out[name])])) as Record<(typeof DB_MASTER_FILES)[number], string>;
};

/** Write the 8 files into `dir` (a build's temporary input folder) from the database; returns their names. */
export const exportMastersFromDb = async (dir: string): Promise<string[]> => {
  const files = await mastersFromDb();
  for (const name of DB_MASTER_FILES) await writeAtomic(path.join(dir, name), files[name]);
  return [...DB_MASTER_FILES];
};
