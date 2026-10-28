import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { MasterLogAction, MasterLogSource, MasterLogType } from '../../constants';
import { MasterChangeLog } from '../../entities';

/*
 * The masters change log (2026-10-28): every add / edit / (de)activate / replace of a row on the 5 Masters tabs is
 * written to master_change_logs inside the caller's transaction (no change without its log; the log failing fails
 * the change). One batch id per save; one row per changed field, or one row for an action.
 */

export interface MasterLogEntry {
  type: MasterLogType;
  recordId: string | number | null;
  rowKey: string;
  action: MasterLogAction;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

const text = (v: unknown): string | null =>
  v === null || v === undefined ? null : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);

/** What a row was added with, as one readable value: "mrp: 299; gstTaxType: 18; ...". Empty values left out. */
export const addedWith = (values: Record<string, unknown>): string =>
  Object.entries(values).map(([k, v]) => [k, text(v)] as const).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}: ${v}`).join('; ');

/** Writes the entries as one batch; returns the batch id. */
export const logMasterChanges = async (
  m: EntityManager, entries: MasterLogEntry[], by: { id: number | null }, source: MasterLogSource, remark: string | null = null,
): Promise<string> => {
  const batchId = randomUUID();
  if (!entries.length) return batchId;
  await m.getRepository(MasterChangeLog).insert(entries.map((e) => ({
    masterType: e.type, recordId: e.recordId === null ? null : String(e.recordId), rowKey: e.rowKey.slice(0, 255), action: e.action, source,
    fieldName: e.field ?? null, oldValue: text(e.oldValue), newValue: text(e.newValue), remark, batchId, userId: by.id,
  })));
  return batchId;
};
