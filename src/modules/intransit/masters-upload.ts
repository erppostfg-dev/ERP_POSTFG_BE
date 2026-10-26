import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, MASTER_CHANGE_SOURCE, SKU_COMPONENT_STAGE, SkuComponentStage, TABLES } from '../../constants';
import { appError } from '../../utils/AppError';
import { DB_MASTER_FILES } from './masters-export';
import { assertMastersWritable, Change, ensureSkus, logChanges, Who } from './masters-db';
import { decodeText, tokenizeCsv } from './io';
import { fileKind, readXlsxSheet } from './sources/files';
import { getItem, uniwareCatalog, UniwareItem } from './sources/uniware';
import { env } from '../../config/env';

/*
 * A master file uploaded on the Masters tab, once the masters live in the database (user, 2026-10-25):
 *   - ADD AND UPDATE ONLY: rows in the file are added or changed; nothing in the database is removed;
 *   - a blank cell leaves the value as it is;
 *   - a SKU the product master lacks is added from Uniware; the upload is refused when Uniware does not know it;
 *   - a row that cannot be stored refuses the whole upload (422 with every problem), never skipped silently;
 *   - one transaction with a change-log row per value; dryRun = the same answer, nothing written;
 *   - Channel SKU Mapping is uploaded in the review workbook's layout (sheets "Mapping" and "No channel found").
 * The uploaded file itself is kept by the caller (Drive masters/_imports/).
 */

export type DbMasterFile = (typeof DB_MASTER_FILES)[number];
export const isDbMaster = (name: string): name is DbMasterFile => (DB_MASTER_FILES as readonly string[]).includes(name);

export interface UploadResult {
  master: string;
  dryRun: boolean;
  added: number;
  updated: number;
  unchanged: number;
  /** SKUs added to the product master from Uniware. */
  newSkus: string[];
  /** Locations added (inactive) to details_channels. */
  newLocations: string[];
  warnings: string[];
}

type Rec = Record<string, string>;
const lc = (s: unknown): string => String(s ?? '').trim().toLowerCase();
const key = (s: unknown): string => lc(s).replace(/[^a-z0-9]/g, '');
const blank = (s: unknown): boolean => String(s ?? '').trim() === '';

const csvRecords = (raw: Uint8Array): Rec[] => {
  const [h = [], ...rows] = tokenizeCsv(decodeText(raw));
  const head = h.map((x) => x.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
};
const sheetRecords = (raw: Uint8Array, sheet: string): Rec[] | null => {
  const rows = readXlsxSheet(raw, sheet);
  if (!rows) return null;
  const [h = [], ...body] = rows;
  return body.filter((r) => r.some((c) => (c ?? '').trim())).map((r) => Object.fromEntries(h.map((k, i) => [k.trim(), (r[i] ?? '').trim()])));
};

/** Refuse the upload with every problem found (the page lists them). */
const refuse = (master: string, problems: string[]): never => {
  throw appError(ERROR_CODES.INTRANSIT_INPUT_INVALID, master, `${problems.length} problem(s): ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ' ...' : ''}`)
    .withDetails({ name: master, problems });
};

const need = (rows: Rec[], cols: string[], master: string): void => {
  const have = new Set(Object.keys(rows[0] ?? {}));
  const missing = cols.filter((c) => !have.has(c));
  if (!rows.length) refuse(master, ['the file has no rows']);
  if (missing.length) refuse(master, [`missing column(s): ${missing.join(', ')}`]);
};

interface Ctx {
  m: EntityManager;
  who: Who;
  dryRun: boolean;
  res: UploadResult;
  changes: Change[];
}

const q = <T>(m: EntityManager, sql: string, p: unknown[] = []) => m.query(sql, p) as Promise<T[]>;

const skusOf = async (c: Ctx, skus: string[]): Promise<Map<string, string>> => {
  const { map, added } = await ensureSkus(c.m, skus, c.who, c.res.master, MASTER_CHANGE_SOURCE.UPLOAD, c.dryRun);
  c.res.newSkus.push(...added);
  return map;
};

/** Set columns of master_skus where the file differs (blank = leave); counts and logs per SKU. */
const setSkuColumns = async (c: Ctx, values: Map<string, Record<string, string | number | null>>): Promise<void> => {
  const skus = await skusOf(c, [...values.keys()]);
  const pep = [...values.keys()].map((k) => skus.get(lc(k)) as string);
  const cols = [...new Set([...values.values()].flatMap((v) => Object.keys(v)))];
  const current = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < pep.length; i += 500) {
    const chunk = pep.slice(i, i + 500);
    for (const r of await q<Record<string, unknown>>(c.m, `SELECT pep_code, ${cols.map((x) => `\`${x}\``).join(', ')} FROM ${TABLES.MASTER_SKUS} WHERE pep_code IN (${chunk.map(() => '?').join(', ')})`, chunk)) {
      current.set(lc(r.pep_code), r);
    }
  }
  for (const [sku, v] of values) {
    const code = skus.get(lc(sku)) as string;
    const now = current.get(lc(code)) ?? {};
    const diff = Object.entries(v).filter(([col, val]) => String(now[col] ?? '') !== String(val ?? '') && !(typeof val === 'number' && Number(now[col]) === val));
    if (!diff.length) {
      c.res.unchanged++;
      continue;
    }
    if (diff.every(([col]) => now[col] === null || now[col] === undefined)) c.res.added++;
    else c.res.updated++;
    diff.forEach(([col, val]) => c.changes.push({ master: c.res.master, table: TABLES.MASTER_SKUS, rowKey: code, field: col, oldValue: now[col] ?? null, newValue: val }));
    if (!c.dryRun) await c.m.query(`UPDATE ${TABLES.MASTER_SKUS} SET ${diff.map(([col]) => `\`${col}\` = ?`).join(', ')} WHERE pep_code = ?`, [...diff.map(([, val]) => val), code]);
  }
};

// ---- the 8 masters -----------------------------------------------------------------------------------------------

/** Split1 / Split2: each combo in the file gets the file's parts (a part n times = qty n); other combos untouched. */
const splits = async (c: Ctx, rows: Rec[], stage: SkuComponentStage): Promise<void> => {
  need(rows, ['SKU Code', 'Split SKU'], c.res.master);
  const combos = new Map<string, { combo: string; parts: { sku: string; qty: number }[] }>();
  const problems: string[] = [];
  rows.forEach((r, i) => {
    if (blank(r['SKU Code']) || blank(r['Split SKU'])) return void problems.push(`row ${i + 2}: SKU Code and Split SKU are both needed`);
    const e = combos.get(lc(r['SKU Code'])) ?? { combo: r['SKU Code'], parts: [] };
    const p = e.parts.find((x) => lc(x.sku) === lc(r['Split SKU']));
    if (p) p.qty++;
    else e.parts.push({ sku: r['Split SKU'], qty: 1 });
    combos.set(lc(r['SKU Code']), e);
  });
  if (problems.length) refuse(c.res.master, problems);

  // the loader's rules (user, 2026-10-23): a SKU split into itself n times is qty 1; Split1 combos follow Uniware's
  // bundle when Uniware can be asked (otherwise the file is used, with a warning)
  let uniware: ((sku: string) => Promise<UniwareItem | null>) | null = null;
  const u = env.intransit.uniware;
  if (stage === SKU_COMPONENT_STAGE.SPLIT1 && u.tenant && u.username && u.password) {
    const api = uniwareCatalog(u);
    uniware = (sku) => getItem(api, sku);
  } else if (stage === SKU_COMPONENT_STAGE.SPLIT1) c.res.warnings.push('no Uniware login: combos not checked against Uniware');
  for (const e of combos.values()) {
    if (e.parts.length === 1 && lc(e.parts[0].sku) === lc(e.combo) && e.parts[0].qty > 1) e.parts = [{ sku: e.parts[0].sku, qty: 1 }];
    if (!uniware) continue;
    try {
      const it = await uniware(e.combo);
      if (it && it.type.toUpperCase() === 'BUNDLE' && it.components.length) {
        const same = it.components.length === e.parts.length && it.components.every((x) => e.parts.some((y) => lc(y.sku) === lc(x.sku) && y.qty === x.qty));
        if (!same) {
          c.res.warnings.push(`${e.combo}: Uniware's bundle used (${it.components.map((x) => `${x.sku} x${x.qty}`).join(', ')})`);
          e.parts = it.components;
        }
      }
    } catch (err) {
      c.res.warnings.push(`Uniware could not be asked (${err instanceof Error ? err.message.slice(0, 80) : err}): combos not checked`);
      uniware = null;
    }
  }

  const skus = await skusOf(c, [...combos.values()].flatMap((e) => [e.combo, ...e.parts.map((p) => p.sku)]));
  const existing = new Map<string, { part: string; qty: number }[]>();
  for (const r of await q<{ combo_pep_code: string; component_pep_code: string; qty: number }>(c.m,
    `SELECT combo_pep_code, component_pep_code, qty FROM ${TABLES.MASTER_SKU_COMPONENTS} WHERE stage = ? ORDER BY position, id`, [stage])) {
    existing.set(lc(r.combo_pep_code), [...(existing.get(lc(r.combo_pep_code)) ?? []), { part: r.component_pep_code, qty: Number(r.qty) }]);
  }
  for (const e of combos.values()) {
    const combo = skus.get(lc(e.combo)) as string;
    const parts = e.parts.map((p) => ({ part: skus.get(lc(p.sku)) as string, qty: p.qty }));
    const now = existing.get(lc(combo));
    const same = now && now.length === parts.length && now.every((x, i) => lc(x.part) === lc(parts[i].part) && x.qty === parts[i].qty);
    if (same) {
      c.res.unchanged++;
      continue;
    }
    if (now) c.res.updated++;
    else c.res.added++;
    const text = (ps: { part: string; qty: number }[]) => ps.map((p) => `${p.part} x${p.qty}`).join(', ');
    c.changes.push({ master: c.res.master, table: TABLES.MASTER_SKU_COMPONENTS, rowKey: combo, field: 'parts', oldValue: now ? text(now) : null, newValue: text(parts) });
    if (c.dryRun) continue;
    // the combo's parts are the file's now (this combo only: other combos stay as they are)
    await c.m.query(`DELETE FROM ${TABLES.MASTER_SKU_COMPONENTS} WHERE stage = ? AND combo_pep_code = ?`, [stage, combo]);
    await c.m.query(`INSERT INTO ${TABLES.MASTER_SKU_COMPONENTS} (stage, combo_pep_code, component_pep_code, qty, position) VALUES ${parts.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      parts.flatMap((p, i) => [stage, combo, p.part, p.qty, i + 1]));
  }
};

const finalSkuMapping = async (c: Ctx, rows: Rec[]): Promise<void> => {
  need(rows, ['Listing_SKU', 'Final SKU'], c.res.master);
  const values = new Map<string, Record<string, string>>();
  const problems: string[] = [];
  rows.forEach((r, i) => {
    if (blank(r.Listing_SKU) || blank(r['Final SKU'])) return;
    // one entry per SKU whatever its letter case (the first spelling kept)
    const same = [...values.keys()].find((k) => lc(k) === lc(r.Listing_SKU)) ?? r.Listing_SKU;
    const had = values.get(same);
    if (had && lc(had.final_pep_code) !== lc(r['Final SKU'])) problems.push(`row ${i + 2}: ${r.Listing_SKU} has two Final SKUs (${had.final_pep_code}, ${r['Final SKU']})`);
    values.set(same, { final_pep_code: r['Final SKU'] });
  });
  if (problems.length) refuse(c.res.master, problems);
  const skus = await skusOf(c, [...values.values()].map((v) => v.final_pep_code));
  for (const v of values.values()) v.final_pep_code = skus.get(lc(v.final_pep_code)) as string;
  await setSkuColumns(c, values);
};

const sheet35 = async (c: Ctx, rows: Rec[]): Promise<void> => {
  need(rows, ['SKU Code'], c.res.master);
  const values = new Map<string, Record<string, string | number | null>>();
  const problems: string[] = [];
  const cols: [string, string, boolean][] = [['SKU Name', 'intransit_name', false], ['Type', 'intransit_type', false], ['Count', 'intransit_category', false], ['MRP', 'intransit_mrp', true], ['COGS (With TAX)', 'intransit_cogs', true]];
  rows.forEach((r, i) => {
    if (blank(r['SKU Code'])) return;
    const v: Record<string, string | number | null> = {};
    for (const [col, field, numeric] of cols) {
      if (blank(r[col])) continue; // blank = leave as it is
      if (!numeric) v[field] = r[col].trim();
      else {
        const n = Number(r[col].replace(/,/g, ''));
        if (!Number.isFinite(n)) problems.push(`row ${i + 2}: ${col} "${r[col]}" is not a number`);
        else v[field] = n;
      }
    }
    if (Object.keys(v).length) values.set(r['SKU Code'], { ...(values.get(r['SKU Code']) ?? {}), ...v });
  });
  if (problems.length) refuse(c.res.master, problems);
  await setSkuColumns(c, values);
};

const notToConsider = async (c: Ctx, rows: Rec[]): Promise<void> => {
  if (!rows.length) refuse(c.res.master, ['the file has no rows']);
  const first = Object.keys(rows[0])[0];
  const values = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const sku = r['Item SkuCode'] ?? r[first];
    if (!blank(sku)) values.set(sku, { intransit_consider: 0 });
  }
  await setSkuColumns(c, values);
};

type Channel = { id: number; name: string };
const channelIndex = async (m: EntityManager): Promise<Map<string, Channel>> => {
  const idx = new Map<string, Channel>();
  for (const ch of await q<{ id: number; display_name: string; slug: string; db_aliases: string[] | string | null }>(m, `SELECT id, display_name, slug, db_aliases FROM ${TABLES.MASTER_CHANNELS}`)) {
    const aliases = Array.isArray(ch.db_aliases) ? ch.db_aliases : ch.db_aliases ? (JSON.parse(ch.db_aliases) as string[]) : [];
    for (const a of [ch.display_name, ch.slug, ...aliases]) if (!idx.has(key(a))) idx.set(key(a), { id: ch.id, name: ch.display_name });
  }
  return idx;
};

/**
 * Location Master and MyntraWHIDs: details_channels.intransit_location per channel + location code. A code listed with
 * two locations: refused (Location Master), or the last row wins with a warning (MyntraWHIDs: as the report reads it,
 * user 2026-10-25).
 */
const locations = async (c: Ctx, entries: { row: number; channel: string; code: string; loc: string }[], lastWins = false): Promise<void> => {
  const channels = await channelIndex(c.m);
  const problems: string[] = [];
  const byCode = new Map<string, { ch: Channel; code: string; loc: string; others: Set<string> }>();
  for (const e of entries) {
    const ch = channels.get(key(e.channel));
    if (!ch) { problems.push(`row ${e.row}: channel "${e.channel}" is not in the channel master`); continue; }
    const k = `${ch.id}|${lc(e.code)}`;
    const had = byCode.get(k);
    if (!had) { byCode.set(k, { ch, code: e.code, loc: e.loc, others: new Set() }); continue; }
    if (lc(had.loc) === lc(e.loc)) continue; // the same place in other letter case
    if (!lastWins) { problems.push(`row ${e.row}: ${ch.name} ${e.code} has two locations (${had.loc}, ${e.loc})`); continue; }
    had.others.add(had.loc);
    had.loc = e.loc;
  }
  if (problems.length) refuse(c.res.master, problems);
  for (const p of byCode.values()) {
    if (p.others.size) c.res.warnings.push(`${p.ch.name} ${p.code}: listed with ${p.others.size + 1} locations, the last row's "${p.loc}" kept (also ${[...p.others].join(' / ')})`);
  }
  const placed = [...byCode.values()];
  for (const p of placed) {
    const now = await q<{ id: string; intransit_location: string | null }>(c.m,
      `SELECT id, intransit_location FROM ${TABLES.DETAILS_CHANNELS} WHERE channel_id = ? AND LOWER(TRIM(channel_location_code)) = ?`, [p.ch.id, lc(p.code)]);
    const rowKey = `${p.ch.name} | ${p.code}`;
    if (!now.length) {
      c.res.added++;
      c.res.newLocations.push(rowKey);
      c.changes.push({ master: c.res.master, table: TABLES.DETAILS_CHANNELS, rowKey, field: 'intransit_location', oldValue: null, newValue: `${p.loc} (new inactive location)` });
      if (!c.dryRun) {
        await c.m.query(`INSERT INTO ${TABLES.DETAILS_CHANNELS} (channel_id, channel_name, channel_location_code, intransit_location, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          [p.ch.id, p.ch.name, p.code, p.loc, new Date(), new Date()]);
      }
      continue;
    }
    const differ = now.filter((r) => r.intransit_location !== p.loc);
    if (!differ.length) { c.res.unchanged++; continue; }
    if (differ.every((r) => r.intransit_location === null)) c.res.added++;
    else c.res.updated++;
    for (const r of differ) {
      c.changes.push({ master: c.res.master, table: TABLES.DETAILS_CHANNELS, rowKey, field: 'intransit_location', oldValue: r.intransit_location, newValue: p.loc });
      if (!c.dryRun) await c.m.query(`UPDATE ${TABLES.DETAILS_CHANNELS} SET intransit_location = ? WHERE id = ?`, [p.loc, r.id]);
    }
  }
};

const locationMaster = (c: Ctx, rows: Rec[]): Promise<void> => {
  need(rows, ['Channel', 'Fulfillment Centre-ID', 'Final Location'], c.res.master);
  const problems: string[] = [];
  const entries = rows.flatMap((r, i) => {
    if (blank(r['Fulfillment Centre-ID']) || blank(r['Final Location'])) return [];
    if (key(r.Channel) === 'myntra' && /^\d+$/.test(r['Fulfillment Centre-ID'])) {
      problems.push(`row ${i + 2}: Myntra warehouse id ${r['Fulfillment Centre-ID']} belongs in MyntraWHIDs`);
      return [];
    }
    return [{ row: i + 2, channel: r.Channel, code: r['Fulfillment Centre-ID'], loc: r['Final Location'] }];
  });
  if (problems.length) refuse(c.res.master, problems);
  return locations(c, entries);
};

const myntraWhIds = (c: Ctx, rows: Rec[]): Promise<void> => {
  need(rows, ['WH Id', 'WH location'], c.res.master);
  const problems: string[] = [];
  const entries = rows.flatMap((r, i) => {
    if (blank(r['WH Id']) || blank(r['WH location'])) return [];
    if (!/^\d+$/.test(r['WH Id'])) { problems.push(`row ${i + 2}: WH Id "${r['WH Id']}" is not a number`); return []; }
    return [{ row: i + 2, channel: 'Myntra', code: r['WH Id'], loc: r['WH location'] }];
  });
  if (problems.length) refuse(c.res.master, problems);
  return locations(c, entries, true);
};

/** Channel SKU Mapping, from the review workbook: upsert by (channel, code); rows without a channel by code. */
const channelSkuMapping = async (c: Ctx, raw: Uint8Array): Promise<void> => {
  if (fileKind(raw) !== 'xlsx') refuse(c.res.master, ['upload the Channel SKU Mapping workbook (sheets "Mapping" and "No channel found"), not the CSV']);
  const mapping = sheetRecords(raw, 'Mapping');
  const noChannel = sheetRecords(raw, 'No channel found') ?? [];
  if (!mapping) refuse(c.res.master, ['the workbook has no "Mapping" sheet']);
  const channels = await channelIndex(c.m);
  const problems: string[] = [];
  const rows: { row: string; sku: string; channel: string | null; code: string; final: string | null; filled?: boolean }[] = [];
  (mapping as Rec[]).forEach((r, i) => {
    if (blank(r['Channel SKU Code']) || blank(r.SKU)) return;
    const ch = blank(r.Channel) ? null : channels.get(key(r.Channel));
    if (!blank(r.Channel) && !ch) return void problems.push(`Mapping row ${i + 2}: channel "${r.Channel}" is not in the channel master`);
    rows.push({ row: `Mapping row ${i + 2}`, sku: r.SKU, channel: ch?.name ?? null, code: r['Channel SKU Code'], final: blank(r['Final SKU']) ? null : r['Final SKU'] });
  });
  noChannel.forEach((r, i) => {
    if (blank(r['Channel SKU Code']) || blank(r.SKU)) return;
    const fill = r['Channel (fill in)'];
    const ch = blank(fill) ? null : channels.get(key(fill));
    if (!blank(fill) && !ch) return void problems.push(`No channel found row ${i + 2}: channel "${fill}" is not in the channel master`);
    rows.push({ row: `No channel found row ${i + 2}`, sku: r.SKU, channel: ch?.name ?? null, code: r['Channel SKU Code'], final: blank(r['Final SKU']) ? null : r['Final SKU'], filled: !!ch });
  });
  const bySku = new Map<string, string>();
  for (const r of rows) {
    const k = `${lc(r.channel)}|${lc(r.code)}`;
    if (bySku.has(k) && lc(bySku.get(k)) !== lc(r.sku)) problems.push(`${r.row}: ${r.channel ?? '(no channel)'} code ${r.code} has two SKUs (${bySku.get(k)}, ${r.sku})`);
    bySku.set(k, r.sku);
  }
  if (problems.length) refuse(c.res.master, problems);

  const current = await q<{ id: number; sku_code: string; channel: string | null; channel_sku_code: string; final_sku: string | null }>(c.m,
    `SELECT id, sku_code, channel, channel_sku_code, final_sku FROM ${TABLES.INTRANSIT_CHANNEL_SKU_MAP}`);
  const byKey = new Map(current.map((r) => [`${lc(r.channel)}|${lc(r.channel_sku_code)}`, r]));
  // a code kept without a channel, by code: a channel filled in on "No channel found" completes that row
  const withoutChannel = new Map(current.filter((r) => !r.channel).map((r) => [lc(r.channel_sku_code), r]));
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${lc(r.channel)}|${lc(r.code)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const now = byKey.get(k);
    const rowKey = `${r.channel ?? '(no channel)'} | ${r.code}`;
    const unfilled = !now && r.filled ? withoutChannel.get(lc(r.code)) : undefined;
    if (unfilled) {
      c.res.updated++;
      c.changes.push({ master: c.res.master, table: TABLES.INTRANSIT_CHANNEL_SKU_MAP, rowKey, field: 'channel', oldValue: null, newValue: r.channel });
      if (lc(unfilled.sku_code) !== lc(r.sku)) c.changes.push({ master: c.res.master, table: TABLES.INTRANSIT_CHANNEL_SKU_MAP, rowKey, field: 'sku_code', oldValue: unfilled.sku_code, newValue: r.sku });
      if (!c.dryRun) {
        await c.m.query(`UPDATE ${TABLES.INTRANSIT_CHANNEL_SKU_MAP} SET channel = ?, sku_code = ?, final_sku = COALESCE(?, final_sku) WHERE id = ?`, [r.channel, r.sku, r.final, unfilled.id]);
      }
      withoutChannel.delete(lc(r.code));
      continue;
    }
    if (!now) {
      c.res.added++;
      c.changes.push({ master: c.res.master, table: TABLES.INTRANSIT_CHANNEL_SKU_MAP, rowKey, field: 'sku_code', oldValue: null, newValue: r.sku });
      if (!c.dryRun) {
        await c.m.query(`INSERT INTO ${TABLES.INTRANSIT_CHANNEL_SKU_MAP} (sku_code, channel, channel_sku_code, final_sku, source, is_active) VALUES (?, ?, ?, ?, 'upload', 1)`, [r.sku, r.channel, r.code, r.final]);
      }
      continue;
    }
    const diff: [string, string | null, string | null][] = [];
    if (lc(now.sku_code) !== lc(r.sku)) diff.push(['sku_code', now.sku_code, r.sku]);
    if (r.final !== null && lc(now.final_sku) !== lc(r.final)) diff.push(['final_sku', now.final_sku, r.final]); // blank = leave
    if (!diff.length) { c.res.unchanged++; continue; }
    c.res.updated++;
    diff.forEach(([field, o, n]) => c.changes.push({ master: c.res.master, table: TABLES.INTRANSIT_CHANNEL_SKU_MAP, rowKey, field, oldValue: o, newValue: n }));
    if (!c.dryRun) await c.m.query(`UPDATE ${TABLES.INTRANSIT_CHANNEL_SKU_MAP} SET ${diff.map(([f]) => `${f} = ?`).join(', ')} WHERE id = ?`, [...diff.map(([, , n]) => n), now.id]);
  }
};

/**
 * Import an uploaded master file into the database (production server only; 403 elsewhere). `importKey` = the
 * upload kept in S3 (logged with each change). dryRun: the same answer, nothing written.
 */
export const importMasterUpload = async (
  name: DbMasterFile, raw: Uint8Array, who: Who, opts: { dryRun?: boolean; importKey?: string | null } = {},
): Promise<UploadResult> => {
  assertMastersWritable();
  const master = name.replace(/\.csv$/i, '');
  const res: UploadResult = { master, dryRun: !!opts.dryRun, added: 0, updated: 0, unchanged: 0, newSkus: [], newLocations: [], warnings: [] };
  const run = async (m: EntityManager): Promise<void> => {
    const c: Ctx = { m, who, dryRun: !!opts.dryRun, res, changes: [] };
    switch (name) {
      case 'Split1.csv': await splits(c, csvRecords(raw), SKU_COMPONENT_STAGE.SPLIT1); break;
      case 'Split2.csv': await splits(c, csvRecords(raw), SKU_COMPONENT_STAGE.SPLIT2); break;
      case 'Final SKU Mapping.csv': await finalSkuMapping(c, csvRecords(raw)); break;
      case 'Sheet35(2).csv': await sheet35(c, csvRecords(raw)); break;
      case 'SKU-Not To Consider.csv': await notToConsider(c, csvRecords(raw)); break;
      case 'Location Master.csv': await locationMaster(c, csvRecords(raw)); break;
      case 'MyntraWHIDs.csv': await myntraWhIds(c, csvRecords(raw)); break;
      case 'Channel SKU Mapping.csv': await channelSkuMapping(c, raw); break;
    }
    if (!c.dryRun) await logChanges(m, c.changes, who, MASTER_CHANGE_SOURCE.UPLOAD, opts.importKey ?? null);
  };
  // one import at a time, the lock held over the whole transaction on ONE connection (released after the commit);
  // a dry run's transaction is always rolled back, so nothing it touches can stick
  const qr = AppDataSource.createQueryRunner();
  await qr.connect();
  try {
    const [lock] = (await qr.query(`SELECT GET_LOCK('it:master_import', 30) AS got`)) as { got: number | string | null }[];
    if (Number(lock?.got) !== 1) throw appError(ERROR_CODES.INTRANSIT_RUN_BUSY, 'master import', 'running');
    try {
      await qr.startTransaction();
      try {
        await run(qr.manager);
        if (opts.dryRun) await qr.rollbackTransaction();
        else await qr.commitTransaction();
      } catch (err) {
        await qr.rollbackTransaction();
        throw err;
      }
    } finally {
      await qr.query(`SELECT RELEASE_LOCK('it:master_import')`).catch(() => undefined);
    }
  } finally {
    await qr.release();
  }
  return res;
};
