import { randomUUID } from 'crypto';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  APPOINTMENT_ACTION,
  APPOINTMENT_CHANNELS,
  APPOINTMENT_FIELD,
  APPOINTMENT_OUTCOME,
  APPOINTMENT_SOURCE,
  APPOINTMENT_TEXT,
  APPOINTMENTS,
  AppointmentChannel,
  AppointmentOutcome,
  AppointmentSource,
  CHANNEL_MASTER_IDS,
  SHIPMENT_LOG_ACTION,
  SHIPMENT_LOG_SOURCE,
  TABLES,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { MasterChannel, MasterPurchaseOrder, PoAppointmentEmail, ShipmentLog } from '../../entities';
import { log } from '../../utils/logger';
import { flushChanges } from '../po-overview/po-overview.live';
import { bodyText, parseAppointmentEmail } from './appointment-parse';

/*
 * Appointment dates from email (2026-11-16, constants/appointments.ts). Each email is kept once (gmail_id) and applied
 * to the saved PO of its channel + PO number:
 *   - newest wins: the PO's last currentAppointmentDate change (shipment_logs) is compared by WHEN it happened (an
 *     email's received time, a person's save time); an older email is kept in the history only (outcome older);
 *   - created / rescheduled -> currentAppointmentDate = the date (+ PEPIMS's appointment lists), First Appointment
 *     Date (COPT) filled when empty; cancelled / un-scheduled -> currentAppointmentDate cleared;
 *   - every change = a shipment_logs row (source system, remark "Scootsy appointment email: ...") in the same
 *     transaction, so the PO's History and the live screens see it; the row's id is kept (log_id);
 *   - no saved PO yet -> waiting, tried again on every run for WAITING_DAYS (the PO may come later).
 * A person's edit needs no code here: their shipment_logs row is newer than the email's, so the date counts as typed.
 */

const emails = () => AppDataSource.getRepository(PoAppointmentEmail);

export interface InboundAppointmentEmail {
  gmailId: string;
  subject: string;
  receivedAt: Date;
  text?: string;
  html?: string;
}

const dayOf = (v: Date | string | null | undefined): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? (typeof v === 'string' ? v : null) : d.toISOString().slice(0, 10);
};

/** master_channels display names of the two channels (POs are saved with that name). */
const channelNames = async (): Promise<Map<AppointmentChannel, string>> => {
  const ids = (Object.keys(APPOINTMENT_CHANNELS) as AppointmentChannel[]).map((c) => [c, CHANNEL_MASTER_IDS[c]] as const);
  const rows = await AppDataSource.getRepository(MasterChannel).find({ select: ['id', 'displayName'], where: { id: In(ids.map(([, id]) => id)) } });
  return new Map(ids.flatMap(([c, id]) => {
    const r = rows.find((x) => Number(x.id) === id);
    return r ? [[c, r.displayName] as const] : [];
  }));
};

/** The saved POs (uid) of these PO numbers, per channel. */
const findPos = async (wanted: { channel: AppointmentChannel; poNumber: string }[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const names = await channelNames();
  const byName = new Map([...names].map(([c, n]) => [n.toLowerCase(), c]));
  const rows = (await AppDataSource.getRepository(MasterPurchaseOrder).createQueryBuilder('po')
    .select(['po.uid', 'po.channel', 'po.poNumber'])
    .where('po.poNumber IN (:...nos)', { nos: [...new Set(wanted.map((w) => w.poNumber))] })
    .andWhere('po.channel IN (:...names)', { names: [...names.values(), '-'] })
    .andWhere('po.transferCode IS NULL')
    .getMany());
  for (const r of rows) {
    const c = byName.get((r.channel ?? '').toLowerCase());
    if (c && r.poNumber) out.set(`${c}|${r.poNumber.toLowerCase()}`, r.uid);
  }
  return out;
};
const poKey = (channel: string, poNumber: string) => `${channel}|${poNumber.toLowerCase()}`;

/**
 * Applies one stored email to its PO (uid known). Returns the outcome; writes the PO, the History rows and the
 * email's row in one transaction.
 */
const applyToPo = async (row: PoAppointmentEmail, uid: string): Promise<AppointmentOutcome> => {
  const channel = APPOINTMENT_CHANNELS[row.channel as AppointmentChannel]?.label ?? row.channel ?? '';
  const outcome = await AppDataSource.transaction(async (m) => {
    const po = await m.getRepository(MasterPurchaseOrder).findOne({ where: { uid }, lock: { mode: 'pessimistic_write' } });
    if (!po) return APPOINTMENT_OUTCOME.WAITING;
    // newest wins: when did the PO's last appointment change happen (an email's received time, else the save time)
    type Last = { id: string | number; at: Date; email_at: Date | null };
    const [last] = await m.query<Last[]>(
      `SELECT l.id, l.created_at at, e.received_at email_at FROM ${TABLES.SHIPMENT_LOGS} l
        LEFT JOIN ${TABLES.PO_APPOINTMENT_EMAILS} e ON e.log_id = l.id
        WHERE l.shipment_uid = ? AND l.field_name = ? ORDER BY l.id DESC LIMIT 1`,
      [uid, APPOINTMENT_FIELD],
    );
    const lastAt = last ? new Date(last.email_at ?? last.at).getTime() : null;
    if (lastAt !== null && new Date(row.receivedAt).getTime() < lastAt) {
      await m.getRepository(PoAppointmentEmail).update(row.id, { outcome: APPOINTMENT_OUTCOME.OLDER, poUid: uid });
      return APPOINTMENT_OUTCOME.OLDER;
    }

    const cancelled = row.action === APPOINTMENT_ACTION.CANCELLED;
    const extra = [
      row.slot && !cancelled ? APPOINTMENT_TEXT.slot(row.slot) : '',
      row.appointmentRef ? APPOINTMENT_TEXT.ref(row.appointmentRef) : '',
      row.hub ? APPOINTMENT_TEXT.hub(row.hub) : '',
      cancelled ? `${row.appointmentDate}` : '',
      row.remarks ? row.remarks : '',
    ].filter(Boolean);
    const remark = APPOINTMENT_TEXT.remark(channel, (row.action ?? '').toUpperCase(), extra);
    const next = cancelled ? null : row.appointmentDate;
    const old = dayOf(po.currentAppointmentDate);
    const set: Record<string, unknown> = { currentAppointmentDate: next, updatedAt: new Date() };
    if (next) {
      // as PEPIMS (and a person's save): every appointment date and its remark kept in order
      set.allAppointmentDate = [...(po.allAppointmentDate ?? []), next];
      set.appointmentRemarks = [...(po.appointmentRemarks ?? []), remark];
    }
    const fillFirst = next && !po.firstAppointmentDateCOPT;
    if (fillFirst) set.firstAppointmentDateCOPT = next;
    await m.getRepository(MasterPurchaseOrder).update(uid, set);

    const logs = m.getRepository(ShipmentLog);
    const batchId = randomUUID();
    const entry = (fieldName: string, oldValue: string | null, newValue: string | null, text: string) => logs.create({
      shipmentUid: uid, userId: null, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: SHIPMENT_LOG_SOURCE.SYSTEM,
      fieldName, oldValue, newValue, remark: text, batchId,
    });
    if (fillFirst) await logs.save(entry('firstAppointmentDateCOPT', null, next, APPOINTMENT_TEXT.firstFilled(channel)));
    // written even when the date is the same (the email confirms it: the date now counts as "from email")
    const saved = await logs.save(entry(APPOINTMENT_FIELD, old, next, remark));
    await m.getRepository(PoAppointmentEmail).update(row.id, { outcome: APPOINTMENT_OUTCOME.APPLIED, poUid: uid, logId: saved.id, appliedAt: new Date() });
    return APPOINTMENT_OUTCOME.APPLIED;
  });
  if (outcome === APPOINTMENT_OUTCOME.APPLIED) {
    log.info(LOG_SOURCE.APP, `[appointments] ${channel} PO ${row.poNumber}: ${row.action} ${row.appointmentDate} applied`, { uid, gmailId: row.gmailId });
  }
  return outcome;
};

/**
 * One email from the label: stored once (a repeat = 'known'), then applied when its PO is saved. Emails must come
 * oldest first (the reader sorts them) so a later one wins.
 */
export const ingestAppointmentEmail = async (e: InboundAppointmentEmail): Promise<AppointmentOutcome | 'known'> => {
  if (await emails().exist({ where: { gmailId: e.gmailId } })) return 'known';
  const p = parseAppointmentEmail(e.subject, bodyText(e.text, e.html));
  const res = await emails().createQueryBuilder().insert().orIgnore().values({
    gmailId: e.gmailId,
    channel: p?.channel ?? null,
    poNumber: p?.poNumber ?? null,
    action: p?.action ?? null,
    appointmentDate: p?.appointmentDate ?? null,
    previousDate: p?.previousDate ?? null,
    slot: p?.slot ?? null,
    appointmentRef: p?.appointmentRef ?? null,
    hub: p?.hub ?? null,
    quantity: p?.quantity ?? null,
    remarks: p?.remarks ?? null,
    subject: e.subject.slice(0, APPOINTMENTS.TEXT_MAX),
    receivedAt: e.receivedAt,
    outcome: p ? APPOINTMENT_OUTCOME.WAITING : APPOINTMENT_OUTCOME.UNREADABLE,
  }).execute();
  if (!res.raw?.affectedRows) return 'known'; // another server stored it at the same moment
  if (!p) {
    log.warn(LOG_SOURCE.APP, `[appointments] email not in a known format, kept as unreadable: "${e.subject}"`, { gmailId: e.gmailId });
    return APPOINTMENT_OUTCOME.UNREADABLE;
  }
  const row = await emails().findOneByOrFail({ gmailId: e.gmailId });
  const uid = (await findPos([{ channel: p.channel, poNumber: p.poNumber }])).get(poKey(p.channel, p.poNumber));
  return uid ? applyToPo(row, uid) : APPOINTMENT_OUTCOME.WAITING;
};

/** Emails waiting for their PO: the ones whose PO is saved now are applied, oldest first. Returns how many. */
export const applyWaiting = async (): Promise<number> => {
  const since = new Date(Date.now() - APPOINTMENTS.WAITING_DAYS * 86_400_000);
  const rows = await emails().createQueryBuilder('e')
    .where('e.outcome = :w', { w: APPOINTMENT_OUTCOME.WAITING })
    .andWhere('e.received_at >= :since', { since })
    .orderBy('e.received_at', 'ASC').addOrderBy('e.id', 'ASC')
    .getMany();
  if (!rows.length) return 0;
  const pos = await findPos(rows.map((r) => ({ channel: r.channel as AppointmentChannel, poNumber: r.poNumber ?? '' })));
  let applied = 0;
  for (const r of rows) {
    const uid = pos.get(poKey(r.channel ?? '', r.poNumber ?? ''));
    if (uid && (await applyToPo(r, uid)) === APPOINTMENT_OUTCOME.APPLIED) applied++;
  }
  return applied;
};

/** Tells the live PO Overview screens (after a run that changed POs). */
export const announce = (): Promise<void> => flushChanges();

/*
 * Where a PO's appointment date came from. "From email" / "cancelled by email" = the PO's NEWEST currentAppointmentDate
 * change (shipment_logs) is the one an email wrote; anything else with a date = typed (a person, a CSV, PEPIMS).
 */
const lastLogSql = (po: string) =>
  `(SELECT MAX(sl.id) FROM ${TABLES.SHIPMENT_LOGS} sl WHERE sl.shipment_uid = ${po}.uid AND sl.field_name = '${APPOINTMENT_FIELD}')`;

/** SQL: the PO (alias `po`) got its appointment state from an email: cancelled (true) / a date (false) / either. */
export const fromEmailSql = (cancelled?: boolean, po = 'po'): string =>
  `EXISTS (SELECT 1 FROM ${TABLES.PO_APPOINTMENT_EMAILS} ae WHERE ae.log_id = ${lastLogSql(po)}${
    cancelled === undefined ? '' : ` AND ae.action ${cancelled ? '=' : '<>'} '${APPOINTMENT_ACTION.CANCELLED}'`})`;

/** Per shipment: 'email' / 'cancelled' when its newest appointment change came from an email (one query per page). */
export const emailSources = async (uids: string[]): Promise<Map<string, AppointmentSource>> => {
  if (!uids.length) return new Map();
  const rows = await AppDataSource.query<{ uid: string | number; action: string }[]>(
    `SELECT l.shipment_uid uid, e.action FROM (
       SELECT shipment_uid, MAX(id) mid FROM ${TABLES.SHIPMENT_LOGS} WHERE shipment_uid IN (?) AND field_name = ? GROUP BY shipment_uid
     ) l JOIN ${TABLES.PO_APPOINTMENT_EMAILS} e ON e.log_id = l.mid`,
    [uids, APPOINTMENT_FIELD],
  );
  return new Map(rows.map((r) => [String(r.uid), r.action === APPOINTMENT_ACTION.CANCELLED ? APPOINTMENT_SOURCE.CANCELLED : APPOINTMENT_SOURCE.EMAIL]));
};

export interface AppointmentHistoryItem {
  /** When it happened (email received / saved). */
  at: string;
  kind: 'email' | 'change';
  /** email: Scootsy / Zepto; change: the person (null = the app / a script). */
  by: string | null;
  byEmail: string | null;
  /** email: created / rescheduled / cancelled; change: set / cleared. */
  action: string;
  /** The appointment date it set (or cancelled). */
  date: string | null;
  /** change: the date before; email (Zepto reschedule / un-schedule): the old date. */
  previousDate: string | null;
  slot: string | null;
  appointmentRef: string | null;
  hub: string | null;
  quantity: number | null;
  remark: string | null;
  /** email: applied / older (not applied: a newer change exists) / waiting. */
  outcome: string | null;
  subject: string | null;
  /** This entry decides today's date (the newest applied change). */
  current: boolean;
}

/** One PO's appointment history, newest first: every email (applied or not) + every other change of the date. */
export const appointmentHistory = async (uid: string): Promise<AppointmentHistoryItem[]> => {
  const [mails, changes] = await Promise.all([
    emails().find({ where: { poUid: uid }, order: { receivedAt: 'DESC', id: 'DESC' } }),
    AppDataSource.query<{ id: string | number; at: Date; name: string | null; email: string | null; source: string; old_value: string | null; new_value: string | null; remark: string | null }[]>(
      `SELECT l.id, l.created_at at, u.name, u.email, l.source, l.old_value, l.new_value, l.remark FROM ${TABLES.SHIPMENT_LOGS} l
        LEFT JOIN ${TABLES.USERS} u ON u.id = l.user_id
        WHERE l.shipment_uid = ? AND l.field_name = ? ORDER BY l.id DESC LIMIT 200`,
      [uid, APPOINTMENT_FIELD],
    ),
  ]);
  const newestLog = changes[0] ? String(changes[0].id) : null;
  const emailLogs = new Set(mails.map((x) => x.logId).filter(Boolean) as string[]);
  const items: AppointmentHistoryItem[] = [
    ...mails.map((x): AppointmentHistoryItem => ({
      at: new Date(x.receivedAt).toISOString(),
      kind: 'email',
      by: APPOINTMENT_CHANNELS[x.channel as AppointmentChannel]?.label ?? x.channel,
      byEmail: null,
      action: x.action ?? '',
      date: dayOf(x.appointmentDate),
      previousDate: dayOf(x.previousDate),
      slot: x.slot,
      appointmentRef: x.appointmentRef,
      hub: x.hub,
      quantity: x.quantity,
      remark: x.remarks,
      outcome: x.outcome,
      subject: x.subject,
      current: !!x.logId && String(x.logId) === newestLog,
    })),
    ...changes.filter((c) => !emailLogs.has(String(c.id))).map((c): AppointmentHistoryItem => ({
      at: new Date(c.at).toISOString(),
      kind: 'change',
      by: c.name,
      byEmail: c.email,
      action: c.new_value ? 'set' : 'cleared',
      date: c.new_value,
      previousDate: c.old_value,
      slot: null,
      appointmentRef: null,
      hub: null,
      quantity: null,
      remark: c.remark,
      outcome: null,
      subject: null,
      current: String(c.id) === newestLog,
    })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at));
};

/** Every APPOINTMENT_SOURCE value except none (for the filter's checks). */
export const APPOINTMENT_SOURCES: readonly string[] = Object.values(APPOINTMENT_SOURCE);
