import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, MASTER_HISTORY, MASTER_LOG_ACTION, MASTER_LOG_TYPE, MasterLogType, TABLES } from '../../constants';
import { appError } from '../../utils/AppError';

/*
 * Masters history (2026-10-28, user: "anyone can see who changed it by clicking the History button"). Two logs are read
 * and merged, newest first:
 *   - master_change_logs: adds / edits / (de)activations on the Masters pages and masters:replace (row id = record_id);
 *   - intransit_master_changes: the in-transit master uploads (Ajay's; rows named by text: the PEP code for master_skus,
 *     "<channel> | <location code>" for details_channels), matched by the row's key as it is now.
 * Every entry has the shape of the PO Overview history (the screen groups the rows of one save by batchId); in-transit
 * rows have no batch id, so one upload (same time, same person) is grouped by a made-up one.
 *   rowHistory(type, id)   one row's history (at most ROW_LIMIT)
 *   recentChanges(q)       every master's changes of the last `days` days (at most CHANGES_LIMIT), optional type
 * Read-only.
 */

export interface MasterHistoryItem {
  id: string;
  at: string;
  by: string | null;
  byEmail: string | null;
  /** Kept for the shared timeline (people have no team here). */
  byTeam: null;
  action: string;
  source: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  remark: string | null;
  batchId: string | null;
  valueHidden: false;
  type: MasterLogType;
  recordId: string | null;
  rowKey: string;
  /** Which log the entry came from. */
  from: 'masters' | 'intransit';
}

const TYPES = Object.values(MASTER_LOG_TYPE) as string[];
export const isMasterLogType = (t: unknown): t is MasterLogType => typeof t === 'string' && TYPES.includes(t);

/** The in-transit log's table per master type (only these two are written by the in-transit uploads). */
const INTRANSIT_TABLE: Partial<Record<MasterLogType, string>> = {
  [MASTER_LOG_TYPE.PEP_SKU]: TABLES.MASTER_SKUS,
  [MASTER_LOG_TYPE.LOCATION]: TABLES.DETAILS_CHANNELS,
};
const TYPE_OF_TABLE = Object.fromEntries(Object.entries(INTRANSIT_TABLE).map(([t, table]) => [table, t])) as Record<string, MasterLogType>;

type OwnRow = { id: string | number; at: Date; name: string | null; email: string | null; master_type: MasterLogType; record_id: string | number | null;
  row_key: string; action: string; source: string; field: string | null; old_value: string | null; new_value: string | null; remark: string | null; batch_id: string };
type TransitRow = { id: string | number; at: Date; name: string | null; email: string | null; by_name: string | null; by_id: number | null; table_name: string;
  row_key: string; field: string | null; old_value: string | null; new_value: string | null; source: string };

const OWN_SELECT = `SELECT l.id, l.created_at at, u.name, u.email, l.master_type, l.record_id, l.row_key, l.action, l.source, l.field_name field,
  l.old_value, l.new_value, l.remark, l.batch_id FROM ${TABLES.MASTER_CHANGE_LOGS} l LEFT JOIN ${TABLES.USERS} u ON u.id = l.user_id`;
const TRANSIT_SELECT = `SELECT c.id, c.changed_at at, u.name, u.email, c.changed_by_name by_name, c.changed_by by_id, c.table_name, c.row_key, c.field,
  c.old_value, c.new_value, c.source FROM ${TABLES.INTRANSIT_MASTER_CHANGES} c LEFT JOIN ${TABLES.USERS} u ON u.id = c.changed_by`;

const own = (r: OwnRow): MasterHistoryItem => ({
  id: `m${r.id}`, at: new Date(r.at).toISOString(), by: r.name, byEmail: r.email, byTeam: null, action: r.action, source: r.source,
  field: r.field, oldValue: r.old_value, newValue: r.new_value, remark: r.remark, batchId: r.batch_id, valueHidden: false,
  type: r.master_type, recordId: r.record_id === null ? null : String(r.record_id), rowKey: r.row_key, from: 'masters',
});
const transit = (r: TransitRow, recordId: string | null): MasterHistoryItem => {
  const at = new Date(r.at);
  return {
    id: `t${r.id}`, at: at.toISOString(), by: r.name ?? r.by_name, byEmail: r.email, byTeam: null,
    // a whole row added has no field; a value set or changed is a field change (old null = was empty)
    action: r.field ? MASTER_LOG_ACTION.FIELD_CHANGED : MASTER_LOG_ACTION.CREATED,
    source: `${MASTER_HISTORY.INTRANSIT_SOURCE_PREFIX}${r.source}`,
    field: r.field, oldValue: r.old_value, newValue: r.new_value, remark: null,
    // one upload = same second + same person
    batchId: `t${Math.floor(at.getTime() / 1000)}-${r.by_id ?? ''}`, valueHidden: false,
    type: TYPE_OF_TABLE[r.table_name], recordId, rowKey: r.row_key, from: 'intransit',
  };
};
const newestFirst = (a: MasterHistoryItem, b: MasterHistoryItem) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

const bad = (what: string) => appError(ERROR_CODES.MASTER_HISTORY_BAD_REQUEST, what);

/** The row's key(s) as the in-transit log names it today (none for masters that log only ours). */
const transitKeys = async (type: MasterLogType, id: string): Promise<string[]> => {
  if (type === MASTER_LOG_TYPE.PEP_SKU) {
    const r = (await AppDataSource.query(`SELECT pep_code k FROM ${TABLES.MASTER_SKUS} WHERE id = ?`, [id])) as { k: string }[];
    return r.map((x) => x.k);
  }
  if (type === MASTER_LOG_TYPE.LOCATION) {
    const r = (await AppDataSource.query(
      `SELECT d.channel_name n, c.display_name d, d.channel_location_code code FROM ${TABLES.DETAILS_CHANNELS} d
         LEFT JOIN ${TABLES.MASTER_CHANNELS} c ON c.id = d.channel_id WHERE d.id = ?`, [id],
    )) as { n: string | null; d: string | null; code: string | null }[];
    return [...new Set(r.flatMap((x) => [x.n, x.d].filter(Boolean).map((ch) => `${ch} | ${x.code ?? ''}`)))];
  }
  return [];
};

export const rowHistory = async (type: unknown, rawId: unknown): Promise<MasterHistoryItem[]> => {
  if (!isMasterLogType(type)) throw bad(`unknown master "${String(type)}" (one of ${TYPES.join(', ')})`);
  const id = String(rawId ?? '');
  if (!/^[1-9]\d{0,18}$/.test(id)) throw bad(`row id "${id}" is not a number`);
  const keys = await transitKeys(type, id);
  const [ours, theirs] = await Promise.all([
    AppDataSource.query(`${OWN_SELECT} WHERE l.master_type = ? AND l.record_id = ? ORDER BY l.id DESC LIMIT ${MASTER_HISTORY.ROW_LIMIT}`, [type, id]) as Promise<OwnRow[]>,
    keys.length
      ? AppDataSource.query(`${TRANSIT_SELECT} WHERE c.table_name = ? AND c.row_key IN (${keys.map(() => '?').join(', ')}) ORDER BY c.id DESC LIMIT ${MASTER_HISTORY.ROW_LIMIT}`,
        [INTRANSIT_TABLE[type], ...keys]) as Promise<TransitRow[]>
      : Promise.resolve([] as TransitRow[]),
  ]);
  return [...ours.map(own), ...theirs.map((r) => transit(r, id))].sort(newestFirst).slice(0, MASTER_HISTORY.ROW_LIMIT);
};

export const recentChanges = async (q: { type?: unknown; days?: unknown }): Promise<MasterHistoryItem[]> => {
  const type = q.type === undefined || q.type === '' ? null : q.type;
  if (type !== null && !isMasterLogType(type)) throw bad(`unknown master "${String(type)}" (one of ${TYPES.join(', ')})`);
  const days = q.days === undefined || q.days === '' ? MASTER_HISTORY.DAYS_DEFAULT : Number(q.days);
  if (!Number.isInteger(days) || days < 1 || days > MASTER_HISTORY.DAYS_MAX) throw bad(`days must be a whole number 1-${MASTER_HISTORY.DAYS_MAX}`);
  const since = new Date(Date.now() - days * 86_400_000);
  const tables = type ? [INTRANSIT_TABLE[type]].filter(Boolean) as string[] : Object.values(INTRANSIT_TABLE) as string[];
  const [ours, theirs] = await Promise.all([
    AppDataSource.query(`${OWN_SELECT} WHERE l.created_at >= ?${type ? ' AND l.master_type = ?' : ''} ORDER BY l.created_at DESC, l.id DESC LIMIT ${MASTER_HISTORY.CHANGES_LIMIT}`,
      type ? [since, type] : [since]) as Promise<OwnRow[]>,
    tables.length
      ? AppDataSource.query(`${TRANSIT_SELECT} WHERE c.changed_at >= ? AND c.table_name IN (${tables.map(() => '?').join(', ')}) ORDER BY c.changed_at DESC, c.id DESC LIMIT ${MASTER_HISTORY.CHANGES_LIMIT}`,
        [since, ...tables]) as Promise<TransitRow[]>
      : Promise.resolve([] as TransitRow[]),
  ]);
  return [...ours.map(own), ...theirs.map((r) => transit(r, null))].sort(newestFirst).slice(0, MASTER_HISTORY.CHANGES_LIMIT);
};
