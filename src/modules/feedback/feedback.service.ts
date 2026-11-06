import { randomUUID } from 'crypto';
import { EntityManager, In, IsNull, LessThan, MoreThanOrEqual } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ERROR_CODES, FEEDBACK, FEEDBACK_COMMENT_KIND, FEEDBACK_IMAGE_TYPES, FEEDBACK_NOTIFY_KIND, FEEDBACK_SEVERITY, FEEDBACK_STATUS, FEEDBACK_TYPE,
  FeedbackCommentKind, FeedbackImageKind, FeedbackNotifyKind, FeedbackSeverity, FeedbackStatus, FeedbackType, USER_STATUS,
} from '../../constants';
import { USER_ADMIN_ROLES } from '../../constants/users';
import { FeedbackComment, FeedbackImage, FeedbackItem, FeedbackMember, FeedbackNotification, User } from '../../entities';
import { LOG_SOURCE } from '../../constants/logging';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { openS3File, s3UrlOfKey, writeS3File } from '../email-intake/s3-mirror.service';

/*
 * Feedback (2026-10-29, constants/feedback.ts). Everyone signed in sees every item, adds items (with up to
 * FEEDBACK.MAX_IMAGES images) and comments. Changing an item (fields, status, assignee, people, images) is for its
 * reporter, the person it is assigned to, the people added to it, and developer / admin (USER_ADMIN_ROLES). Every change writes a "change" line in the item's
 * timeline (feedback_comments kind change) in the same transaction. Nothing is deleted: images are hidden (removed_at,
 * the S3 file stays). Images go to S3 BEFORE the rows are written (a failed save leaves only an unused S3 file).
 */

export interface Actor { id: number; roles: string[] }

type Problem = { field: string; code: string; message: string };

const TYPE_LABEL: Record<FeedbackType, string> = { problem: 'Problem', improvement: 'Improvement', question: 'Question' };
const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: 'New', in_progress: 'Looking at it', planned: 'Planned', fixed: 'Fixed', wont_do: "Won't do", duplicate: 'Duplicate',
};
const SEVERITY_LABEL: Record<FeedbackSeverity, string> = { blocking: 'Blocking my work', annoying: 'Annoying', small: 'Small' };

const isManager = (actor: Actor): boolean => actor.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r));
const oneOf = <T extends string>(values: Record<string, T>, v: unknown): v is T => typeof v === 'string' && (Object.values(values) as string[]).includes(v);
const fail = (problems: Problem[]): void => {
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
};
const notOneOf = (field: string, values: Record<string, string>): Problem =>
  ({ field, code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `${field} must be one of: ${Object.values(values).join(', ')}` });
const required = (field: string, max: number): Problem => ({ field, code: ERROR_CODES.VALIDATION_FAILED, message: `${field} is required (at most ${max} characters)` });
/** Text that must be there, trimmed, at most `max` long; a problem otherwise. */
const text = (problems: Problem[], field: string, v: unknown, max: number): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > max) problems.push(required(field, max));
  return s;
};

// ---- images ----------------------------------------------------------------------------------------------------

export interface ImageFile { originalname: string; buffer: Buffer }

/** The image kind from the file's first bytes (PNG / JPEG / WEBP / GIF), or null. */
const imageKind = (b: Buffer): FeedbackImageKind | null => {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  return null;
};

/** Checks the images (type from the bytes, count with the ones already there), then puts them in S3. */
const storeImages = async (files: ImageFile[], already: number): Promise<{ s3Url: string; fileName: string; contentType: string; sizeBytes: number }[]> => {
  if (already + files.length > FEEDBACK.MAX_IMAGES) throw appError(ERROR_CODES.FEEDBACK_IMAGE_LIMIT, FEEDBACK.MAX_IMAGES, already);
  const kinds = files.map((f) => {
    const k = imageKind(f.buffer);
    if (!k) throw appError(ERROR_CODES.FEEDBACK_IMAGE_TYPE, f.originalname || 'file');
    return FEEDBACK_IMAGE_TYPES[k];
  });
  const now = new Date();
  const folder = `${FEEDBACK.S3_FOLDER}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const out = [];
  for (const [i, f] of files.entries()) {
    const s3Url = s3UrlOfKey(`${folder}/${randomUUID()}${kinds[i].ext}`);
    await writeS3File(s3Url, f.buffer);
    out.push({ s3Url, fileName: (f.originalname || `image${kinds[i].ext}`).slice(0, 255), contentType: kinds[i].contentType, sizeBytes: f.buffer.length });
  }
  return out;
};

// ---- reading ---------------------------------------------------------------------------------------------------

export interface FeedbackPerson { id: number; name: string; email: string }

export interface FeedbackListItem {
  id: string;
  type: FeedbackType;
  title: string;
  severity: FeedbackSeverity | null;
  status: FeedbackStatus;
  duplicateOfId: string | null;
  page: string | null;
  reporter: FeedbackPerson;
  /** The one person working on it; null = nobody yet. */
  assignedTo: FeedbackPerson | null;
  members: FeedbackPerson[];
  images: number;
  comments: number;
  createdAt: string;
  updatedAt: string;
  /** The person asking may change it (reporter, assignee, member, developer / admin). */
  canEdit: boolean;
}

export interface FeedbackDetail extends FeedbackListItem {
  description: string;
  context: Record<string, unknown> | null;
  updatedBy: FeedbackPerson | null;
  imageList: { id: string; fileName: string; contentType: string; sizeBytes: number; uploadedBy: FeedbackPerson; createdAt: string }[];
  timeline: { id: string; kind: FeedbackCommentKind; text: string; by: FeedbackPerson; createdAt: string }[];
}

export interface FeedbackListQuery { status?: string; type?: string; q?: string; mine?: boolean }

const peopleById = async (ids: number[]): Promise<Map<number, FeedbackPerson>> => {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const users = await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { id: In(unique) } });
  return new Map(users.map((u) => [u.id, { id: u.id, name: u.name, email: u.email }]));
};
const unknownPerson = (id: number): FeedbackPerson => ({ id, name: `User ${id}`, email: '' });

/** Checks the list filters (400 with every problem at once). */
export const listQueryOf = (raw: Record<string, unknown>): FeedbackListQuery => {
  const problems: Problem[] = [];
  const str = (k: string) => {
    const v = raw[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const status = str(FEEDBACK.QUERY.STATUS);
  const type = str(FEEDBACK.QUERY.TYPE);
  if (status !== undefined && !oneOf(FEEDBACK_STATUS, status)) problems.push(notOneOf(FEEDBACK.QUERY.STATUS, FEEDBACK_STATUS));
  if (type !== undefined && !oneOf(FEEDBACK_TYPE, type)) problems.push(notOneOf(FEEDBACK.QUERY.TYPE, FEEDBACK_TYPE));
  fail(problems);
  return { status, type, q: str(FEEDBACK.QUERY.Q)?.slice(0, 100), mine: raw[FEEDBACK.QUERY.MINE] === '1' };
};

/** Every item (newest first, at most FEEDBACK.LIST_MAX) with counts; 4 small queries whatever the number. */
export const listFeedback = async (query: FeedbackListQuery, actor: Actor): Promise<FeedbackListItem[]> => {
  const qb = AppDataSource.getRepository(FeedbackItem).createQueryBuilder('f')
    .select(['f.id', 'f.type', 'f.title', 'f.severity', 'f.status', 'f.duplicateOfId', 'f.page', 'f.reporterId', 'f.assignedTo', 'f.createdAt', 'f.updatedAt']);
  if (query.status) qb.andWhere('f.status = :status', { status: query.status });
  if (query.type) qb.andWhere('f.type = :type', { type: query.type });
  if (query.q) qb.andWhere('(f.title LIKE :q OR f.description LIKE :q)', { q: `%${query.q}%` });
  if (query.mine) {
    qb.andWhere(`(f.reporterId = :me OR f.assignedTo = :me OR f.id IN (SELECT m.item_id FROM ${AppDataSource.getMetadata(FeedbackMember).tableName} m WHERE m.user_id = :me))`, { me: actor.id });
  }
  const items = await qb.orderBy('f.id', 'DESC').take(FEEDBACK.LIST_MAX).getMany();
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const [members, imageCounts, commentCounts] = await Promise.all([
    AppDataSource.getRepository(FeedbackMember).find({ select: { itemId: true, userId: true }, where: { itemId: In(ids) } }),
    AppDataSource.getRepository(FeedbackImage).createQueryBuilder('i').select('i.itemId', 'itemId').addSelect('COUNT(*)', 'n')
      .where({ itemId: In(ids), removedAt: IsNull() }).groupBy('i.itemId').getRawMany<{ itemId: string; n: string }>(),
    AppDataSource.getRepository(FeedbackComment).createQueryBuilder('c').select('c.itemId', 'itemId').addSelect('COUNT(*)', 'n')
      .where({ itemId: In(ids), kind: FEEDBACK_COMMENT_KIND.COMMENT }).groupBy('c.itemId').getRawMany<{ itemId: string; n: string }>(),
  ]);
  const people = await peopleById([...items.flatMap((i) => (i.assignedTo ? [i.reporterId, i.assignedTo] : [i.reporterId])), ...members.map((m) => m.userId)]);
  const person = (id: number) => people.get(id) ?? unknownPerson(id);
  const count = (rows: { itemId: string; n: string }[], id: string) => Number(rows.find((r) => String(r.itemId) === String(id))?.n ?? 0);
  const manager = isManager(actor);
  return items.map((i) => {
    const mine = members.filter((m) => String(m.itemId) === String(i.id));
    return {
      id: String(i.id), type: i.type, title: i.title, severity: i.severity, status: i.status,
      duplicateOfId: i.duplicateOfId === null ? null : String(i.duplicateOfId), page: i.page,
      reporter: person(i.reporterId), assignedTo: i.assignedTo ? person(i.assignedTo) : null, members: mine.map((m) => person(m.userId)),
      images: count(imageCounts, i.id), comments: count(commentCounts, i.id),
      createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
      canEdit: manager || i.reporterId === actor.id || i.assignedTo === actor.id || mine.some((m) => m.userId === actor.id),
    };
  });
};

const findItem = async (id: string): Promise<FeedbackItem> => {
  const item = /^\d{1,18}$/.test(id) ? await AppDataSource.getRepository(FeedbackItem).findOneBy({ id }) : null;
  if (!item) throw appError(ERROR_CODES.FEEDBACK_NOT_FOUND, id);
  return item;
};

const memberIds = async (itemId: string): Promise<number[]> =>
  (await AppDataSource.getRepository(FeedbackMember).find({ select: { userId: true }, where: { itemId } })).map((m) => m.userId);

/** The item for a change: 404 when missing, 403 when the person may not change it. */
const itemToChange = async (id: string, actor: Actor): Promise<FeedbackItem> => {
  const item = await findItem(id);
  if (!isManager(actor) && item.reporterId !== actor.id && item.assignedTo !== actor.id && !(await memberIds(item.id)).includes(actor.id)) throw appError(ERROR_CODES.FEEDBACK_NOT_ALLOWED);
  return item;
};

export const getFeedback = async (id: string, actor: Actor): Promise<FeedbackDetail> => {
  const item = await findItem(id);
  const [members, images, timeline] = await Promise.all([
    AppDataSource.getRepository(FeedbackMember).find({ where: { itemId: item.id }, order: { createdAt: 'ASC' } }),
    AppDataSource.getRepository(FeedbackImage).find({ where: { itemId: item.id, removedAt: IsNull() }, order: { id: 'ASC' } }),
    AppDataSource.getRepository(FeedbackComment).find({ where: { itemId: item.id }, order: { id: 'ASC' } }),
  ]);
  const people = await peopleById([
    item.reporterId, ...(item.assignedTo ? [item.assignedTo] : []), ...(item.updatedBy ? [item.updatedBy] : []), ...members.map((m) => m.userId), ...images.map((i) => i.uploadedBy), ...timeline.map((t) => t.userId),
  ]);
  const person = (pid: number) => people.get(pid) ?? unknownPerson(pid);
  return {
    id: String(item.id), type: item.type, title: item.title, severity: item.severity, status: item.status,
    duplicateOfId: item.duplicateOfId === null ? null : String(item.duplicateOfId), page: item.page,
    reporter: person(item.reporterId), assignedTo: item.assignedTo ? person(item.assignedTo) : null, members: members.map((m) => person(m.userId)),
    images: images.length, comments: timeline.filter((t) => t.kind === FEEDBACK_COMMENT_KIND.COMMENT).length,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
    canEdit: isManager(actor) || item.reporterId === actor.id || item.assignedTo === actor.id || members.some((m) => m.userId === actor.id),
    description: item.description, context: item.context, updatedBy: item.updatedBy ? person(item.updatedBy) : null,
    imageList: images.map((i) => ({ id: String(i.id), fileName: i.fileName, contentType: i.contentType, sizeBytes: i.sizeBytes, uploadedBy: person(i.uploadedBy), createdAt: i.createdAt.toISOString() })),
    timeline: timeline.map((t) => ({ id: String(t.id), kind: t.kind, text: t.text, by: person(t.userId), createdAt: t.createdAt.toISOString() })),
  };
};

/** Active people, for "add people to this item". */
export const feedbackPeople = async (): Promise<FeedbackPerson[]> =>
  (await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { status: USER_STATUS.ACTIVE }, order: { name: 'ASC' } }))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));

/** One image's bytes from S3 (any signed-in person); hidden ones are gone for the screen. */
export const openFeedbackImage = async (id: string, imageId: string) => {
  const item = await findItem(id);
  const image = /^\d{1,18}$/.test(imageId) ? await AppDataSource.getRepository(FeedbackImage).findOneBy({ id: imageId, itemId: item.id, removedAt: IsNull() }) : null;
  const file = image ? await openS3File(image.s3Url) : undefined;
  if (!image || !file) throw appError(ERROR_CODES.FEEDBACK_IMAGE_NOT_FOUND, imageId);
  return { ...file, contentType: image.contentType, name: image.fileName };
};

// ---- writing ---------------------------------------------------------------------------------------------------

const changeLine = (itemId: string, userId: number, line: string): { itemId: string; userId: number; kind: FeedbackCommentKind; text: string } =>
  ({ itemId, userId, kind: FEEDBACK_COMMENT_KIND.CHANGE, text: line });

/**
 * Tells `userIds` (once each, never the actor) about something on an item, in the caller's transaction. Notifications
 * are not kept: every one older than 2 days (anyone's, read or not) is deleted here first. No timer (user 2026-11-06).
 */
const notify = async (m: EntityManager, itemId: string, kind: FeedbackNotifyKind, actor: Actor, userIds: number[], text = ''): Promise<void> => {
  const to = [...new Set(userIds)].filter((u) => u !== actor.id);
  if (!to.length) return;
  await clearOldNotifications(m);
  await m.getRepository(FeedbackNotification).insert(to.map((userId) => ({ userId, itemId, kind, actorId: actor.id, text: text.slice(0, FEEDBACK.NOTIFY_TEXT_MAX) })));
};

/** The captured details (page, browser, last error...): a JSON object of at most FEEDBACK.CONTEXT_MAX_BYTES, else null. */
const contextOf = (v: unknown): Record<string, unknown> | null => {
  let obj: unknown = v;
  if (typeof v === 'string') {
    try { obj = JSON.parse(v); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return Buffer.byteLength(JSON.stringify(obj)) <= FEEDBACK.CONTEXT_MAX_BYTES ? (obj as Record<string, unknown>) : null;
};

/** An active user by id (number or digits); 400 on `field` otherwise. */
const activeUser = async (raw: unknown, field = 'userId'): Promise<User> => {
  const uid = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  const user = Number.isInteger(uid) ? await AppDataSource.getRepository(User).findOneBy({ id: uid }) : null;
  if (!user || user.status !== USER_STATUS.ACTIVE) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field, code: ERROR_CODES.USER_ID_NOT_FOUND, message: `${field} must be an active user` }]);
  return user;
};

/** assignedToId in a body: undefined = not sent, null / '' = nobody, else an active user (400 otherwise). */
const assigneeOf = async (raw: unknown): Promise<User | null | undefined> =>
  raw === undefined ? undefined : raw === null || raw === '' ? null : activeUser(raw, FEEDBACK.FIELD_ASSIGNEE);

export const createFeedback = async (body: Record<string, unknown>, files: ImageFile[], actor: Actor): Promise<FeedbackDetail> => {
  const problems: Problem[] = [];
  const type = body.type;
  if (!oneOf(FEEDBACK_TYPE, type)) problems.push(notOneOf('type', FEEDBACK_TYPE));
  const title = text(problems, 'title', body.title, FEEDBACK.TITLE_MAX);
  const description = text(problems, 'description', body.description, FEEDBACK.TEXT_MAX);
  const rawSeverity = typeof body.severity === 'string' && body.severity ? body.severity : null;
  if (rawSeverity !== null && !oneOf(FEEDBACK_SEVERITY, rawSeverity)) problems.push(notOneOf('severity', FEEDBACK_SEVERITY));
  if (type === FEEDBACK_TYPE.PROBLEM && rawSeverity === null) problems.push({ field: 'severity', code: ERROR_CODES.VALIDATION_FAILED, message: 'severity is required for a problem' });
  fail(problems);
  const assignee = await assigneeOf(body[FEEDBACK.FIELD_ASSIGNEE]);
  const page = typeof body.page === 'string' && body.page.trim() ? body.page.trim().slice(0, FEEDBACK.PAGE_MAX) : null;
  const stored = await storeImages(files, 0);
  const id = await AppDataSource.transaction(async (m) => {
    const saved = await m.getRepository(FeedbackItem).save(m.getRepository(FeedbackItem).create({
      type: type as FeedbackType, title, description,
      severity: type === FEEDBACK_TYPE.PROBLEM ? (rawSeverity as FeedbackSeverity) : null,
      status: FEEDBACK_STATUS.NEW, page, context: contextOf(body.context), reporterId: actor.id, assignedTo: assignee?.id ?? null,
    }));
    if (assignee) {
      await m.getRepository(FeedbackComment).insert(changeLine(saved.id, actor.id, `Assigned to ${assignee.name}`));
      await notify(m, saved.id, FEEDBACK_NOTIFY_KIND.ASSIGNED, actor, [assignee.id]);
    }
    if (stored.length) await m.getRepository(FeedbackImage).insert(stored.map((s) => ({ ...s, itemId: saved.id, uploadedBy: actor.id })));
    return saved.id;
  });
  return getFeedback(String(id), actor);
};

/** Fields a person may change, all optional; every change gets a timeline line. */
export const updateFeedback = async (id: string, body: Record<string, unknown>, actor: Actor): Promise<FeedbackDetail> => {
  const item = await itemToChange(id, actor);
  const problems: Problem[] = [];
  const next: { title?: string; description?: string; type?: FeedbackType; severity?: FeedbackSeverity | null; status?: FeedbackStatus; duplicateOfId?: string | null; assignedTo?: number | null } = {};
  const lines: string[] = [];
  if (body.title !== undefined) {
    const t = text(problems, 'title', body.title, FEEDBACK.TITLE_MAX);
    if (t && t !== item.title) { next.title = t; lines.push(`Title: "${item.title}" → "${t}"`); }
  }
  if (body.description !== undefined) {
    const d = text(problems, 'description', body.description, FEEDBACK.TEXT_MAX);
    if (d && d !== item.description) { next.description = d; lines.push('Description edited'); }
  }
  const type = body.type === undefined ? item.type : body.type;
  if (!oneOf(FEEDBACK_TYPE, type)) problems.push(notOneOf('type', FEEDBACK_TYPE));
  else if (type !== item.type) { next.type = type; lines.push(`Type: ${TYPE_LABEL[item.type]} → ${TYPE_LABEL[type]}`); }
  if (body.severity !== undefined) {
    const s = body.severity === null || body.severity === '' ? null : body.severity;
    if (s !== null && !oneOf(FEEDBACK_SEVERITY, s)) problems.push(notOneOf('severity', FEEDBACK_SEVERITY));
    else if (s !== item.severity) { next.severity = s; lines.push(`How bad: ${item.severity ? SEVERITY_LABEL[item.severity] : '—'} → ${s ? SEVERITY_LABEL[s] : '—'}`); }
  }
  if (body.status !== undefined) {
    const st = body.status;
    if (!oneOf(FEEDBACK_STATUS, st)) problems.push(notOneOf('status', FEEDBACK_STATUS));
    else {
      if (st === FEEDBACK_STATUS.DUPLICATE) {
        const of = typeof body.duplicateOfId === 'string' || typeof body.duplicateOfId === 'number' ? String(body.duplicateOfId) : '';
        const target = /^\d{1,18}$/.test(of) && of !== String(item.id) ? await AppDataSource.getRepository(FeedbackItem).findOneBy({ id: of }) : null;
        if (!target) problems.push({ field: 'duplicateOfId', code: ERROR_CODES.VALIDATION_FAILED, message: 'duplicateOfId must be another existing item' });
        else if (String(target.id) !== String(item.duplicateOfId)) next.duplicateOfId = String(target.id);
      } else if (item.duplicateOfId !== null) next.duplicateOfId = null;
      if (st !== item.status || next.duplicateOfId !== undefined) {
        next.status = st;
        lines.push(`Status: ${STATUS_LABEL[item.status]} → ${STATUS_LABEL[st]}${st === FEEDBACK_STATUS.DUPLICATE && next.duplicateOfId ? ` of #${next.duplicateOfId}` : ''}`);
      }
    }
  }
  fail(problems);
  // after the other checks, so a bad assignee and bad fields are not half-reported
  const assignee = await assigneeOf(body[FEEDBACK.FIELD_ASSIGNEE]);
  if (assignee !== undefined && (assignee?.id ?? null) !== item.assignedTo) {
    next.assignedTo = assignee?.id ?? null;
    const was = item.assignedTo ? (await peopleById([item.assignedTo])).get(item.assignedTo)?.name ?? `User ${item.assignedTo}` : '—';
    lines.push(`Assigned to: ${was} → ${assignee?.name ?? '—'}`);
  }
  if (lines.length) {
    await AppDataSource.transaction(async (m) => {
      await m.getRepository(FeedbackItem).update({ id: item.id }, { ...next, updatedBy: actor.id });
      await m.getRepository(FeedbackComment).insert(lines.map((l) => changeLine(item.id, actor.id, l)));
      if (next.assignedTo) await notify(m, item.id, FEEDBACK_NOTIFY_KIND.ASSIGNED, actor, [next.assignedTo]);
    });
  }
  return getFeedback(String(item.id), actor);
};

/** A comment: anyone signed in. */
export const addComment = async (id: string, body: Record<string, unknown>, actor: Actor): Promise<FeedbackDetail> => {
  const item = await findItem(id);
  const problems: Problem[] = [];
  const t = text(problems, 'text', body.text, FEEDBACK.COMMENT_MAX);
  fail(problems);
  // told: the reporter, the assignee, the people on it and everyone who commented before
  const [members, commenters] = await Promise.all([
    memberIds(item.id),
    AppDataSource.getRepository(FeedbackComment).createQueryBuilder('c').select('DISTINCT c.userId', 'userId')
      .where({ itemId: item.id, kind: FEEDBACK_COMMENT_KIND.COMMENT }).getRawMany<{ userId: number }>(),
  ]);
  const followers = [item.reporterId, ...(item.assignedTo ? [item.assignedTo] : []), ...members, ...commenters.map((c) => Number(c.userId))];
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(FeedbackComment).insert({ itemId: item.id, userId: actor.id, kind: FEEDBACK_COMMENT_KIND.COMMENT, text: t });
    await notify(m, item.id, FEEDBACK_NOTIFY_KIND.COMMENT, actor, followers, t);
  });
  return getFeedback(String(item.id), actor);
};

export const addMember = async (id: string, body: Record<string, unknown>, actor: Actor): Promise<FeedbackDetail> => {
  const item = await itemToChange(id, actor);
  const user = await activeUser(body.userId);
  if (!(await memberIds(item.id)).includes(user.id)) {
    await AppDataSource.transaction(async (m) => {
      await m.getRepository(FeedbackMember).insert({ itemId: item.id, userId: user.id, addedBy: actor.id });
      await m.getRepository(FeedbackComment).insert(changeLine(item.id, actor.id, `Added ${user.name}`));
      await notify(m, item.id, FEEDBACK_NOTIFY_KIND.ADDED, actor, [user.id]);
    });
  }
  return getFeedback(String(item.id), actor);
};

export const removeMember = async (id: string, userId: string, actor: Actor): Promise<FeedbackDetail> => {
  const item = await itemToChange(id, actor);
  const uid = /^\d{1,9}$/.test(userId) ? Number(userId) : NaN;
  const row = Number.isInteger(uid) ? await AppDataSource.getRepository(FeedbackMember).findOneBy({ itemId: item.id, userId: uid }) : null;
  if (row) {
    const name = (await peopleById([uid])).get(uid)?.name ?? `User ${uid}`;
    await AppDataSource.transaction(async (m) => {
      await m.getRepository(FeedbackMember).delete({ itemId: item.id, userId: uid });
      await m.getRepository(FeedbackComment).insert(changeLine(item.id, actor.id, `Removed ${name}`));
    });
  }
  return getFeedback(String(item.id), actor);
};

export const addImages = async (id: string, files: ImageFile[], actor: Actor): Promise<FeedbackDetail> => {
  const item = await itemToChange(id, actor);
  if (!files.length) throw appError(ERROR_CODES.NO_FILES_UPLOADED);
  const have = await AppDataSource.getRepository(FeedbackImage).countBy({ itemId: item.id, removedAt: IsNull() });
  const stored = await storeImages(files, have);
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(FeedbackImage).insert(stored.map((s) => ({ ...s, itemId: item.id, uploadedBy: actor.id })));
    await m.getRepository(FeedbackComment).insert(changeLine(item.id, actor.id, `Added ${stored.length} image(s)`));
  });
  return getFeedback(String(item.id), actor);
};

/** Hides an image (the row and the S3 file stay). */
export const removeImage = async (id: string, imageId: string, actor: Actor): Promise<FeedbackDetail> => {
  const item = await itemToChange(id, actor);
  const image = /^\d{1,18}$/.test(imageId) ? await AppDataSource.getRepository(FeedbackImage).findOneBy({ id: imageId, itemId: item.id, removedAt: IsNull() }) : null;
  if (!image) throw appError(ERROR_CODES.FEEDBACK_IMAGE_NOT_FOUND, imageId);
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(FeedbackImage).update({ id: image.id }, { removedAt: new Date(), removedBy: actor.id });
    await m.getRepository(FeedbackComment).insert(changeLine(item.id, actor.id, `Removed image ${image.fileName}`));
  });
  return getFeedback(String(item.id), actor);
};

// ---- notifications (the top-bar bell) --------------------------------------------------------------------------

export interface FeedbackNotificationView {
  id: string;
  kind: FeedbackNotifyKind;
  itemId: string;
  itemTitle: string;
  by: FeedbackPerson;
  /** The comment (kind comment); '' otherwise. */
  text: string;
  read: boolean;
  createdAt: string;
}

export interface FeedbackNotifications { unread: number; items: FeedbackNotificationView[] }

/** Notifications from before this are gone (deleted when new ones are written; never shown meanwhile). */
const keepFrom = (now = new Date()): Date => new Date(now.getTime() - FEEDBACK.NOTIFY_KEEP_MS);

/** The person's newest notifications (2 days at most) and how many are unread. */
export const listNotifications = async (actor: Actor): Promise<FeedbackNotifications> => {
  const repo = AppDataSource.getRepository(FeedbackNotification);
  const [rows, unread] = await Promise.all([
    repo.find({ where: { userId: actor.id, createdAt: MoreThanOrEqual(keepFrom()) }, order: { id: 'DESC' }, take: FEEDBACK.NOTIFY_LIST_MAX }),
    repo.countBy({ userId: actor.id, readAt: IsNull(), createdAt: MoreThanOrEqual(keepFrom()) }),
  ]);
  if (!rows.length) return { unread, items: [] };
  const [items, people] = await Promise.all([
    AppDataSource.getRepository(FeedbackItem).find({ select: { id: true, title: true }, where: { id: In([...new Set(rows.map((r) => r.itemId))]) } }),
    peopleById(rows.map((r) => r.actorId)),
  ]);
  const titles = new Map(items.map((i) => [String(i.id), i.title]));
  return {
    unread,
    items: rows.map((r) => ({
      id: String(r.id), kind: r.kind, itemId: String(r.itemId), itemTitle: titles.get(String(r.itemId)) ?? '',
      by: people.get(r.actorId) ?? unknownPerson(r.actorId), text: r.text, read: r.readAt !== null, createdAt: r.createdAt.toISOString(),
    })),
  };
};

/**
 * Marks the person's own notifications read: { itemId } = every one about that item (they opened it), { ids } = those,
 * {} = all. Someone else's notifications are never touched. Answers the bell again.
 */
export const readNotifications = async (body: Record<string, unknown>, actor: Actor): Promise<FeedbackNotifications> => {
  const where: Record<string, unknown> = { userId: actor.id, readAt: IsNull() };
  if (body.itemId !== undefined) {
    const itemId = typeof body.itemId === 'string' || typeof body.itemId === 'number' ? String(body.itemId) : '';
    if (!/^\d{1,18}$/.test(itemId)) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'itemId', code: ERROR_CODES.VALIDATION_FAILED, message: 'itemId must be an item id' }]);
    where.itemId = itemId;
  } else if (body.ids !== undefined) {
    const ids = Array.isArray(body.ids) ? body.ids.map((i) => (typeof i === 'string' || typeof i === 'number' ? String(i) : '')) : [];
    if (!ids.length || ids.length > FEEDBACK.NOTIFY_LIST_MAX || !ids.every((i) => /^\d{1,18}$/.test(i))) {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'ids', code: ERROR_CODES.VALIDATION_FAILED, message: `ids must be 1 to ${FEEDBACK.NOTIFY_LIST_MAX} notification ids` }]);
    }
    where.id = In(ids);
  }
  await AppDataSource.getRepository(FeedbackNotification).update(where, { readAt: new Date() });
  return listNotifications(actor);
};

/** Deletes every notification older than FEEDBACK.NOTIFY_KEEP_MS (2 days), read or not. Answers how many went. */
export const clearOldNotifications = async (m: EntityManager = AppDataSource.manager, now = new Date()): Promise<number> => {
  const res = await m.getRepository(FeedbackNotification).delete({ createdAt: LessThan(keepFrom(now)) });
  const n = res.affected ?? 0;
  if (n) log.info(LOG_SOURCE.APP, `[feedback] deleted ${n} notification(s) older than 2 days`);
  return n;
};
