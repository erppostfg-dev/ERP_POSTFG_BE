/*
 * Matching free text (as PEPIMS, Uniware or an old row wrote it) to a master row by its code or one of its aliases.
 * Spaces at the ends are always ignored. Case is ignored too, EXCEPT for facilities: upper and lower case are
 * different warehouses there (capitals = the main warehouse, lower / mixed case = its child; user, 2026-10-14), so
 * MUM_WAREHOUSE2 and MUM_Warehouse2 are two facilities and are matched exactly (EXACT_MATCH).
 * Used by the PO validation (facility of a location) and by masters:link (fills the *_id columns).
 */

export const matchKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

export interface CodedRow {
  id: number;
  code: string;
  aliases: string[] | null;
}

/** codeIndex option for facilities: case counts. */
export const EXACT_MATCH = { exact: true } as const;

export interface CodeIndex<T extends CodedRow> {
  /** The row whose code or alias is `text`; null when none (or `text` is empty). */
  find: (text: string | null | undefined) => T | null;
  byId: Map<number, T>;
}

/**
 * Index of master rows by code and aliases. A code wins over another row's alias; when two rows share an alias, the
 * first one keeps it (masters:load reports such clashes).
 */
export const codeIndex = <T extends CodedRow>(rows: T[], opts: { exact?: boolean } = {}): CodeIndex<T> => {
  const key = opts.exact ? (v: string | null | undefined) => (v ?? '').trim() : matchKey;
  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(key(r.code), r);
  for (const r of rows) for (const a of r.aliases ?? []) if (key(a) && !byKey.has(key(a))) byKey.set(key(a), r);
  return {
    find: (text) => (key(text) ? byKey.get(key(text)) ?? null : null),
    byId: new Map(rows.map((r) => [r.id, r])),
  };
};
