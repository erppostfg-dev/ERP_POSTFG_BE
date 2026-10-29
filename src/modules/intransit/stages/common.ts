import { Cell, Col, Frame, fillna, isIn, pyStr, stripped, upper } from '../frame';

/*
 * Helpers several stages share (io.py drop_superseded_cancellations, and pandas' df.fillna("") on a whole frame).
 */

/** df.fillna(value) on every column. */
export const fillAll = (df: Frame, value: Cell): Frame => df.assign(Object.fromEntries(df.columns.map((c) => [c, fillna(df.get(c), value)])));

/**
 * io.drop_superseded_cancellations: one PO can span several sale orders, typically a cancelled original plus a live
 * replacement. Where a PO has any live sale order its cancelled ones are dropped; POs where every sale order is
 * cancelled keep their rows.
 */
export const dropSupersededCancellations = (df: Frame, poKey: readonly Cell[], statusCol = 'Sale Order Status'): Frame => {
  const cancelled = upper(stripped(df.get(statusCol))).map((s) => s === 'CANCELLED');
  const hasLive = new Map<string, boolean>();
  poKey.forEach((k, i) => {
    const key = pyStr(k);
    if (!cancelled[i]) hasLive.set(key, true);
    else if (!hasLive.has(key)) hasLive.set(key, false);
  });
  return df.filter(cancelled.map((c, i) => !(c && hasLive.get(pyStr(poKey[i])))));
};

/** A Yes/No column from a mask. */
export const yesNo = (mask: readonly boolean[]): string[] => mask.map((m) => (m ? 'Yes' : 'No'));

/** Columns of `cols` that exist in df. */
export const present = (df: Frame, cols: readonly string[]): string[] => cols.filter((c) => df.has(c));

/** Positions where `col` is in `values`. */
export const inSet = (col: Col, values: Set<Cell>): boolean[] => isIn(col, values);
