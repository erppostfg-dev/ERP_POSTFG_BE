import { In, Not } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { BULK_BODY as F, BULK_INSTITUTION, ERROR_CODES, errorMessage } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { BulkBuyerOrg, BulkBuyerOrgUser, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { BulkActor, Checker, isId } from './bulk-orders.service';
import { needSettingsAdmin } from './bulk-documents.service';

/*
 * Buyer organisations (2026-11-24, user "yes do this too"; PRD: Institutional buyers are outside organisations that see
 * their organisation's orders + their customer list). POST_FG admins (editor on /bulk-orders: admin / developer) create
 * one and set its people (by email; a person in one organisation only; the person must exist in Users & Roles with a
 * Bulk Orders role). Its people then see only its orders + customers (bulk-orders.service inOrg); our people (no
 * organisation) see everything. Nothing is deleted: switched off (active false) keeps its people scoped to it.
 */

const orgOut = (o: BulkBuyerOrg, members: { userId: number; email: string; name: string | null }[]) => ({
  id: String(o.id), name: o.name, active: o.isActive, createdAt: o.createdAt, updatedAt: o.updatedAt,
  members: members.map((m) => ({ userId: m.userId, email: m.email, name: m.name })),
});

/** Every organisation (A-Z) with its people: 3 queries. */
export const listBuyerOrgs = async (actor: BulkActor) => {
  await needSettingsAdmin(actor);
  const orgs = await AppDataSource.getRepository(BulkBuyerOrg).find({ order: { name: 'ASC' } });
  const links = orgs.length ? await AppDataSource.getRepository(BulkBuyerOrgUser).find({ where: { orgId: In(orgs.map((o) => String(o.id))) } }) : [];
  const users = links.length ? await AppDataSource.getRepository(User).find({ select: { id: true, email: true, name: true }, where: { id: In(links.map((l) => l.userId)) } }) : [];
  return orgs.map((o) => orgOut(o, links.filter((l) => String(l.orgId) === String(o.id)).map((l) => {
    const u = users.find((x) => x.id === l.userId);
    return { userId: l.userId, email: u?.email ?? '', name: u?.name ?? null };
  })));
};

/** The people (emails) checked: each an existing user, not in another organisation. */
const checkEmails = async (c: Checker, raw: unknown, orgId: string | null): Promise<User[] | null> => {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string' || !BULK_INSTITUTION.EMAIL_RE.test(e.trim()))) {
    c.add(F.EMAILS, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.EMAILS, 'a list of email addresses'));
    return null;
  }
  const emails = [...new Set((raw as string[]).map((e) => e.trim().toLowerCase()))];
  const users = emails.length ? await AppDataSource.getRepository(User).find({ select: { id: true, email: true }, where: { email: In(emails) } }) : [];
  const missing = emails.filter((e) => !users.some((u) => u.email.toLowerCase() === e));
  if (missing.length) c.add(F.EMAILS, `Not in Users & Roles yet: ${missing.join(', ')} (add them there first, with a Bulk Orders role)`);
  const taken = users.length ? await AppDataSource.getRepository(BulkBuyerOrgUser).find({ where: { userId: In(users.map((u) => u.id)), ...(orgId ? { orgId: Not(orgId) } : {}) } }) : [];
  if (taken.length) {
    const other = await AppDataSource.getRepository(BulkBuyerOrg).findOneBy({ id: String(taken[0].orgId) });
    const who = users.find((u) => u.id === taken[0].userId)!;
    throw appError(ERROR_CODES.BULK_ORG_USER_TAKEN, who.email, other?.name ?? String(taken[0].orgId));
  }
  return users;
};

const setMembers = async (orgId: string, users: User[], by: number): Promise<void> => {
  await AppDataSource.transaction(async (m) => {
    await m.getRepository(BulkBuyerOrgUser).delete({ orgId });
    if (users.length) await m.getRepository(BulkBuyerOrgUser).insert(users.map((u) => ({ userId: u.id, orgId, addedBy: by })));
  });
};

const nameOf = (c: Checker, body: Record<string, unknown>, required: boolean): string => c.text(body[F.NAME], F.NAME, BULK_INSTITUTION.NAME_MAX, required);

/** { name, emails? } -> 201 the organisation; 409 BULK_ORG_EXISTS (same name, case ignored). */
export const addBuyerOrg = async (actor: BulkActor, body: Record<string, unknown>) => {
  await needSettingsAdmin(actor);
  const c = new Checker();
  const name = nameOf(c, body, true);
  const users = await checkEmails(c, body[F.EMAILS], null);
  c.fail();
  const repo = AppDataSource.getRepository(BulkBuyerOrg);
  if (await repo.createQueryBuilder('o').where('LOWER(o.name) = LOWER(:n)', { n: name }).getCount()) throw appError(ERROR_CODES.BULK_ORG_EXISTS, name);
  const res = await repo.insert({ name, createdBy: actor.id });
  const id = String(res.identifiers[0].id);
  if (users?.length) await setMembers(id, users, actor.id);
  log.info(LOG_SOURCE.API, `[bulk-orders] buyer organisation ${id} "${name}" added (${users?.length ?? 0} people) by user ${actor.id}`);
  return (await listBuyerOrgs(actor)).find((o) => o.id === id)!;
};

/** { name?, active?, emails? (the WHOLE list of its people) } -> the organisation. */
export const updateBuyerOrg = async (actor: BulkActor, orgId: string, body: Record<string, unknown>) => {
  await needSettingsAdmin(actor);
  const repo = AppDataSource.getRepository(BulkBuyerOrg);
  const cur = isId(orgId) ? await repo.findOneBy({ id: orgId }) : null;
  if (!cur) throw appError(ERROR_CODES.BULK_ORG_NOT_FOUND, String(orgId));
  const c = new Checker();
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const name = has(F.NAME) ? nameOf(c, body, true) : cur.name;
  const a = body[F.ACTIVE];
  if (a !== undefined && typeof a !== 'boolean') c.add(F.ACTIVE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.ACTIVE, 'true or false'));
  const users = await checkEmails(c, body[F.EMAILS], String(cur.id));
  if (!has(F.NAME) && a === undefined && users === null) c.add(F.NAME, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.NAME, `${F.NAME}, ${F.ACTIVE} and / or ${F.EMAILS}`));
  c.fail();
  if (name.toLowerCase() !== cur.name.toLowerCase() && await repo.createQueryBuilder('o').where('LOWER(o.name) = LOWER(:n) AND o.id <> :id', { n: name, id: cur.id }).getCount()) {
    throw appError(ERROR_CODES.BULK_ORG_EXISTS, name);
  }
  await repo.update({ id: String(cur.id) }, { name, ...(typeof a === 'boolean' ? { isActive: a } : {}), updatedAt: new Date() });
  if (users) await setMembers(String(cur.id), users, actor.id);
  log.info(LOG_SOURCE.API, `[bulk-orders] buyer organisation ${orgId} changed by user ${actor.id}`);
  return (await listBuyerOrgs(actor)).find((o) => o.id === String(cur.id))!;
};
