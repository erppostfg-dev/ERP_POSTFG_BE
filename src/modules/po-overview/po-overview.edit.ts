import { randomUUID } from 'crypto';
import { AppDataSource } from '../../config/data-source';
import {
  APPOINTMENT_FIELD,
  COLUMN_ACCESS,
  DAY_PATTERN,
  EDIT_TEXT_MAX,
  ERROR_CODES,
  PO_TEAM_COLUMNS,
  PO_TEAM_ORDER,
  REMARK_LIST,
  SHIPMENT_LOG_ACTION,
  SHIPMENT_LOG_SOURCE,
  STATUS_FIELD_STAGE,
  TABLES,
  TRANSPORTER_FIELD_LINK,
} from '../../constants';
import { MasterAppointmentRemark, MasterCourierPartner, MasterPurchaseOrder, MasterShipmentStatus, ShipmentLog, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { codeIndex, matchKey } from '../masters/master-match';
import { canEditShipment, PoOverviewAccess } from './po-overview.access';
import { flushChanges } from './po-overview.live';

/*
 * Saving a shipment from the PO Overview (2026-10-14). Body: { changes: { <field>: { from, to } }, remark? }.
 * Checks, all on the server, in this order; any failure saves nothing:
 *   1. the field may be edited by the person (a column group with access "edit", not a locked column);
 *   2. the shipment is editable by them (their facilities for warehouse / logistics);
 *   3. every value is valid for its column (type and length read from the entity), statuses from the status master,
 *      transporters from the courier master, a changed appointment date has a remark from the remark list;
 *   4. nobody changed the field since the person opened it: `from` must equal what is stored (row locked meanwhile).
 * Then, in the same transaction: the fields, the transporter links, the appointment history lists, updatedAt, and one
 * shipment_logs row per changed field (same batch id). After the commit flushChanges() tells every live screen.
 */

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export interface ConflictDetail {
  field: string;
  /** What is stored now. */
  now: unknown;
  /** Who changed it last, and when (from shipment_logs). */
  by: string | null;
  at: string | null;
}

const meta = () => AppDataSource.getMetadata(MasterPurchaseOrder);

/** Fields the person may edit: their "edit" groups' columns that are not locked. */
export const editableFields = (a: PoOverviewAccess): Set<string> =>
  new Set(PO_TEAM_ORDER.filter((t) => a.groups[t] === COLUMN_ACCESS.EDIT).flatMap((t) => PO_TEAM_COLUMNS[t].filter((c) => !c.locked).map((c) => c.field)));

const dayOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

/** A value in the column's own shape (dates YYYY-MM-DD, numbers, trimmed text), or undefined when it is not valid. */
const shapeFor = (field: string, v: unknown): string | number | null | undefined => {
  const col = meta().findColumnWithPropertyName(field);
  if (!col) return undefined;
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
  const type = String(col.type);
  if (type === 'date') {
    const s = typeof v === 'string' ? v.trim() : v instanceof Date ? dayOf(v) ?? '' : '';
    return DAY_PATTERN.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
  }
  if (type === 'int' || type === 'decimal') {
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n) || n < 0 || (type === 'int' && !Number.isInteger(n))) return undefined;
    return n;
  }
  if (type === 'enum') return (col.enum ?? []).map(String).includes(String(v)) ? String(v) : undefined;
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  const max = type === 'varchar' ? Number(col.length || 255) : EDIT_TEXT_MAX;
  return s.length <= max ? s : undefined;
};

/** What is stored, in the same shape as shapeFor's result (so the two compare). */
const storedShape = (field: string, v: unknown): string | number | null => {
  const col = meta().findColumnWithPropertyName(field);
  if (v === null || v === undefined || v === '') return null;
  if (col && String(col.type) === 'date') return dayOf(v);
  if (col && (String(col.type) === 'int' || String(col.type) === 'decimal')) return Number(v);
  return String(v);
};
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

export const saveShipment = async (
  uid: string,
  changes: FieldChanges,
  remark: string | undefined,
  user: User,
  a: PoOverviewAccess,
): Promise<{ logIds: string[] }> => {
  const fields = Object.keys(changes);
  if (!fields.length) throw appError(ERROR_CODES.NO_CHANGES);

  // 1. may edit these fields
  const allowed = editableFields(a);
  const refused = fields.filter((f) => !allowed.has(f) || !meta().findColumnWithPropertyName(f));
  if (refused.length) throw appError(ERROR_CODES.FIELDS_NOT_EDITABLE, refused.join(', ')).withDetails({ fields: refused });

  // 3a. values valid for their columns (before the transaction: no lock held while answering bad input)
  const problems: { field: string; code: string; message: string }[] = [];
  const next: Record<string, string | number | null> = {};
  for (const f of fields) {
    const v = shapeFor(f, changes[f].to);
    if (v === undefined) problems.push({ field: f, code: ERROR_CODES.VALIDATION_FAILED, message: `${f}: not a valid value` });
    else next[f] = v;
  }
  // 3b. statuses, transporters, appointment remark from their masters
  const statuses = await AppDataSource.getRepository(MasterShipmentStatus).findBy({ isActive: true });
  for (const f of fields.filter((x) => STATUS_FIELD_STAGE[x] && next[x] !== null && next[x] !== undefined)) {
    const ok = statuses.find((s) => s.stage === STATUS_FIELD_STAGE[f] && matchKey(s.value) === matchKey(String(next[f])));
    if (!ok) problems.push({ field: f, code: ERROR_CODES.VALIDATION_FAILED, message: `${f}: "${next[f]}" is not a ${STATUS_FIELD_STAGE[f]} status` });
    else next[f] = ok.value;
  }
  const partners = codeIndex(await AppDataSource.getRepository(MasterCourierPartner).findBy({ isActive: true }));
  const links: Record<string, number | null> = {};
  for (const f of fields.filter((x) => TRANSPORTER_FIELD_LINK[x])) {
    if (next[f] === null) { links[TRANSPORTER_FIELD_LINK[f]] = null; continue; }
    const p = partners.find(String(next[f]));
    if (!p) problems.push({ field: f, code: ERROR_CODES.VALIDATION_FAILED, message: `${f}: "${next[f]}" is not in the courier partner master` });
    else { next[f] = p.code; links[TRANSPORTER_FIELD_LINK[f]] = p.id; }
  }
  let appointmentRemark: string | undefined;
  if (fields.includes(APPOINTMENT_FIELD) && next[APPOINTMENT_FIELD] !== null) {
    const remarks = await AppDataSource.getRepository(MasterAppointmentRemark).findBy({ list: REMARK_LIST.APPOINTMENT_CHANGE, isActive: true });
    const found = remarks.find((r) => matchKey(r.remark) === matchKey(remark));
    if (!found) throw appError(ERROR_CODES.APPOINTMENT_REMARK_REQUIRED);
    appointmentRemark = found.remark;
  }
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);

  const logIds: string[] = [];
  await AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(MasterPurchaseOrder);
    const po = await repo.findOne({ where: { uid }, lock: { mode: 'pessimistic_write' } });
    if (!po) throw appError(ERROR_CODES.SHIPMENT_NOT_FOUND, uid);
    // 2. this shipment
    if (!canEditShipment(a, po.facilityId)) throw appError(ERROR_CODES.SHIPMENT_NOT_EDITABLE, uid);

    // 4. nobody changed it meanwhile
    const row = po as unknown as Record<string, unknown>;
    const conflicts = fields.filter((f) => !same(storedShape(f, row[f]), shapeFor(f, changes[f].from) ?? null));
    if (conflicts.length) {
      const last = (await m.query(
        `SELECT l.field_name field, u.name, l.created_at at FROM ${TABLES.SHIPMENT_LOGS} l LEFT JOIN ${TABLES.USERS} u ON u.id = l.user_id
          WHERE l.shipment_uid = ? AND l.field_name IN (?) ORDER BY l.id DESC`,
        [uid, conflicts],
      )) as { field: string; name: string | null; at: Date }[];
      const details: ConflictDetail[] = conflicts.map((f) => {
        const l = last.find((x) => x.field === f);
        return { field: f, now: storedShape(f, row[f]), by: l?.name ?? null, at: l?.at ? new Date(l.at).toISOString() : null };
      });
      throw appError(ERROR_CODES.FIELDS_CHANGED_MEANWHILE, conflicts.length).withDetails(details);
    }

    const changed = fields.filter((f) => !same(storedShape(f, row[f]), next[f]));
    if (!changed.length) return;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const f of changed) set[f] = next[f];
    for (const [link, id] of Object.entries(links)) set[link] = id;
    if (changed.includes(APPOINTMENT_FIELD) && next[APPOINTMENT_FIELD] !== null) {
      // As PEPIMS: every appointment date and its remark are kept in order; the current one is the last.
      set.allAppointmentDate = [...(po.allAppointmentDate ?? []), String(next[APPOINTMENT_FIELD])];
      set.appointmentRemarks = [...(po.appointmentRemarks ?? []), appointmentRemark ?? ''];
    }
    await repo.update(uid, set as never);

    const batchId = randomUUID();
    const logs = m.getRepository(ShipmentLog);
    for (const f of changed) {
      const saved = await logs.save(logs.create({
        shipmentUid: uid,
        userId: user.id,
        action: SHIPMENT_LOG_ACTION.FIELD_CHANGED,
        source: SHIPMENT_LOG_SOURCE.SCREEN,
        fieldName: f,
        oldValue: storedShape(f, row[f]) === null ? null : String(storedShape(f, row[f])),
        newValue: next[f] === null ? null : String(next[f]),
        remark: f === APPOINTMENT_FIELD ? appointmentRemark ?? null : remark?.trim() || null,
        batchId,
      }));
      logIds.push(saved.id);
    }
  });
  void flushChanges();
  return { logIds };
};

export interface HistoryItem {
  id: string;
  at: string;
  by: string | null;
  /** The person's email (to tell apart people with the same name). */
  byEmail: string | null;
  /** The person's team now (planning, warehouse...), null for people without one. */
  byTeam: string | null;
  action: string;
  source: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  remark: string | null;
  /** The rows of one save share it (the screen shows them as one entry). */
  batchId: string | null;
  /** True when the field is in a group hidden from this person: the change is listed, its values are not. */
  valueHidden: boolean;
}

/**
 * A shipment's history, newest first (at most 200): EVERY change by every team (user, 2026-10-14: "all the logs on that
 * row from planning, warehouse and all others"). Fields of groups hidden from the person stay listed (who, when, which
 * field) but without their old / new values, so hidden columns stay hidden.
 */
export const shipmentHistory = async (uid: string, hidden: Set<string>): Promise<HistoryItem[]> => {
  const rows = (await AppDataSource.query(
    `SELECT l.id, l.created_at at, u.name, u.email, u.po_team, l.action, l.source, l.field_name field, l.old_value, l.new_value, l.remark, l.batch_id
       FROM ${TABLES.SHIPMENT_LOGS} l LEFT JOIN ${TABLES.USERS} u ON u.id = l.user_id
      WHERE l.shipment_uid = ? ORDER BY l.id DESC LIMIT 200`,
    [uid],
  )) as { id: string | number; at: Date; name: string | null; email: string | null; po_team: string | null; action: string; source: string; field: string | null; old_value: string | null; new_value: string | null; remark: string | null; batch_id: string | null }[];
  return rows.map((r) => {
    const valueHidden = !!r.field && hidden.has(r.field);
    return {
      id: String(r.id), at: new Date(r.at).toISOString(), by: r.name, byEmail: r.email, byTeam: r.po_team, action: r.action, source: r.source,
      field: r.field, oldValue: valueHidden ? null : r.old_value, newValue: valueHidden ? null : r.new_value, remark: r.remark, batchId: r.batch_id, valueHidden,
    };
  });
};

/** Dropdown lists of the edit form. */
export const editOptions = async () => {
  const [statuses, partners, remarks] = await Promise.all([
    AppDataSource.getRepository(MasterShipmentStatus).find({ where: { isActive: true }, order: { stage: 'ASC', sortOrder: 'ASC' } }),
    AppDataSource.getRepository(MasterCourierPartner).find({ select: ['code'], where: { isActive: true }, order: { code: 'ASC' } }),
    AppDataSource.getRepository(MasterAppointmentRemark).find({ where: { list: REMARK_LIST.APPOINTMENT_CHANGE, isActive: true }, order: { sortOrder: 'ASC', remark: 'ASC' } }),
  ]);
  const ofStage = (s: string) => statuses.filter((x) => x.stage === s).map((x) => x.value);
  return {
    statuses: { planning: ofStage('planning'), warehouse: ofStage('warehouse'), logistics: ofStage('logistics') },
    transporters: partners.map((p) => p.code),
    appointmentRemarks: remarks.map((r) => ({ remark: r.remark, category: r.category })),
    statusActive: (meta().findColumnWithPropertyName('statusActive')?.enum ?? []).map(String),
    statusFields: STATUS_FIELD_STAGE,
    transporterFields: Object.keys(TRANSPORTER_FIELD_LINK),
    appointmentField: APPOINTMENT_FIELD,
  };
};
