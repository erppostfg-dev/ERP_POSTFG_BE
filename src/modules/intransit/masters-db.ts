import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ERROR_CODES, MASTER_CHANGE_ACTION, MASTER_CHANGE_SOURCE, MasterChangeSource, SKU_COMPONENT_STAGE, SkuComponentStage, TABLES } from '../../constants';
import { IntransitMasterChange } from '../../entities';
import { appError } from '../../utils/AppError';
import { storageOn } from './s3/scope';
import { skuRowFrom } from './masters-import';
import { getItem, uniwareCatalog, UniwareItem } from './sources/uniware';

/*
 * Changing the in-transit masters in the database (user, 2026-10-25; they live there once INTRANSIT_MASTERS_SOURCE=db):
 *   - only the production server may change them (laptops share the database: a change there would change production);
 *   - only add and update, never remove;
 *   - a SKU the product master lacks is added from Uniware; refused when Uniware does not know it or cannot be asked;
 *   - every value gained or changed is a row of intransit_master_changes, written in the same transaction.
 */

export interface Who {
  id: number | null;
  name: string | null;
}

/** Master changes are allowed only on the production server (403 elsewhere). */
export const assertMastersWritable = (): void => {
  if (env.intransit.test) throw appError(ERROR_CODES.INTRANSIT_MASTERS_PROD_ONLY);
};

/**
 * Masters are in the database (else the files are, and the file editors are used): INTRANSIT_MASTERS_SOURCE=db, and
 * always where the S3 store is on (no master files there).
 */
export const mastersInDb = (): boolean => env.intransit.mastersSource === 'db' || storageOn();

export interface Change {
  master: string;
  table: string;
  rowKey: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Write change-log rows (inside the caller's transaction). */
export const logChanges = async (m: EntityManager, changes: Change[], who: Who, source: MasterChangeSource, importKey: string | null = null): Promise<void> => {
  if (!changes.length) return;
  const rows = changes.map((c) => ({
    master: c.master, tableName: c.table, rowKey: c.rowKey.slice(0, 255), field: c.field,
    oldValue: text(c.oldValue), newValue: text(c.newValue),
    action: c.oldValue === null || c.oldValue === undefined ? MASTER_CHANGE_ACTION.ADD : MASTER_CHANGE_ACTION.UPDATE,
    source, importKey, changedBy: who.id, changedByName: who.name, host: env.intransit.hostId,
  }));
  for (let i = 0; i < rows.length; i += 500) await m.getRepository(IntransitMasterChange).insert(rows.slice(i, i + 500));
};

const lc = (s: string): string => s.trim().toLowerCase();

/*
 * Bulk writes for the master uploads (2026-10-27): one statement per BULK_ROWS rows instead of one per row, inside the
 * caller's transaction (all or nothing as before). A 2,000-row file was ~2,000 queries in one long transaction.
 */
export const BULK_ROWS = 500;
const col = (c: string): string => `\`${c}\``;

/** INSERT the rows, BULK_ROWS per statement. */
export const insertMany = async (m: EntityManager, table: string, cols: string[], rows: unknown[][]): Promise<void> => {
  for (let i = 0; i < rows.length; i += BULK_ROWS) {
    const part = rows.slice(i, i + BULK_ROWS);
    await m.query(`INSERT INTO ${table} (${cols.map(col).join(', ')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`, part.flat());
  }
};

/**
 * UPDATE rows by a key column, BULK_ROWS per statement: each column is set only on the rows that change it
 * (`c = CASE key WHEN ? THEN ? ... ELSE c END`), so rows with different changed columns share one statement.
 * The key is compared like `WHERE key = ?` was (the column's collation).
 */
export const updateMany = async (m: EntityManager, table: string, keyCol: string, rows: { key: unknown; set: Record<string, unknown> }[]): Promise<void> => {
  for (let i = 0; i < rows.length; i += BULK_ROWS) {
    const part = rows.slice(i, i + BULK_ROWS);
    const cols = [...new Set(part.flatMap((r) => Object.keys(r.set)))];
    const params: unknown[] = [];
    const sets = cols.map((c) => {
      const having = part.filter((r) => c in r.set);
      having.forEach((r) => params.push(r.key, r.set[c]));
      return `${col(c)} = CASE ${col(keyCol)} ${having.map(() => 'WHEN ? THEN ?').join(' ')} ELSE ${col(c)} END`;
    });
    params.push(...part.map((r) => r.key));
    await m.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${col(keyCol)} IN (${part.map(() => '?').join(', ')})`, params);
  }
};

/**
 * Make sure every SKU is a master_skus row (the combo parts' foreign keys need them): the missing ones are added from
 * Uniware. Refused, listing them, when Uniware does not know them or cannot be asked. Returns lower-case -> pep_code
 * and the SKUs added. dryRun: Uniware is asked but nothing is inserted.
 */
export const ensureSkus = async (
  m: EntityManager, skus: string[], who: Who, master: string, source: MasterChangeSource, dryRun = false,
): Promise<{ map: Map<string, string>; added: string[] }> => {
  const wanted = [...new Map(skus.filter((s) => s && s.trim()).map((s) => [lc(s), s.trim()])).entries()];
  const have = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500).map(([, s]) => s);
    const rows = (await m.query(`SELECT pep_code FROM ${TABLES.MASTER_SKUS} WHERE pep_code IN (${chunk.map(() => '?').join(', ')})`, chunk)) as { pep_code: string }[];
    for (const r of rows) have.set(lc(r.pep_code), r.pep_code);
  }
  const missing = wanted.filter(([k]) => !have.has(k)).map(([, s]) => s);
  if (!missing.length) return { map: have, added: [] };

  const u = env.intransit.uniware;
  if (!u.tenant || !u.username || !u.password) throw appError(ERROR_CODES.INTRANSIT_UNIWARE_NEEDED, missing.join(', '), 'no Uniware login in .env');
  const api = uniwareCatalog(u);
  const found: UniwareItem[] = [];
  const unknown: string[] = [];
  for (const sku of missing) {
    let it: UniwareItem | null;
    try {
      it = await getItem(api, sku);
    } catch (err) {
      throw appError(ERROR_CODES.INTRANSIT_UNIWARE_NEEDED, missing.join(', '), err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
    // stored as asked (Uniware may answer in other letter case: the masters name it the way the file does)
    if (it) found.push({ ...it, sku: lc(it.sku) === lc(sku) ? it.sku : sku });
    else unknown.push(sku);
  }
  if (unknown.length) throw appError(ERROR_CODES.INTRANSIT_SKU_UNKNOWN, unknown.join(', ')).withDetails({ unknown });
  const rows = found.map((it) => skuRowFrom(it, it.sku, null));
  if (dryRun) {
    for (const r of rows) have.set(lc(r.pep_code), r.pep_code);
    return { map: have, added: rows.map((r) => r.pep_code) };
  }
  const cols = Object.keys(rows[0]);
  await m.query(`INSERT INTO ${TABLES.MASTER_SKUS} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ${rows.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`,
    rows.flatMap((r) => cols.map((c) => (r as Record<string, unknown>)[c])));
  await logChanges(m, rows.map((r) => ({ master, table: TABLES.MASTER_SKUS, rowKey: r.pep_code, field: null, oldValue: null, newValue: `added from Uniware: ${r.product_name ?? ''}` })), who, source);
  for (const r of rows) have.set(lc(r.pep_code), r.pep_code);
  for (const s of missing) if (!have.has(lc(s))) have.set(lc(s), s); // whatever Uniware's spelling, the asked key resolves
  return { map: have, added: rows.map((r) => r.pep_code) };
};

// ---- combos (Split1 / Split2) and variant maps, as the page edits them -----------------------------------------

/** The combos of a split stage, lower-cased. */
export const comboParents = async (stage: SkuComponentStage): Promise<Set<string>> => {
  const rows = (await AppDataSource.query(`SELECT DISTINCT combo_pep_code AS c FROM ${TABLES.MASTER_SKU_COMPONENTS} WHERE stage = ?`, [stage])) as { c: string }[];
  return new Set(rows.map((r) => lc(r.c)));
};

/** The listing SKUs that have a Final SKU, lower-cased. */
export const finalListings = async (): Promise<Set<string>> => {
  const rows = (await AppDataSource.query(`SELECT pep_code AS c FROM ${TABLES.MASTER_SKUS} WHERE final_pep_code IS NOT NULL`)) as { c: string }[];
  return new Set(rows.map((r) => lc(r.c)));
};

export interface NewCombo {
  combo: string;
  components: { sku: string; qty: number }[];
}

/** Add Split1 combos not there yet (inside `m`); returns the combos added with their part count. */
export const addCombos = async (m: EntityManager, combos: NewCombo[], who: Who, source: MasterChangeSource): Promise<{ combo: string; rows: number }[]> => {
  const { map: skus } = await ensureSkus(m, combos.flatMap((c) => [c.combo, ...c.components.map((p) => p.sku)]), who, 'Split1', source);
  const rows: unknown[][] = [];
  const changes: Change[] = [];
  const added: { combo: string; rows: number }[] = [];
  for (const c of combos) {
    const combo = skus.get(lc(c.combo)) as string;
    c.components.forEach((p, i) => {
      const part = skus.get(lc(p.sku)) as string;
      rows.push([SKU_COMPONENT_STAGE.SPLIT1, combo, part, p.qty, i + 1]); // positions from 1, as the loader writes them
      changes.push({ master: 'Split1', table: TABLES.MASTER_SKU_COMPONENTS, rowKey: `${combo} > ${part}`, field: 'qty', oldValue: null, newValue: p.qty });
    });
    added.push({ combo, rows: c.components.reduce((n, p) => n + p.qty, 0) });
  }
  if (rows.length) {
    await m.query(`INSERT INTO ${TABLES.MASTER_SKU_COMPONENTS} (stage, combo_pep_code, component_pep_code, qty, position) VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`, rows.flat());
  }
  await logChanges(m, changes, who, source);
  return added;
};

/** Give each variant its base as Final SKU (variants already mapped are left as they are); inside `m`. */
export const mapToBases = async (m: EntityManager, pairs: { variant: string; base: string }[], who: Who): Promise<{ variant: string; base: string }[]> => {
  const { map: skus } = await ensureSkus(m, pairs.flatMap((p) => [p.variant, p.base]), who, 'Final SKU Mapping', MASTER_CHANGE_SOURCE.VARIANT_MAP);
  const out: { variant: string; base: string }[] = [];
  for (const p of pairs) {
    const variant = skus.get(lc(p.variant)) as string;
    const base = skus.get(lc(p.base)) as string;
    const res = (await m.query(`UPDATE ${TABLES.MASTER_SKUS} SET final_pep_code = ? WHERE pep_code = ? AND final_pep_code IS NULL`, [base, variant])) as { affectedRows?: number };
    if (!res.affectedRows) continue;
    out.push({ variant, base });
  }
  await logChanges(m, out.map((p) => ({ master: 'Final SKU Mapping', table: TABLES.MASTER_SKUS, rowKey: p.variant, field: 'final_pep_code', oldValue: null, newValue: p.base })), who, MASTER_CHANGE_SOURCE.VARIANT_MAP);
  return out;
};
