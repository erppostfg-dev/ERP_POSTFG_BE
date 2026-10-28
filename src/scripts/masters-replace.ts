/*
 * Replaces the channel masters with a fresh set (2026-10-28, user: "remove the current master and add this, start
 * fresh"; files from the "Post FG - Updated Masters" workbook):
 *   01_master_channels.csv       -> master_channels      (replaced; ids kept)
 *   02_details_channels.csv      -> details_channels     (replaced; ids kept)
 *   03_master_skus_new_rows.csv  -> master_skus          (ADDED only; a pep_code already there is skipped, others untouched)
 *   04_master_channel_skus.csv   -> master_channel_skus  (replaced; ids kept)
 * DRY RUN by default: reads the files, checks every reference (channel ids + names, facility code + id, PEP SKU id +
 * code, the channels the code relies on, no PO rows still pointing at the old rows) and prints old -> new counts and
 * the data gaps. --apply: ONE transaction: delete channel SKUs, locations, channels (foreign-key order), insert
 * channels, new SKUs, locations, channel SKUs (500 rows per statement), check the counts, one activity_log row and one
 * master_change_logs "replaced" row per master (2026-10-28: the Masters History shows the reload).
 * Anything fails -> nothing changes. Take a backup first (dev-tools/masters-backup.ts).
 *
 *   npm run masters:replace -- --dir "<folder>" [--apply] [--by <email>]
 */
import 'reflect-metadata';
import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { CHANNEL_MASTER_IDS, IST_OFFSET_MS, MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE, MasterLogType, TABLES } from '../constants';
import { ActivityLog, User } from '../entities';
import { insertMany } from '../modules/intransit/masters-db';
import { logMasterChanges } from '../modules/masters/master-log';
import { csvRecords } from '../utils/csv';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const FILES = {
  channels: '01_master_channels.csv',
  locations: '02_details_channels.csv',
  newSkus: '03_master_skus_new_rows.csv',
  channelSkus: '04_master_channel_skus.csv',
} as const;

type Rec = Record<string, string>;
const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();
const blank = (s: unknown) => String(s ?? '').trim() === '';

const read = (dir: string, file: string): Rec[] => {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) throw new Error(`missing file: ${p}`);
  return csvRecords(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')).records;
};

/** The table's columns as the DB has them, and which of them are JSON (written as text). */
const columnsOf = async (table: string): Promise<{ cols: string[]; json: Set<string> }> => {
  const rows = (await AppDataSource.query(
    'SELECT COLUMN_NAME c, DATA_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [table],
  )) as { c: string; t: string }[];
  return { cols: rows.map((r) => r.c), json: new Set(rows.filter((r) => r.t === 'json').map((r) => r.c)) };
};

/** File rows -> insert rows for the columns both the file and the table have; '' = NULL. */
const plan = async (table: string, recs: Rec[], problems: string[]) => {
  const { cols, json } = await columnsOf(table);
  const header = Object.keys(recs[0] ?? {});
  const extra = header.filter((h) => !cols.includes(h));
  if (extra.length) problems.push(`${table}: file columns not in the table: ${extra.join(', ')}`);
  const use = header.filter((h) => cols.includes(h));
  const values = recs.map((r) => use.map((c) => {
    const v = (r[c] ?? '').trim();
    if (v === '' || v.toUpperCase() === 'NULL') return null;
    if (json.has(c)) {
      try { JSON.parse(v); } catch { problems.push(`${table} id ${r.id}: ${c} is not valid JSON`); }
    }
    return v;
  }));
  return { cols: use, values };
};

const count = async (table: string): Promise<number> => Number(((await AppDataSource.query(`SELECT COUNT(*) n FROM \`${table}\``)) as { n: string }[])[0].n);

const main = async () => {
  const dir = arg('dir');
  if (!dir) throw new Error('usage: npm run masters:replace -- --dir "<folder>" [--apply] [--by <email>]');
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  const channels = read(dir, FILES.channels);
  const locations = read(dir, FILES.locations);
  const newSkus = read(dir, FILES.newSkus);
  const channelSkus = read(dir, FILES.channelSkus);
  const problems: string[] = [];
  const gaps: string[] = [];

  // ---- channels
  const chById = new Map(channels.map((c) => [c.id, c]));
  if (chById.size !== channels.length) problems.push('master_channels: duplicate ids');
  for (const k of ['slug', 'display_name'] as const) {
    const seen = new Set<string>();
    for (const c of channels) { if (seen.has(lc(c[k]))) problems.push(`master_channels: duplicate ${k} "${c[k]}"`); seen.add(lc(c[k])); }
  }
  for (const [name, id] of Object.entries(CHANNEL_MASTER_IDS)) if (!chById.has(String(id))) problems.push(`the code's channel "${name}" needs master_channels id ${id}: not in the file`);
  const noType = channels.filter((c) => blank(c.channel_type)).map((c) => c.display_name);
  const noExpiry = channels.filter((c) => blank(c.expiry_days_min) || blank(c.expiry_days_max)).map((c) => c.display_name);
  if (noType.length) gaps.push(`channels without channel type (${noType.length}): ${noType.join(', ')}`);
  if (noExpiry.length) gaps.push(`channels without expiry days (${noExpiry.length}): ${noExpiry.join(', ')}`);

  // ---- PEP SKUs: existing + the new rows
  const existing = (await AppDataSource.query(`SELECT id, pep_code FROM ${TABLES.MASTER_SKUS}`)) as { id: string; pep_code: string }[];
  const skuById = new Map(existing.map((s) => [String(s.id), s.pep_code]));
  const skuByCode = new Set(existing.map((s) => lc(s.pep_code)));
  const skusToAdd = newSkus.filter((s) => {
    if (skuByCode.has(lc(s.pep_code))) { gaps.push(`new SKU ${s.pep_code} is already in master_skus: skipped`); return false; }
    if (skuById.has(s.id)) { problems.push(`new SKU ${s.pep_code}: id ${s.id} is taken by ${skuById.get(s.id)}`); return false; }
    return true;
  });
  for (const s of skusToAdd) skuById.set(s.id, s.pep_code);
  const thinSkus = skusToAdd.filter((s) => blank(s.ean_code) || blank(s.hsn_code) || blank(s.gst_tax_type)).map((s) => s.pep_code);
  if (thinSkus.length) gaps.push(`new SKUs without EAN / HSN / GST (${thinSkus.length}): ${thinSkus.join(', ')}`);

  // ---- locations
  const facilities = (await AppDataSource.query(`SELECT id, code FROM ${TABLES.MASTER_FACILITIES}`)) as { id: number; code: string }[];
  const facByCode = new Map(facilities.map((f) => [f.code, Number(f.id)])); // exact (main / child warehouses differ in case)
  const locIds = new Set<string>();
  for (const l of locations) {
    if (locIds.has(l.id)) problems.push(`details_channels: duplicate id ${l.id}`);
    locIds.add(l.id);
    const ch = chById.get(l.channel_id);
    if (!ch) { problems.push(`location ${l.id} (${l.channel_location_code}): channel id ${l.channel_id} not in the channel file`); continue; }
    if (l.channel_name !== ch.display_name) problems.push(`location ${l.id}: channel_name "${l.channel_name}" is not the channel's name "${ch.display_name}"`);
    if (!blank(l.facility_code)) {
      const id = facByCode.get(l.facility_code.trim());
      if (id === undefined) problems.push(`location ${l.id}: facility ${l.facility_code} not in master_facilities`);
      else if (!blank(l.facility_id) && Number(l.facility_id) !== id) problems.push(`location ${l.id}: facility_id ${l.facility_id} is not ${l.facility_code}'s id ${id}`);
    }
  }
  const missing = (col: string) => locations.filter((l) => blank(l[col])).length;
  for (const [col, label] of [['facility_code', 'facility'], ['consignee_state', 'consignee state'], ['consignee_pin_code', 'consignee pincode'],
    ['consignee_gst_number', 'consignee GSTIN'], ['uniware_customer_code', 'Uniware customer code'], ['final_shipping_address', 'shipping address'],
    ['final_billing_address', 'billing address'], ['city', 'city'], ['buyer_type', 'buyer type'], ['appointment_channel', 'appointment']] as const) {
    const n = missing(col);
    if (n) gaps.push(`locations without ${label}: ${n} of ${locations.length}`);
  }

  // ---- channel SKUs
  const csIds = new Set<string>();
  for (const s of channelSkus) {
    if (csIds.has(s.id)) problems.push(`master_channel_skus: duplicate id ${s.id}`);
    csIds.add(s.id);
    const ch = chById.get(s.channel_id);
    if (!ch) problems.push(`channel SKU ${s.id}: channel id ${s.channel_id} not in the channel file`);
    else if (!blank(s.channel_name) && s.channel_name !== ch.display_name) problems.push(`channel SKU ${s.id}: channel_name "${s.channel_name}" is not "${ch.display_name}"`);
    const code = skuById.get(s.pep_sku_id);
    if (code === undefined) problems.push(`channel SKU ${s.id}: pep_sku_id ${s.pep_sku_id} not in master_skus`);
    else if (lc(code) !== lc(s.pep_code)) problems.push(`channel SKU ${s.id}: pep_sku_id ${s.pep_sku_id} is ${code}, not ${s.pep_code}`);
  }
  const noEan = channelSkus.filter((s) => blank(s.ean_code) || s.ean_code.trim() === '-').length;
  if (noEan) gaps.push(`channel SKUs without EAN: ${noEan} of ${channelSkus.length}`);

  // ---- nothing may still point at the old rows
  const poRows = (await count(TABLES.PO_UPLOADS)) + (await count(TABLES.MASTER_PURCHASE_ORDERS));
  if (poRows) problems.push(`${poRows} PO row(s) (po_uploads / master_purchase_orders) still point at the old channels / locations`);

  const pc = await plan(TABLES.MASTER_CHANNELS, channels, problems);
  const pl = await plan(TABLES.DETAILS_CHANNELS, locations, problems);
  const ps = await plan(TABLES.MASTER_SKUS, skusToAdd, problems);
  const pcs = await plan(TABLES.MASTER_CHANNEL_SKUS, channelSkus, problems);

  const before = {
    master_channels: await count(TABLES.MASTER_CHANNELS), details_channels: await count(TABLES.DETAILS_CHANNELS),
    master_skus: await count(TABLES.MASTER_SKUS), master_channel_skus: await count(TABLES.MASTER_CHANNEL_SKUS),
  };
  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN (nothing written; add --apply)'}  folder: ${dir}`);
  console.log(`  master_channels      ${before.master_channels} -> ${channels.length} (replaced)`);
  console.log(`  details_channels     ${before.details_channels} -> ${locations.length} (replaced)`);
  console.log(`  master_skus          ${before.master_skus} -> ${before.master_skus + skusToAdd.length} (+${skusToAdd.length} added, others untouched)`);
  console.log(`  master_channel_skus  ${before.master_channel_skus} -> ${channelSkus.length} (replaced)`);
  console.log(`\nData gaps (loaded as they are; for the masters team):`);
  for (const g of gaps) console.log(`  - ${g}`);
  if (problems.length) {
    console.log(`\nPROBLEMS (${problems.length}): nothing ${APPLY ? 'was' : 'would be'} written`);
    for (const p of problems.slice(0, 50)) console.log(`  ! ${p}`);
    await AppDataSource.destroy();
    process.exit(2);
  }
  console.log('\nNo problems.');
  if (!APPLY) return void (await AppDataSource.destroy());

  const by = arg('by');
  const user = by ? await AppDataSource.getRepository(User).findOneBy({ email: by }) : null;
  await AppDataSource.transaction(async (m) => {
    await m.query(`DELETE FROM ${TABLES.MASTER_CHANNEL_SKUS}`);
    await m.query(`DELETE FROM ${TABLES.DETAILS_CHANNELS}`);
    await m.query(`DELETE FROM ${TABLES.MASTER_CHANNELS}`);
    await insertMany(m, TABLES.MASTER_CHANNELS, pc.cols, pc.values);
    await insertMany(m, TABLES.MASTER_SKUS, ps.cols, ps.values);
    await insertMany(m, TABLES.DETAILS_CHANNELS, pl.cols, pl.values);
    await insertMany(m, TABLES.MASTER_CHANNEL_SKUS, pcs.cols, pcs.values);
    const n = async (t: string) => Number(((await m.query(`SELECT COUNT(*) n FROM \`${t}\``)) as { n: string }[])[0].n);
    const after = { ch: await n(TABLES.MASTER_CHANNELS), loc: await n(TABLES.DETAILS_CHANNELS), sku: await n(TABLES.MASTER_SKUS), cs: await n(TABLES.MASTER_CHANNEL_SKUS) };
    if (after.ch !== channels.length || after.loc !== locations.length || after.cs !== channelSkus.length || after.sku !== before.master_skus + skusToAdd.length) {
      throw new Error(`counts after the load do not match the files: ${JSON.stringify(after)} (rolled back)`);
    }
    await m.getRepository(ActivityLog).insert({
      userId: user?.id ?? null, method: 'AUDIT', status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS),
      path: `masters:replace ${channels.length} channels, ${locations.length} locations, +${skusToAdd.length} SKUs, ${channelSkus.length} channel SKUs`.slice(0, 255),
    });
    const replaced = (type: MasterLogType, what: string) =>
      ({ type, recordId: null, rowKey: `all (${path.basename(dir)})`, action: MASTER_LOG_ACTION.REPLACED, newValue: what });
    await logMasterChanges(m, [
      replaced(MASTER_LOG_TYPE.CHANNEL, `${before.master_channels} -> ${after.ch} rows (replaced)`),
      replaced(MASTER_LOG_TYPE.LOCATION, `${before.details_channels} -> ${after.loc} rows (replaced)`),
      replaced(MASTER_LOG_TYPE.PEP_SKU, `${skusToAdd.length} added, others untouched`),
      replaced(MASTER_LOG_TYPE.CHANNEL_SKU, `${before.master_channel_skus} -> ${after.cs} rows (replaced)`),
    ], { id: user?.id ?? null }, MASTER_LOG_SOURCE.SCRIPT);
    console.log(`\nAPPLIED: ${JSON.stringify(after)}`);
  });
  await AppDataSource.destroy();
};

main().catch(async (e) => {
  console.error('FAILED (nothing changed):', e instanceof Error ? e.message : e);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
