import fs from 'fs/promises';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ERROR_CODES, FINAL_SKU_MAP, MASTER_CHANGE_SOURCE, SKU_COMPONENT_STAGE, SPLIT1 } from '../../constants';
import { appError } from '../../utils/AppError';
import { archiveMaster, masterPath, withMasterLock, writeWithMeta } from './input-store';
import { addCombos, assertMastersWritable, comboParents, finalListings, mapToBases, mastersInDb, Who } from './masters-db';
import { decodeText, tokenizeCsv } from './io';
import { getItemType, uniwareCatalog } from './sources/uniware';

/*
 * Editing two masters from the In-transit Stock page (user, 2026-10-19), for the combos the report flags
 * (combo-check.ts):
 *   - Split1.csv: add a combo with its components (a component once per unit: 2 of a product = 2 rows);
 *   - Final SKU Mapping.csv: map a combo variant (CMB47B2b, SCMB112_S ...) to its base combo (CMB47, SCMB112), so it
 *     follows the base's split.
 * Both: rows appended in the file's own layout and line ending, a key already there (any casing) is never added again,
 * SKUs are checked against Uniware when a login is set, and the current file is kept as a version
 * (inputs/masters/_history/<file>/, restorable from the Masters tab) before it changes.
 */

export interface ComboRows {
  combo: string;
  components: { sku: string; qty: number }[];
}

export interface VariantMap {
  /** The variant SKU (Listing_SKU). */
  variant: string;
  /** Its base combo (Final SKU). */
  base: string;
  /** The base's components, to add the base to Split1 too when it is not there yet. */
  components?: { sku: string; qty: number }[];
}

export interface Split1AddResult {
  added: { combo: string; rows: number }[];
  skipped: { combo: string; reason: string }[];
}

export interface VariantMapResult {
  mapped: { variant: string; base: string }[];
  skipped: { variant: string; reason: string }[];
  /** Bases added to Split1 with their components. */
  split1: Split1AddResult;
}

// ---- appending to a master CSV ---------------------------------------------------------------------------------

const keysCache = new Map<string, { mtimeMs: number; keys: Set<string> }>();

/** The values of `column` (first column if absent) of a master CSV, lower-cased; cached until the file changes. */
const keysOf = async (file: string, column: string): Promise<Set<string>> => {
  const p = masterPath(file);
  const st = await fs.stat(p).catch(() => null);
  if (!st) return new Set();
  const hit = keysCache.get(file);
  if (hit?.mtimeMs === st.mtimeMs) return hit.keys;
  const [header = [], ...rows] = tokenizeCsv(decodeText(new Uint8Array(await fs.readFile(p))));
  const col = header.findIndex((h) => h.trim() === column);
  const keys = new Set(rows.map((r) => (r[col < 0 ? 0 : col] ?? '').trim().toLowerCase()).filter(Boolean));
  keysCache.set(file, { mtimeMs: st.mtimeMs, keys });
  return keys;
};

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Append rows (cells in the file's column order) to a master, after copying it to its history folder. */
const appendRows = (file: string, rows: string[][]): Promise<void> =>
  withMasterLock(file, async () => {
    const p = masterPath(file);
    const raw = await fs.readFile(p).catch(() => null);
    if (!raw) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, file);
    const text = decodeText(new Uint8Array(raw));
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    await archiveMaster(file);
    const lines = rows.map((r) => r.map((c) => csvCell(c)).join(','));
    await writeWithMeta(p, new Uint8Array(Buffer.from(`${text}${/\r?\n$/.test(text) || !text ? '' : eol}${lines.join(eol)}${eol}`, 'utf8')), { source: 'edit' });
    keysCache.delete(file);
  });

/** With a Uniware login: the SKUs Uniware does not know. */
const unknownInUniware = async (skus: string[]): Promise<string[]> => {
  const u = env.intransit.uniware;
  if (!u.tenant || !u.username || !u.password) return [];
  const api = uniwareCatalog(u);
  const unknown: string[] = [];
  for (const sku of [...new Set(skus)]) if (!(await getItemType(api, sku))) unknown.push(sku);
  return unknown;
};

// ---- Split1 ----------------------------------------------------------------------------------------------------

/** The parent SKUs of Split1 (the database once the masters are there, else Split1.csv), lower-cased. */
export const split1Parents = (): Promise<Set<string>> => (mastersInDb() ? comboParents(SKU_COMPONENT_STAGE.SPLIT1) : keysOf(SPLIT1.FILE, SPLIT1.PARENT_COLUMN));

/** The listing SKUs of Final SKU Mapping (database or file), lower-cased. */
export const finalSkuListings = (): Promise<Set<string>> => (mastersInDb() ? finalListings() : keysOf(FINAL_SKU_MAP.FILE, FINAL_SKU_MAP.LISTING_COLUMN));

const checkCombos = (items: ComboRows[]): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const combo = String(it?.combo ?? '').trim();
    if (!combo) { problems.push('a combo without its SKU'); continue; }
    if (seen.has(combo.toLowerCase())) problems.push(`${combo} is given twice`);
    seen.add(combo.toLowerCase());
    if (!Array.isArray(it.components) || !it.components.length) problems.push(`${combo}: no components`);
    for (const c of it.components ?? []) {
      const sku = String(c?.sku ?? '').trim();
      if (!sku) problems.push(`${combo}: a component without its SKU`);
      else if (sku.toLowerCase() === combo.toLowerCase()) problems.push(`${combo}: cannot be its own component`);
      if (!Number.isInteger(c?.qty) || c.qty < 1 || c.qty > SPLIT1.MAX_QTY) problems.push(`${combo}: quantity of ${sku || '?'} must be a whole number from 1 to ${SPLIT1.MAX_QTY}`);
    }
  }
  return problems;
};

/** Append the combos' rows to Split1.csv (skipping combos already there); `checked` = components already verified. */
const appendCombos = async (items: ComboRows[], checked = false): Promise<Split1AddResult> => {
  const parents = await split1Parents();
  const result: Split1AddResult = { added: [], skipped: [] };
  const todo = items.filter((it) => {
    if (!parents.has(it.combo.trim().toLowerCase())) return true;
    result.skipped.push({ combo: it.combo.trim(), reason: 'already in Split1' });
    return false;
  });
  if (!todo.length) return result;
  if (!checked) {
    const unknown = await unknownInUniware(todo.flatMap((it) => it.components.map((c) => c.sku.trim())));
    if (unknown.length) throw appError(ERROR_CODES.SPLIT1_COMPONENT_UNKNOWN, unknown.join(', ')).withDetails({ unknown });
  }
  const rows: string[][] = [];
  for (const it of todo) {
    const combo = it.combo.trim();
    let n = 0;
    for (const c of it.components) for (let i = 0; i < c.qty; i++, n++) rows.push([combo, c.sku.trim()]);
    result.added.push({ combo, rows: n });
  }
  await appendRows(SPLIT1.FILE, rows);
  return result;
};

/**
 * Add the combos to Split1 (combos already there skipped): in the database (production server only, with the change
 * log; SKUs the product master lacks added from Uniware) once the masters are there, else appended to Split1.csv.
 */
export const addToSplit1 = async (items: ComboRows[], who: Who = { id: null, name: null }): Promise<Split1AddResult> => {
  if (!Array.isArray(items) || !items.length) throw appError(ERROR_CODES.SPLIT1_ROWS_INVALID, 'no combos given');
  const problems = checkCombos(items);
  if (problems.length) throw appError(ERROR_CODES.SPLIT1_ROWS_INVALID, problems.join('; ')).withDetails({ problems });
  if (!mastersInDb()) return appendCombos(items);
  assertMastersWritable();
  const parents = await split1Parents();
  const result: Split1AddResult = { added: [], skipped: [] };
  const todo: ComboRows[] = [];
  for (const it of items) {
    if (parents.has(it.combo.trim().toLowerCase())) result.skipped.push({ combo: it.combo.trim(), reason: 'already in Split1' });
    else todo.push(it);
  }
  if (todo.length) result.added = await AppDataSource.transaction((m) => addCombos(m, todo, who, MASTER_CHANGE_SOURCE.SPLIT1_ADD));
  return result;
};

// ---- Final SKU Mapping: combo variants -> their base ------------------------------------------------------------

/**
 * Map each variant to its base combo in Final SKU Mapping.csv (variants already mapped skipped), and add a base that
 * is not in Split1 yet with the components given.
 */
export const mapVariants = async (items: VariantMap[], who: Who = { id: null, name: null }): Promise<VariantMapResult> => {
  const problems: string[] = [];
  if (!Array.isArray(items) || !items.length) problems.push('no variants given');
  for (const it of items ?? []) {
    const v = String(it?.variant ?? '').trim();
    const b = String(it?.base ?? '').trim();
    if (!v || !b) problems.push('a variant and its base are both needed');
    else if (v.toLowerCase() === b.toLowerCase()) problems.push(`${v}: the base must be another SKU`);
  }
  const withBases = (items ?? []).filter((it) => it.components?.length).map((it) => ({ combo: String(it.base).trim(), components: it.components as ComboRows['components'] }));
  problems.push(...checkCombos(withBases));
  if (problems.length) throw appError(ERROR_CODES.SPLIT1_ROWS_INVALID, problems.join('; ')).withDetails({ problems });

  if (mastersInDb()) assertMastersWritable();
  const listings = await finalSkuListings();
  const result: VariantMapResult = { mapped: [], skipped: [], split1: { added: [], skipped: [] } };
  const todo = items.filter((it) => {
    if (!listings.has(it.variant.trim().toLowerCase())) return true;
    result.skipped.push({ variant: it.variant.trim(), reason: 'already in Final SKU Mapping' });
    return false;
  });
  // one Split1 entry per base, even when several variants share it
  const uniqueBases = [...new Map(withBases.map((b) => [b.combo.toLowerCase(), b])).values()];
  if (mastersInDb()) {
    // database: the maps and the new bases in one transaction, with the change log (SKUs added from Uniware there)
    const parents = await split1Parents();
    const newBases: ComboRows[] = [];
    for (const b of uniqueBases) {
      if (parents.has(b.combo.toLowerCase())) result.split1.skipped.push({ combo: b.combo, reason: 'already in Split1' });
      else newBases.push(b);
    }
    await AppDataSource.transaction(async (m) => {
      result.mapped = await mapToBases(m, todo.map((it) => ({ variant: it.variant.trim(), base: it.base.trim() })), who);
      if (newBases.length) result.split1.added = await addCombos(m, newBases, who, MASTER_CHANGE_SOURCE.VARIANT_MAP);
    });
    return result;
  }
  const unknown = await unknownInUniware([...todo.map((it) => it.base.trim()), ...withBases.flatMap((b) => b.components.map((c) => c.sku.trim()))]);
  if (unknown.length) throw appError(ERROR_CODES.SPLIT1_COMPONENT_UNKNOWN, unknown.join(', ')).withDetails({ unknown });

  if (todo.length) {
    await appendRows(FINAL_SKU_MAP.FILE, todo.map((it) => [it.variant.trim(), it.base.trim()]));
    result.mapped = todo.map((it) => ({ variant: it.variant.trim(), base: it.base.trim() }));
  }
  if (uniqueBases.length) result.split1 = await appendCombos(uniqueBases, true);
  return result;
};
