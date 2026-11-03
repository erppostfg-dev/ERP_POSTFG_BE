import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ERROR_CODES,
  IST_OFFSET_MS,
  MAIL_ADDRESS_MAX,
  MAIL_ADDRESS_PATTERN,
  MAIL_LIST_AUDIT_PREFIX,
  MAIL_LIST_HISTORY_LIMIT,
  MAIL_LISTS,
  MailListDef,
  RecipientKind,
  TABLES,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { ActivityLog, MailListSetting, MailRecipient } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import type { Actor } from '../admin/users.service';
import { Mail, sendMail } from './mailer.service';

/*
 * Mailing lists (2026-10-30, user: Users & Roles -> Email). Each mail the ERP sends (constants MAIL_LISTS) has its
 * recipients here: any email address, as To / CC / BCC, paused without being removed; a whole mail can be switched off.
 * Every change is one transaction plus an activity_log AUDIT row "mail-list:<key> ..." (the page's history), as the
 * Users page does. Senders call sendToList(key, mail); a mail that is off or has nobody active is not sent.
 */

export interface MailRecipientView {
  id: number;
  email: string;
  kind: RecipientKind;
  paused: boolean;
  addedBy: string | null;
  addedAt: Date;
  updatedAt: Date;
}

export interface MailListView extends MailListDef {
  enabled: boolean;
  recipients: MailRecipientView[];
}

export interface MailListChange {
  at: Date;
  by: string | null;
  what: string;
}

/** Who gets a mail now (active recipients of a mail that is on). */
export interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

const now = (): Date => new Date();

export const mailListOf = (key: string): MailListDef => {
  const def = MAIL_LISTS.find((l) => l.key === key);
  if (!def) throw appError(ERROR_CODES.MAIL_LIST_UNKNOWN, key);
  return def;
};

/** Lower case, trimmed; 400 when it is not an address. */
const normaliseAddress = (raw: string): string => {
  const email = raw.trim().toLowerCase();
  if (email.length > MAIL_ADDRESS_MAX || !MAIL_ADDRESS_PATTERN.test(email)) throw appError(ERROR_CODES.MAIL_ADDRESS_INVALID, raw.trim());
  return email;
};

const audit = (m: EntityManager, by: Pick<Actor, 'id'>, key: string, what: string) =>
  m.getRepository(ActivityLog).insert({
    userId: by.id,
    method: 'AUDIT',
    path: `${MAIL_LIST_AUDIT_PREFIX}${key} ${what}`.slice(0, 255),
    status: 200,
    durationMs: 0,
    createdOn: new Date(Date.now() + IST_OFFSET_MS),
  });

/** Every mail with its on / off state and recipients (To first, then CC, BCC; then by address). */
export const listMailLists = async (): Promise<MailListView[]> => {
  const settings = await AppDataSource.getRepository(MailListSetting).find();
  const rows = await AppDataSource.query<(Omit<MailRecipientView, 'paused'> & { listKey: string; paused: number | boolean })[]>(
    `SELECT r.id, r.list_key AS listKey, r.email, r.kind, r.paused, r.created_at AS addedAt, r.updated_at AS updatedAt,
            COALESCE(u.name, u.email) AS addedBy
       FROM ${TABLES.MAIL_RECIPIENTS} r LEFT JOIN ${TABLES.USERS} u ON u.id = r.created_by
      ORDER BY FIELD(r.kind, 'to', 'cc', 'bcc'), r.email`,
  );
  return MAIL_LISTS.map((def) => ({
    ...def,
    enabled: settings.find((s) => s.listKey === def.key)?.enabled ?? true,
    recipients: rows.filter((r) => r.listKey === def.key).map(({ listKey: _key, ...r }) => ({ ...r, paused: !!r.paused })),
  }));
};

export const setListEnabled = async (key: string, enabled: boolean, by: Actor): Promise<MailListView> => {
  const def = mailListOf(key);
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(MailListSetting).save({ listKey: key, enabled, updatedBy: by.id, updatedAt: now() });
    await audit(m, by, key, enabled ? 'switched on' : 'switched off');
  });
  log.info(LOG_SOURCE.APP, `[mail-lists] ${by.email}: "${def.name}" ${enabled ? 'on' : 'off'}`);
  return (await listMailLists()).find((l) => l.key === key) as MailListView;
};

export const addRecipient = async (key: string, input: { email: string; kind: RecipientKind }, by: Actor): Promise<MailListView> => {
  const def = mailListOf(key);
  const email = normaliseAddress(input.email);
  await AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(MailRecipient);
    if (await repo.findOne({ where: { listKey: key, email }, lock: { mode: 'pessimistic_write' } })) {
      throw appError(ERROR_CODES.MAIL_RECIPIENT_EXISTS, email, def.name);
    }
    await repo.insert({ listKey: key, email, kind: input.kind, paused: false, createdBy: by.id, createdAt: now(), updatedBy: by.id, updatedAt: now() });
    await audit(m, by, key, `added ${email} as ${input.kind.toUpperCase()}`);
  });
  log.info(LOG_SOURCE.APP, `[mail-lists] ${by.email}: added ${email} to "${def.name}"`);
  return (await listMailLists()).find((l) => l.key === key) as MailListView;
};

const recipientOf = async (m: EntityManager, key: string, id: number): Promise<MailRecipient> => {
  const r = await m.getRepository(MailRecipient).findOne({ where: { id, listKey: key }, lock: { mode: 'pessimistic_write' } });
  if (!r) throw appError(ERROR_CODES.MAIL_RECIPIENT_NOT_FOUND, String(id));
  return r;
};

export const updateRecipient = async (key: string, id: number, input: { kind?: RecipientKind; paused?: boolean }, by: Actor): Promise<MailListView> => {
  mailListOf(key);
  await AppDataSource.transaction(async (m) => {
    const r = await recipientOf(m, key, id);
    const changes: string[] = [];
    if (input.kind !== undefined && input.kind !== r.kind) changes.push(`${r.email} ${r.kind.toUpperCase()} -> ${input.kind.toUpperCase()}`);
    if (input.paused !== undefined && input.paused !== r.paused) changes.push(`${input.paused ? 'paused' : 'resumed'} ${r.email}`);
    if (!changes.length) return;
    await m.getRepository(MailRecipient).update({ id }, { ...(input.kind !== undefined ? { kind: input.kind } : {}), ...(input.paused !== undefined ? { paused: input.paused } : {}), updatedBy: by.id, updatedAt: now() });
    await audit(m, by, key, changes.join('; '));
  });
  return (await listMailLists()).find((l) => l.key === key) as MailListView;
};

export const removeRecipient = async (key: string, id: number, by: Actor): Promise<MailListView> => {
  mailListOf(key);
  await AppDataSource.transaction(async (m) => {
    const r = await recipientOf(m, key, id);
    await m.getRepository(MailRecipient).delete({ id });
    await audit(m, by, key, `removed ${r.email}`);
  });
  return (await listMailLists()).find((l) => l.key === key) as MailListView;
};

/** The changes of one mail, newest first: when, who, what. */
export const listHistory = async (key: string): Promise<MailListChange[]> => {
  mailListOf(key);
  const prefix = `${MAIL_LIST_AUDIT_PREFIX}${key} `;
  const rows = await AppDataSource.query<{ at: Date; by: string | null; path: string }[]>(
    `SELECT a.created_on AS at, COALESCE(u.name, u.email) AS \`by\`, a.path
       FROM ${TABLES.ACTIVITY_LOG} a LEFT JOIN ${TABLES.USERS} u ON u.id = a.user_id
      WHERE a.method = 'AUDIT' AND a.path LIKE ?
      ORDER BY a.id DESC LIMIT ${MAIL_LIST_HISTORY_LIMIT}`,
    [`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  );
  return rows.map((r) => ({ at: r.at, by: r.by, what: r.path.slice(prefix.length) }));
};

/** Active recipients of a mail; all empty when the mail is off. */
export const recipientsFor = async (key: string): Promise<Recipients> => {
  mailListOf(key);
  const out: Recipients = { to: [], cc: [], bcc: [] };
  const setting = await AppDataSource.getRepository(MailListSetting).findOneBy({ listKey: key });
  if (setting && !setting.enabled) return out;
  const rows = await AppDataSource.getRepository(MailRecipient).find({ where: { listKey: key, paused: false }, order: { email: 'ASC' } });
  for (const r of rows) out[r.kind].push(r.email);
  return out;
};

const hasAnyone = (r: Recipients): boolean => r.to.length + r.cc.length + r.bcc.length > 0;

/**
 * Send `mail` to the mail list `key` (its active To / CC / BCC). Returns who it went to, or null when nobody is
 * active (the mail is off, or everyone is paused) - nothing is sent then.
 */
export const sendToList = async (key: string, mail: Omit<Mail, 'to' | 'cc' | 'bcc'>): Promise<Recipients | null> => {
  const r = await recipientsFor(key);
  if (!hasAnyone(r)) return null;
  await sendMail({ ...mail, to: r.to, cc: r.cc, bcc: r.bcc });
  return r;
};

/**
 * A test of mail `key` (subject marked [Test]): to the signed-in person only, or to the mail's active recipients.
 * `sample` builds what the mail would hold now. 422 when the list has nobody active.
 */
export const sendTest = async (key: string, by: Actor, onlyMe: boolean, sample: () => Promise<Omit<Mail, 'to' | 'cc' | 'bcc'>>): Promise<Recipients> => {
  const def = mailListOf(key);
  const content = await sample();
  const mail = { ...content, subject: `[Test] ${content.subject}` };
  let sentTo: Recipients;
  if (onlyMe) {
    sentTo = { to: [by.email], cc: [], bcc: [] };
    await sendMail({ ...mail, to: by.email });
  } else {
    const r = await sendToList(key, mail);
    if (!r) throw appError(ERROR_CODES.MAIL_LIST_EMPTY, def.name);
    sentTo = r;
  }
  await AppDataSource.transaction((m) => audit(m, by, key, `test sent to ${[...sentTo.to, ...sentTo.cc, ...sentTo.bcc].join(', ')}`));
  return sentTo;
};

/**
 * Send mail `key` for real (e.g. the in-transit report of a build, from its Send mail button): to the list's active
 * recipients, noted in its history as `what`. 422 when the list has nobody active.
 */
export const sendNow = async (key: string, by: Pick<Actor, 'id'>, mail: Omit<Mail, 'to' | 'cc' | 'bcc'>, what: string): Promise<Recipients> => {
  const def = mailListOf(key);
  const r = await sendToList(key, mail);
  if (!r) throw appError(ERROR_CODES.MAIL_LIST_EMPTY, def.name);
  await AppDataSource.transaction((m) => audit(m, by, key, `sent ${what} to ${[...r.to, ...r.cc, ...r.bcc].join(', ')}`));
  return r;
};
