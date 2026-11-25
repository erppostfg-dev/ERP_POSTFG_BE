import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { BULK_NOTIFY, BULK_ORDERS_BODY_NOTIFY as F, NOTICES, USER_STATUS, USER_TEAM, type BulkNotifyEvent, type BulkNotifySettings } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { AppState, Notice, User, UserRole } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { log } from '../../utils/logger';
import { sendMail } from '../mail/mailer.service';
import { clearNoticeCache, noticeSettings } from '../notices/notices.service';
import { ERROR_CODES } from '../../constants/errors';

/*
 * Bulk order notifications (Bulk Orders Portal v2 piece 3, 2026-11-24; constants BULK_NOTIFY). User: "bell enough? ...
 * we have to put it somewhere about this email thing at one place so that we can switch on and off".
 *   - Bell: always (the existing notices, one row per person, sent "from" the person who acted; kept 2 days) unless
 *     notices are switched off for everyone.
 *   - Email: per event, switched in POST_FG Users & Roles > Settings > Bulk Orders > Notifications (app_state
 *     bulk-notify:settings; master switch + one per email event). Sent in the background: a mail problem never
 *     blocks or fails the order action (logged).
 * Who: approvers = active people with the role bulk-approver; our team = active people with team COPT in Users & Roles
 * (the "mixed list": changed there, no code); the requester = whoever created the order.
 */

export const readNotifySettings = async (): Promise<BulkNotifySettings> => {
  const row = await AppDataSource.getRepository(AppState).findOneBy({ key: BULK_NOTIFY.SETTINGS_KEY });
  return { ...BULK_NOTIFY.DEFAULTS, ...((row?.value ?? {}) as Partial<BulkNotifySettings>) };
};

/** { emails?, approvalNeeded?, decision?, remind? } booleans (admin, the route checks); returns the settings now. */
export const saveNotifySettings = async (body: Record<string, unknown>, by: number): Promise<BulkNotifySettings & { updatedBy: number }> => {
  const cur = await readNotifySettings();
  const next = { ...cur };
  const wrong: string[] = [];
  for (const k of F) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') wrong.push(k);
    else next[k] = body[k];
  }
  if (wrong.length || !F.some((k) => body[k] !== undefined)) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails((wrong.length ? wrong : [F[0]]).map((field) => ({ field, code: ERROR_CODES.VALIDATION_FAILED, message: `${field}: true or false (one of ${F.join(', ')})` })));
  }
  await AppDataSource.getRepository(AppState).save({ key: BULK_NOTIFY.SETTINGS_KEY, value: { ...next }, updatedAt: new Date() });
  log.info(LOG_SOURCE.API, `[bulk-orders] notification settings ${JSON.stringify(next)} by user ${by}`);
  return { ...next, updatedBy: by };
};

interface Person { id: number; email: string }

const active = (ids: number[]) => (ids.length
  ? AppDataSource.getRepository(User).find({ select: { id: true, email: true }, where: { id: In(ids), status: USER_STATUS.ACTIVE } })
  : Promise.resolve([] as User[]));

/** Who hears about an event (never the person who did it). */
const recipients = async (event: BulkNotifyEvent, requester: number, actor: number): Promise<Person[]> => {
  let people: Person[];
  if (event === 'approval_needed') {
    const roles = await AppDataSource.getRepository(UserRole).find({ select: { userId: true }, where: { role: BULK_NOTIFY.APPROVER_ROLE } });
    people = await active(roles.map((r) => r.userId));
  } else if (event === 'for_team' || event === 'remind') {
    people = await AppDataSource.getRepository(User).find({ select: { id: true, email: true }, where: { poTeam: USER_TEAM.COPT, status: USER_STATUS.ACTIVE } });
  } else {
    people = await active([requester]);
  }
  return people.filter((p) => p.id !== actor);
};

export interface NotifyOrder { id: string; poNumber: string; createdBy: number; orderType: string; totalUnits: number }

/**
 * Tells the right people about an order event: the bell now (awaited, cheap), the email in the background (if its
 * switch is on). Never throws: a problem is logged and the order action stands.
 */
export const notifyBulk = async (event: BulkNotifyEvent, o: NotifyOrder, actor: number, extra = ''): Promise<void> => {
  try {
    const people = await recipients(event, o.createdBy, actor);
    if (!people.length) return;
    const text = BULK_NOTIFY.TEXT[event](o.poNumber, o.totalUnits, extra).slice(0, NOTICES.TEXT_MAX);
    // our team works in POST_FG (a link to its Bulk Orders tab); portal people see the PO number in the text
    const link = event === 'for_team' || event === 'remind' ? BULK_NOTIFY.TEAM_LINK : null;
    if ((await noticeSettings()).enabled) {
      await AppDataSource.getRepository(Notice).insert(people.map((p) => ({ fromUserId: actor, toUserId: p.id, text, link, replyToId: null, replyQuote: null })));
      clearNoticeCache();
    }
    const s = await readNotifySettings();
    const mailKey = BULK_NOTIFY.EMAIL_SWITCH[event];
    if (s.emails && mailKey && s[mailKey]) {
      const url = link ? `${env.auth.frontendOrigin}${link}` : env.auth.bulkPortalUrl;
      void sendMail({
        to: people.map((p) => p.email), subject: BULK_NOTIFY.SUBJECT[event](o.poNumber),
        text: `${text}\n\n${url}`, html: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p><p><a href="${url}">${url}</a></p>`,
      }).catch((err) => logError(LOG_SOURCE.MAIL, `[bulk-orders] ${event} email for ${o.poNumber} not sent (the bell has it)`, err));
    }
  } catch (err) {
    logError(LOG_SOURCE.APP, `[bulk-orders] ${event} notification for ${o.poNumber} failed (the order action stands)`, err);
  }
};
