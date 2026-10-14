/*
 * Matching free text (as PEPIMS, Uniware or an old row wrote it) to a master row by its code or one of its aliases.
 * Case and spaces at the ends are ignored, so "MUM_Warehouse2 " finds the facility MUM_WAREHOUSE2.
 * Used by the PO validation (facility of a location) and by masters:link (fills the *_id columns).
 */

export const matchKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

export interface CodedRow {
  id: number;
  code: string;
  aliases: string[] | null;
}

export interface CodeIndex<T extends CodedRow> {
  /** The row whose code or alias is `text`; null when none (or `text` is empty). */
  find: (text: string | null | undefined) => T | null;
  byId: Map<number, T>;
}

/**
 * Index of master rows by code and aliases. A code wins over another row's alias; when two rows share an alias, the
 * first one keeps it (masters:load reports such clashes).
 */
export const codeIndex = <T extends CodedRow>(rows: T[]): CodeIndex<T> => {
  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(matchKey(r.code), r);
  for (const r of rows) for (const a of r.aliases ?? []) if (matchKey(a) && !byKey.has(matchKey(a))) byKey.set(matchKey(a), r);
  return {
    find: (text) => (matchKey(text) ? byKey.get(matchKey(text)) ?? null : null),
    byId: new Map(rows.map((r) => [r.id, r])),
  };
};
