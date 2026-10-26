/*
 * A small column table with the pandas behaviour the in-transit stages rely on (port of intransit-service/, user,
 * 2026-10-15). Only what the stages use is here; each helper notes the pandas call it stands for.
 *
 * A cell is what pandas holds in an object column: text, a number, a flag, NaN (null) or None (undefined).
 * The difference matters: pandas turns NaN into "nan" and None into "None" when it makes text of them.
 * Columns are never changed in place: every method returns a new Frame (cheap: unchanged columns are shared).
 */

export type Cell = string | number | boolean | null | undefined;
export type Col = Cell[];

// ---- Python text and number formatting -------------------------------------------------------------------------

/** Python's str.isspace() set (JS trim() differs: it strips U+FEFF and keeps U+001C-001F and U+0085). */
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const PREFIX_QUOTES_RE = /^[`']+/;

/** Python str.strip(). */
export const pyStrip = (s: string): string => s.replace(STRIP_RE, '');

/** Python repr() of a float: shortest round-trip digits, scientific below 1e-4 and from 1e16. */
export const pyRepr = (v: number): string => {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  const [mant, expStr] = v.toExponential().split('e');
  const exp = Number(expStr);
  if (exp < -4 || exp >= 16) {
    const m = mant.includes('.') ? mant : mant;
    return `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const neg = mant.startsWith('-');
  const digits = mant.replace('-', '').replace('.', '');
  const point = exp + 1;
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = `${digits}${'0'.repeat(point - digits.length)}.0`;
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return neg ? `-${out}` : out;
};

/** A whole number as Python's str(int(v)) writes it (exact, never in exponent form). */
const intStr = (v: number): string => (Math.abs(v) < 1e21 ? String(Math.trunc(v)) : BigInt(Math.trunc(v)).toString()).replace(/^-0$/, '0');

/** pandas .astype(str) of one cell. A whole number is written as an int ("5"), as the stages' numbers are. */
export const pyStr = (c: Cell): string => {
  if (c === null) return 'nan';
  if (c === undefined) return 'None';
  if (typeof c === 'boolean') return c ? 'True' : 'False';
  if (typeof c === 'number') return Number.isInteger(c) ? intStr(c) : pyRepr(c);
  return c;
};

/** The workbook text of a cell (excel.py fmt_val): NaN/None blank, whole floats as ints, other floats as repr. */
export const fmtVal = (c: Cell): string => {
  if (c === null || c === undefined) return '';
  if (typeof c === 'number') {
    if (Number.isNaN(c)) return '';
    return Number.isInteger(c) ? intStr(c) : pyRepr(c);
  }
  if (typeof c === 'boolean') return c ? 'True' : 'False';
  return c;
};

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INF_RE = /^([+-]?)(?:inf|infinity)$/i;

/** pd.to_numeric(errors="coerce") of one cell: a number, or null (NaN). Text is trimmed; "5,000" is NaN. */
export const toNumber = (c: Cell): number | null => {
  if (typeof c === 'number') return Number.isNaN(c) ? null : c;
  if (typeof c === 'boolean') return c ? 1 : 0;
  if (c === null || c === undefined) return null;
  const t = c.trim();
  if (NUMBER_RE.test(t)) return Number(t);
  const inf = INF_RE.exec(t);
  if (inf) return inf[1] === '-' ? -Infinity : Infinity;
  return null;
};

/** numpy round(v, 0): halves go to the even neighbour. */
export const roundHalfEven = (v: number): number => {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

// ---- column helpers (pandas Series methods) --------------------------------------------------------------------

export const isNa = (c: Cell): boolean => c === null || c === undefined || (typeof c === 'number' && Number.isNaN(c));

/** .astype(str) */
export const asStr = (col: Col): string[] => col.map(pyStr);
/** .astype(str).str.strip() */
export const stripped = (col: Col): string[] => col.map((c) => pyStrip(pyStr(c)));
/** .astype(str).str.strip().str.lstrip("`'"): text without Excel's text-prefix quote. */
export const unquoted = (col: Col): string[] => col.map((c) => pyStrip(pyStr(c)).replace(PREFIX_QUOTES_RE, ''));
/** io.norm_key: the case-insensitive join key. */
export const normKey = (col: Col): string[] => col.map((c) => pyStrip(pyStr(c)).replace(PREFIX_QUOTES_RE, '').toLowerCase());
/** io.strip_text: trimmed text, prefix quotes removed, nan/None/NaN blanked. */
export const stripText = (col: Col): string[] =>
  col.map((c) => {
    const t = pyStrip(pyStr(c)).replace(PREFIX_QUOTES_RE, '');
    return t === 'nan' || t === 'None' || t === 'NaN' ? '' : t;
  });
export const lower = (col: string[]): string[] => col.map((s) => s.toLowerCase());
export const upper = (col: string[]): string[] => col.map((s) => s.toUpperCase());

/** .fillna(value) with a scalar or an aligned column. */
export const fillna = (col: Col, value: Cell | Col): Col =>
  col.map((c, i) => (isNa(c) ? (Array.isArray(value) ? value[i] : value) : c));

/** pd.to_numeric(errors="coerce") (NaN as null). */
export const toNumeric = (col: Col): (number | null)[] => col.map(toNumber);
/** io.to_num: to_numeric, NaN as 0. */
export const toNum = (col: Col): number[] => col.map((c) => toNumber(c) ?? 0);

/** .map(dict): null (NaN) where the key is not in the map. */
export const mapWith = <K extends Cell, V extends Cell>(col: readonly Cell[], map: ReadonlyMap<K, V>): (V | null)[] =>
  col.map((c) => (map.has(c as K) ? (map.get(c as K) as V) : null));

/** .isin(values) */
export const isIn = (col: readonly Cell[], values: ReadonlySet<unknown> | readonly unknown[]): boolean[] => {
  const set: ReadonlySet<unknown> = values instanceof Set ? values : new Set(values as readonly unknown[]);
  return col.map((c) => set.has(c));
};

export const not = (mask: boolean[]): boolean[] => mask.map((m) => !m);
export const and = (...masks: boolean[][]): boolean[] => masks[0].map((_, i) => masks.every((m) => m[i]));
export const or = (...masks: boolean[][]): boolean[] => masks[0].map((_, i) => masks.some((m) => m[i]));
export const countTrue = (mask: boolean[]): number => mask.reduce((n, m) => n + (m ? 1 : 0), 0);
export const sum = (col: readonly Cell[]): number => col.reduce<number>((t, c) => (typeof c === 'number' && !Number.isNaN(c) ? t + c : t), 0);

/** A regex that matches any of the words (str.contains with "|".join(map(re.escape, words))). */
export const anyWordRe = (words: string[]): RegExp => new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

/**
 * io.canon_values: every casing of a value becomes its most frequent spelling (ties: the first in sort order),
 * so one real code makes one row.
 */
export const canonValues = (col: Col): string[] => {
  const v = stripped(col);
  const counts = new Map<string, Map<string, number>>();
  for (const s of v) {
    const low = s.toLowerCase();
    let byVal = counts.get(low);
    if (!byVal) counts.set(low, (byVal = new Map()));
    byVal.set(s, (byVal.get(s) ?? 0) + 1);
  }
  const best = new Map<string, string>();
  for (const [low, byVal] of counts) {
    let pick = '';
    let n = -1;
    for (const [val, k] of byVal) if (k > n || (k === n && val < pick)) [pick, n] = [val, k];
    best.set(low, pick);
  }
  return v.map((s) => best.get(s.toLowerCase()) ?? s);
};

// ---- keys, comparison ------------------------------------------------------------------------------------------

/** A Map/Set key for a tuple of cells: equal when pandas treats them as equal (NaN equals NaN, 5 equals 5.0). */
export const keyOf = (cells: readonly Cell[]): string => {
  let k = '';
  for (const c of cells) {
    if (typeof c === 'string') k += `s${c}\u0001`;
    else if (typeof c === 'number') k += Number.isNaN(c) ? 'N\u0001' : `n${c}\u0001`;
    else if (c === null) k += 'N\u0001';
    else if (c === undefined) k += 'U\u0001';
    else k += `b${c}\u0001`;
  }
  return k;
};

/** Python's ordering of two cells of one column; NaN/None sort after everything. */
export const compareCells = (a: Cell, b: Cell): number => {
  const na = isNa(a);
  const nb = isNa(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

// ---- the table -------------------------------------------------------------------------------------------------

export class Frame {
  private constructor(
    readonly columns: readonly string[],
    private readonly data: ReadonlyMap<string, Col>,
    readonly length: number,
  ) {}

  static of(columns: readonly string[], data: readonly Col[], length = data[0]?.length ?? 0): Frame {
    return new Frame([...columns], new Map(columns.map((c, i) => [c, data[i]])), length);
  }

  /** pd.DataFrame({...}): columns in key order; a scalar is repeated to `length` (or the first column's length). */
  static from(rec: Record<string, Cell | Col>, length?: number): Frame {
    const n = length ?? Object.values(rec).find(Array.isArray)?.length ?? 0;
    const cols = Object.keys(rec);
    return Frame.of(cols, cols.map((c) => (Array.isArray(rec[c]) ? (rec[c] as Col) : new Array<Cell>(n).fill(rec[c] as Cell))), n);
  }

  static fromRows(columns: readonly string[], rows: readonly Cell[][]): Frame {
    return Frame.of(columns, columns.map((_, j) => rows.map((r) => r[j])), rows.length);
  }

  static empty(columns: readonly string[] = []): Frame {
    return Frame.of(columns, columns.map(() => []), 0);
  }

  get empty(): boolean {
    return this.length === 0 || this.columns.length === 0;
  }

  has(c: string): boolean {
    return this.data.has(c);
  }

  /** df[c]; a missing column is an error, as in pandas (KeyError). */
  get(c: string): Col {
    const col = this.data.get(c);
    if (!col) throw new Error(`column not found: '${c}'`);
    return col;
  }

  /** df[c] if present, else a column of `fill`. */
  getOr(c: string, fill: Cell): Col {
    return this.data.get(c) ?? new Array<Cell>(this.length).fill(fill);
  }

  /** df[c] = values: replaces the column in place, or appends it. */
  set(c: string, values: Col | Cell): Frame {
    const col = Array.isArray(values) ? values : new Array<Cell>(this.length).fill(values);
    if (col.length !== this.length && this.columns.length) throw new Error(`column '${c}' has ${col.length} rows, frame has ${this.length}`);
    const data = new Map(this.data);
    data.set(c, col);
    return new Frame(this.has(c) ? this.columns : [...this.columns, c], data, this.columns.length ? this.length : col.length);
  }

  /** Several df[c] = values in order. */
  assign(rec: Record<string, Col | Cell>): Frame {
    return Object.entries(rec).reduce<Frame>((f, [c, v]) => f.set(c, v), this);
  }

  /** df.insert(pos, c, values) */
  insert(pos: number, c: string, values: Col): Frame {
    const data = new Map(this.data);
    data.set(c, values);
    const cols = this.columns.filter((x) => x !== c);
    cols.splice(pos, 0, c);
    return new Frame(cols, data, this.length);
  }

  /** df[cols] */
  select(cols: readonly string[]): Frame {
    return Frame.of(cols, cols.map((c) => this.get(c)), this.length);
  }

  /** df.drop(columns=cols, errors="ignore") */
  drop(cols: readonly string[]): Frame {
    const gone = new Set(cols);
    return this.select(this.columns.filter((c) => !gone.has(c)));
  }

  /** df.rename(columns=map) */
  rename(map: Record<string, string>): Frame {
    const cols = this.columns.map((c) => map[c] ?? c);
    return Frame.of(cols, this.columns.map((c) => this.get(c)), this.length);
  }

  /** Rows by position (df.iloc[idx]). */
  take(idx: readonly number[]): Frame {
    return Frame.of(this.columns, this.columns.map((c) => {
      const col = this.get(c);
      return idx.map((i) => col[i]);
    }), idx.length);
  }

  /** df[mask] */
  filter(mask: readonly boolean[]): Frame {
    const idx: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
    return this.take(idx);
  }

  /** df.loc[mask, c] = values (a scalar or a full-length column). */
  setWhere(mask: readonly boolean[], c: string, values: Cell | Col): Frame {
    const old = this.getOr(c, null);
    return this.set(c, old.map((v, i) => (mask[i] ? (Array.isArray(values) ? values[i] : values) : v)));
  }

  row(i: number): Cell[] {
    return this.columns.map((c) => this.get(c)[i]);
  }

  /** pd.concat(frames, ignore_index=True): union of columns in order of appearance; missing cells are NaN. */
  static concat(frames: readonly Frame[]): Frame {
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const f of frames) for (const c of f.columns) if (!seen.has(c)) seen.add(c), cols.push(c);
    const n = frames.reduce((t, f) => t + f.length, 0);
    return Frame.of(cols, cols.map((c) => frames.flatMap((f) => (f.has(c) ? f.get(c) : new Array<Cell>(f.length).fill(null)))), n);
  }

  /** The key tuple of every row over `cols`, as Map keys. */
  keys(cols: readonly string[]): string[] {
    const data = cols.map((c) => this.get(c));
    const out = new Array<string>(this.length);
    for (let i = 0; i < this.length; i++) out[i] = keyOf(data.map((d) => d[i]));
    return out;
  }

  /** df.drop_duplicates(subset=cols, keep=...) */
  dropDuplicates(cols: readonly string[] = this.columns, keep: 'first' | 'last' = 'first'): Frame {
    const keys = this.keys(cols);
    const pos = new Map<string, number>();
    keys.forEach((k, i) => {
      if (keep === 'last' || !pos.has(k)) pos.set(k, i);
    });
    return this.take([...pos.values()].sort((a, b) => a - b));
  }

  /**
   * df.sort_values(cols, ascending=...): stable, NaN last. pandas' single-column sort is a quicksort, so rows that
   * tie on the sort key may come out in another order there; here they keep their order.
   */
  sortValues(cols: readonly string[], ascending: boolean | readonly boolean[] = true): Frame {
    const asc = cols.map((_, i) => (Array.isArray(ascending) ? ascending[i] : ascending) as boolean);
    const data = cols.map((c) => this.get(c));
    const idx = Array.from({ length: this.length }, (_, i) => i);
    idx.sort((a, b) => {
      for (let k = 0; k < data.length; k++) {
        const x = data[k][a];
        const y = data[k][b];
        if (isNa(x) || isNa(y)) {
          const d = compareCells(x, y); // NaN last whichever the direction
          if (d) return d;
          continue;
        }
        const d = compareCells(x, y);
        if (d) return asc[k] ? d : -d;
      }
      return a - b;
    });
    return this.take(idx);
  }

  /**
   * df.groupby(cols, dropna=...) groups: sorted by key (NaN keys last), rows in their original order.
   * dropna (pandas' default) leaves out rows with a NaN in any key column.
   */
  groupBy(cols: readonly string[], dropna = true): Groups {
    const data = cols.map((c) => this.get(c));
    const byKey = new Map<string, { key: Cell[]; rows: number[] }>();
    for (let i = 0; i < this.length; i++) {
      const key = data.map((d) => d[i]);
      if (dropna && key.some(isNa)) continue;
      const k = keyOf(key);
      const g = byKey.get(k);
      if (g) g.rows.push(i);
      else byKey.set(k, { key, rows: [i] });
    }
    const groups = [...byKey.values()].sort((a, b) => {
      for (let j = 0; j < a.key.length; j++) {
        const d = compareCells(a.key[j], b.key[j]);
        if (d) return d;
      }
      return 0;
    });
    return new Groups(this, cols, groups);
  }

  /**
   * df.merge(right, left_on, right_on, how="left", suffixes): every left row in order, each repeated once per
   * matching right row (in the right's order); no match gives NaN right cells. A key named the same on both sides
   * is one column; other names found on both sides get the suffixes.
   */
  mergeLeft(right: Frame, leftOn: readonly string[], rightOn: readonly string[] = leftOn, suffixes: [string, string] = ['_x', '_y']): Frame {
    const shared = new Set(leftOn.filter((c, i) => rightOn[i] === c));
    const rightCols = right.columns.filter((c) => !shared.has(c));
    const overlap = new Set(rightCols.filter((c) => this.has(c)));
    const leftNames = this.columns.map((c) => (overlap.has(c) ? c + suffixes[0] : c));
    const rightNames = rightCols.map((c) => (overlap.has(c) ? c + suffixes[1] : c));

    const index = new Map<string, number[]>();
    right.keys(rightOn).forEach((k, i) => {
      const list = index.get(k);
      if (list) list.push(i);
      else index.set(k, [i]);
    });
    const leftIdx: number[] = [];
    const rightIdx: number[] = [];
    this.keys(leftOn).forEach((k, i) => {
      const hits = index.get(k);
      if (hits) for (const r of hits) leftIdx.push(i), rightIdx.push(r);
      else leftIdx.push(i), rightIdx.push(-1);
    });
    const cols = [
      ...this.columns.map((c) => leftIdx.map((i) => this.get(c)[i])),
      ...rightCols.map((c) => {
        const col = right.get(c);
        return rightIdx.map((r) => (r < 0 ? null : col[r]));
      }),
    ];
    return Frame.of([...leftNames, ...rightNames], cols, leftIdx.length);
  }

  /** {key: value} from the first row of each key (drop_duplicates(key).set_index(key)[value].to_dict()). */
  lookup(keyCol: string, valueCol: string, keep: 'first' | 'last' = 'first'): Map<Cell, Cell> {
    const keys = this.get(keyCol);
    const vals = this.get(valueCol);
    const out = new Map<Cell, Cell>();
    for (let i = 0; i < this.length; i++) if (keep === 'last' || !out.has(keys[i])) out.set(keys[i], vals[i]);
    return out;
  }
}

export interface Group {
  key: Cell[];
  rows: number[];
}

/** The result of Frame.groupBy: aggregations give one row per group, keys first (as_index=False). */
export class Groups {
  constructor(
    readonly frame: Frame,
    readonly cols: readonly string[],
    readonly groups: Group[],
  ) {}

  /**
   * .agg(name=(column, how)) with as_index=False: the key columns, then one column per entry.
   * how: sum (NaN skipped, 0 when empty), size, first (first non-NaN value).
   */
  agg(spec: Record<string, [string, 'sum' | 'size' | 'first']>): Frame {
    const keyCols = this.cols.map((_, j) => this.groups.map((g) => g.key[j]));
    const aggCols = Object.values(spec).map(([col, how]) => {
      const data = this.frame.get(col);
      return this.groups.map((g): Cell => {
        if (how === 'size') return g.rows.length;
        if (how === 'sum') return g.rows.reduce<number>((t, i) => {
          const v = data[i];
          return typeof v === 'number' && !Number.isNaN(v) ? t + v : t;
        }, 0);
        for (const i of g.rows) if (!isNa(data[i])) return data[i];
        return null;
      });
    });
    return Frame.of([...this.cols, ...Object.keys(spec)], [...keyCols, ...aggCols], this.groups.length);
  }

  /** .sum() of one column with as_index=False. */
  sum(col: string): Frame {
    return this.agg({ [col]: [col, 'sum'] });
  }

  /** Map from the group's key tuple (keyOf) to a value per group. */
  map<V>(fn: (g: Group) => V): Map<string, V> {
    return new Map(this.groups.map((g) => [keyOf(g.key), fn(g)]));
  }
}
