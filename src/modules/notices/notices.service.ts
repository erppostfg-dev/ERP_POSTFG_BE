import { In, LessThan, MoreThanOrEqual } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, NOTICE_TO_EVERYONE, NOTICES, USER_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { USER_ADMIN_ROLES } from '../../constants/users';
import { AppState, Notice, NoticeSeen, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';

/*
 * Notices (2026-11-10, constants/notices.ts): one-way notes in the top-bar bell, kept 2 days, no history.
 * LOAD (user: "don't increase the load on the server and the DB"):
 *   - a notice to everyone = ONE row; "seen" = one row per person (newest id seen), never one per notice;
 *   - the bell (GET /notices, every open app polls it) answers from a small in-memory snapshot: the active notices (last
 *     2 days), every person's seen id, the senders' names and the admin switch. The snapshot is re-read (4 small
 *     queries) at most every NOTICES.CACHE_MS for the whole server, and at once after a send / seen / switch change made
 *     on this server. A second server would see another server's send within CACHE_MS.
 *   - old notices are deleted on a send and at most once an hour on a refresh (one DELETE).
 */

export interface Actor { id: number; roles: string[] }
interface Person { id: number; name: string; email: string }

export interface NoticeView {
  id: string;
  from: Person;
  /** 'everyone', or the person it went to. */
  to: typeof NOTICE_TO_EVERYONE | Person;
  text: string;
  link: string | null;
  /** A reply: the start of the notice it answers. */
  replyQuote: string | null;
  /** I sent it (the "Sent" list); otherwise I received it. */
  sent: boolean;
  /** Received, sent to me alone: I may reply (to the sender only). */
  canReply: boolean;
  read: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface MyNotices {
  enabled: boolean;
  /** Admin / developer: may pick "Everyone". */
  canSendEveryone: boolean;
  unread: number;
  items: NoticeView[];
}

interface Snapshot {
  at: number;
  enabled: boolean;
  notices: Notice[];
  seen: Map<number, bigint>;
  people: Map<number, Person>;
}

let snap: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
let lastSweep = 0;

const keepFrom = (now = Date.now()) => new Date(now - NOTICES.KEEP_MS);
const isManager = (actor: Actor) => actor.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r));
const unknownPerson = (id: number): Person => ({ id, name: `User ${id}`, email: '' });
const bad = (field: string, message: string) => appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field, code: ERROR_CODES.VALIDATION_FAILED, message }]);

/** Forget the snapshot (the next bell re-reads it). Tests call this after resetting the DB. */
export const clearNoticeCache = (): void => {
  snap = null;
  loading = null;
};

const sweep = async (): Promise<void> => {
  const res = await AppDataSource.getRepository(Notice).delete({ createdAt: LessThan(keepFrom()) });
  lastSweep = Date.now();
  if (res.affected) log.info(LOG_SOURCE.APP, `[notices] deleted ${res.affected} notice(s) older than 2 days`);
};

const readSettings = async (): Promise<boolean> => {
  const row = await AppDataSource.getRepository(AppState).findOneBy({ key: NOTICES.SETTINGS_KEY });
  return row?.value?.enabled !== false;
};

const load = async (): Promise<Snapshot> => {
  if (Date.now() - lastSweep > 3_600_000) await sweep();
  const [enabled, notices, seenRows] = await Promise.all([
    readSettings(),
    AppDataSource.getRepository(Notice).find({ where: { createdAt: MoreThanOrEqual(keepFrom()) }, order: { id: 'DESC' } }),
    AppDataSource.getRepository(NoticeSeen).find(),
  ]);
  const ids = [...new Set(notices.flatMap((n) => (n.toUserId === null ? [n.fromUserId] : [n.fromUserId, n.toUserId])))];
  const users = ids.length ? await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { id: In(ids) } }) : [];
  return {
    at: Date.now(), enabled, notices,
    seen: new Map(seenRows.map((s) => [s.userId, BigInt(s.seenId)])),
    people: new Map(users.map((u) => [u.id, { id: u.id, name: u.name, email: u.email }])),
  };
};

/** The snapshot, re-read when older than CACHE_MS (one load at a time for all callers). */
const snapshot = async (): Promise<Snapshot> => {
  if (snap && Date.now() - snap.at < NOTICES.CACHE_MS) return snap;
  loading ??= load().then((s) => (snap = s)).finally(() => { loading = null; });
  return loading;
};

const forMe = (n: Notice, me: number) => n.fromUserId !== me && (n.toUserId === null || n.toUserId === me);

const view = (s: Snapshot, n: Notice, me: number): NoticeView => {
  const person = (id: number) => s.people.get(id) ?? unknownPerson(id);
  const seen = s.seen.get(me) ?? 0n;
  const sent = n.fromUserId === me;
  return {
    id: String(n.id), from: person(n.fromUserId), to: n.toUserId === null ? NOTICE_TO_EVERYONE : person(n.toUserId),
    text: n.text, link: n.link, replyQuote: n.replyQuote, sent,
    canReply: !sent && n.toUserId === me, read: sent || BigInt(n.id) <= seen,
    createdAt: n.createdAt.toISOString(), expiresAt: new Date(n.createdAt.getTime() + NOTICES.KEEP_MS).toISOString(),
  };
};

/** The bell: notices to me (or everyone) and the ones I sent, newest first; no DB query while the snapshot is fresh. */
export const myNotices = async (actor: Actor): Promise<MyNotices> => {
  const s = await snapshot();
  const base = { enabled: s.enabled, canSendEveryone: isManager(actor) };
  if (!s.enabled) return { ...base, unread: 0, items: [] };
  const mine = s.notices.filter((n) => n.createdAt >= keepFrom() && (forMe(n, actor.id) || n.fromUserId === actor.id)).slice(0, NOTICES.LIST_MAX);
  const items = mine.map((n) => view(s, n, actor.id));
  return { ...base, unread: items.filter((i) => !i.sent && !i.read).length, items };
};

/** Opened the bell: everything received up to now counts as read (one row per person). */
export const markNoticesSeen = async (actor: Actor): Promise<MyNotices> => {
  const s = await snapshot();
  const newest = s.notices.find((n) => forMe(n, actor.id));
  if (newest && BigInt(newest.id) > (s.seen.get(actor.id) ?? 0n)) {
    await AppDataSource.getRepository(NoticeSeen).upsert({ userId: actor.id, seenId: String(newest.id), updatedAt: new Date() }, ['userId']);
    s.seen.set(actor.id, BigInt(newest.id));
  }
  return myNotices(actor);
};

/** Active people to send to (not me), for the Send form: read only when the form opens. */
export const noticePeople = async (actor: Actor): Promise<Person[]> =>
  (await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { status: USER_STATUS.ACTIVE }, order: { name: 'ASC' } }))
    .filter((u) => u.id !== actor.id).map((u) => ({ id: u.id, name: u.name, email: u.email }));

/**
 * Sends one notice: { to: userId | 'everyone', text, link? } or a reply { replyToId, text, link? } (goes to that
 * notice's sender; only for a notice sent to me alone). 409 switched off, 403 everyone without admin / developer,
 * 429 more than PER_DAY in 24 hours, 400 bad fields / reply not allowed.
 */
export const sendNotice = async (body: Record<string, unknown>, actor: Actor): Promise<MyNotices> => {
  if (!(await readSettings())) throw appError(ERROR_CODES.NOTICES_OFF);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > NOTICES.TEXT_MAX) throw bad('text', `text must be 1 to ${NOTICES.TEXT_MAX} characters`);
  let link: string | null = null;
  if (body.link !== undefined && body.link !== null && body.link !== '') {
    link = typeof body.link === 'string' ? body.link.trim() : '';
    if (!/^\/(?!\/)\S*$/.test(link) || link.length > NOTICES.LINK_MAX) throw bad('link', `link must be a page of this app starting with "/" (at most ${NOTICES.LINK_MAX} characters)`);
  }

  const repo = AppDataSource.getRepository(Notice);
  let toUserId: number | null;
  let replyToId: string | null = null;
  let replyQuote: string | null = null;
  if (body.replyToId !== undefined) {
    const id = typeof body.replyToId === 'string' || typeof body.replyToId === 'number' ? String(body.replyToId) : '';
    if (!/^\d{1,18}$/.test(id)) throw bad('replyToId', 'replyToId must be a notice id');
    const original = await repo.findOneBy({ id, createdAt: MoreThanOrEqual(keepFrom()) });
    if (!original || original.toUserId !== actor.id || original.fromUserId === actor.id) throw appError(ERROR_CODES.NOTICE_REPLY_NOT_ALLOWED);
    toUserId = original.fromUserId;
    replyToId = String(original.id);
    replyQuote = original.text.slice(0, NOTICES.REPLY_QUOTE_MAX);
  } else if (body.to === NOTICE_TO_EVERYONE) {
    if (!isManager(actor)) throw appError(ERROR_CODES.NOTICE_EVERYONE_NOT_ALLOWED);
    toUserId = null;
  } else {
    const to = typeof body.to === 'number' ? body.to : typeof body.to === 'string' && /^\d{1,9}$/.test(body.to) ? Number(body.to) : NaN;
    if (!Number.isInteger(to) || to === actor.id) throw bad('to', `to must be another person's user id${isManager(actor) ? ` or "${NOTICE_TO_EVERYONE}"` : ''}`);
    const user = await AppDataSource.getRepository(User).findOne({ select: { id: true }, where: { id: to, status: USER_STATUS.ACTIVE } });
    if (!user) throw bad('to', 'that person is not an active user');
    toUserId = to;
  }

  const sentToday = await repo.countBy({ fromUserId: actor.id, createdAt: MoreThanOrEqual(new Date(Date.now() - 24 * 3600_000)) });
  if (sentToday >= NOTICES.PER_DAY) throw appError(ERROR_CODES.NOTICE_DAILY_LIMIT, NOTICES.PER_DAY);

  await repo.insert({ fromUserId: actor.id, toUserId, text, link, replyToId, replyQuote });
  await sweep();
  clearNoticeCache();
  return myNotices(actor);
};

export interface NoticeSettings { enabled: boolean }

/** Admin / developer (the route checks): the switch. */
export const noticeSettings = async (): Promise<NoticeSettings> => ({ enabled: await readSettings() });

export const saveNoticeSettings = async (body: Record<string, unknown>): Promise<NoticeSettings> => {
  if (typeof body.enabled !== 'boolean') throw bad('enabled', 'enabled must be true or false');
  await AppDataSource.getRepository(AppState).save({ key: NOTICES.SETTINGS_KEY, value: { enabled: body.enabled }, updatedAt: new Date() });
  clearNoticeCache();
  return { enabled: body.enabled };
};
