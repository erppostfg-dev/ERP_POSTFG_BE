import { EntityManager, In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  ACCESS_LEVEL,
  ERROR_CODES,
  FACILITY_SCOPED_TEAMS,
  IST_OFFSET_MS,
  PAGES,
  PO_TEAM_LABEL,
  TABLES,
  USER_ADMIN_ROLES,
  USER_STATUS,
  USER_TEAM,
  UserStatus,
  UserTeam,
  WELCOME_EMAIL,
} from '../../constants';
import { ActivityLog, MasterFacility, Role, User, UserFacility, UserRole } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { resolveAllAccess } from '../auth/access.service';
import { sendMail } from '../mail/mailer.service';

/*
 * Users page (2026-10-15, user): admins / developers add a person with a role (which routes they may open / edit), a
 * PO Overview team and facilities; the person gets a welcome email and signs in with Google. People are switched
 * off, never deleted. Every change is one transaction plus an activity_log row saying what changed (method AUDIT).
 * Welcome email: tried at once, then again after 30 s and 2 min (self-healing); a missing Gmail send permission is
 * not retried (it needs `npm run gmail:token`); the page's Resend button tries again any time.
 */

export interface Actor {
  id: number;
  email: string;
  roles: string[];
}

export interface UserInput {
  email?: string;
  name?: string;
  roles?: string[];
  team?: UserTeam | null;
  facilities?: string[];
  status?: UserStatus;
  sendEmail?: boolean;
}

export interface UserItem {
  id: number;
  name: string;
  email: string;
  status: UserStatus;
  roles: string[];
  team: UserTeam | null;
  facilities: string[];
  addedBy: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  welcomeSentAt: string | null;
  welcomeError: string | null;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const TEAM_LABEL: Record<UserTeam, string> = { ...PO_TEAM_LABEL, [USER_TEAM.VIEWER]: 'Viewer' };

/** "ravi.kumar@mcaffeine.com" -> "Ravi Kumar". */
export const nameFromEmail = (email: string): string =>
  email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export const listUsers = async (): Promise<UserItem[]> => {
  const rows = (await AppDataSource.query(
    `SELECT u.id, u.name, u.email, u.status, u.po_team, u.created_at, u.welcome_sent_at, u.welcome_error, a.name added_by,
            (SELECT GROUP_CONCAT(r.role ORDER BY r.role) FROM ${TABLES.USER_ROLES} r WHERE r.user_id = u.id) roles,
            (SELECT GROUP_CONCAT(f.code ORDER BY f.code SEPARATOR ',') FROM ${TABLES.USER_FACILITIES} uf
               JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = uf.facility_id WHERE uf.user_id = u.id) facilities,
            (SELECT MAX(s.created_at) FROM ${TABLES.SESSIONS} s WHERE s.user_id = u.id) last_login
       FROM ${TABLES.USERS} u LEFT JOIN ${TABLES.USERS} a ON a.id = u.added_by
      ORDER BY u.name`,
  )) as {
    id: number; name: string; email: string; status: UserStatus | null; po_team: UserTeam | null; created_at: Date | null; welcome_sent_at: Date | null;
    welcome_error: string | null; added_by: string | null; roles: string | null; facilities: string | null; last_login: Date | null;
  }[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    email: r.email,
    status: r.status ?? USER_STATUS.ACTIVE, // NULL counts as active (prefg)
    roles: r.roles ? r.roles.split(',') : [],
    team: r.po_team,
    facilities: r.facilities ? r.facilities.split(',') : [],
    addedBy: r.added_by,
    createdAt: iso(r.created_at),
    lastLoginAt: iso(r.last_login),
    welcomeSentAt: iso(r.welcome_sent_at),
    welcomeError: r.welcome_error,
  }));
};

/** Dropdowns of the add / edit form. */
export const userOptions = async () => {
  const [roles, facilities] = await Promise.all([
    AppDataSource.getRepository(Role).find({ order: { isSystem: 'DESC', label: 'ASC' } }),
    AppDataSource.getRepository(MasterFacility).find({ select: ['code', 'name'], where: { isActive: true }, order: { code: 'ASC' } }),
  ]);
  return {
    roles: roles.map((r) => ({ key: r.key, label: r.label, description: r.description, isSystem: r.isSystem })),
    teams: (Object.values(USER_TEAM) as UserTeam[]).map((key) => ({ key, label: TEAM_LABEL[key] })),
    facilityScopedTeams: FACILITY_SCOPED_TEAMS,
    facilities: facilities.map((f) => ({ code: f.code, name: f.name })),
    emailDomain: env.auth.allowedEmailDomain,
  };
};

const audit = (m: EntityManager, by: Actor, what: string) =>
  m.getRepository(ActivityLog).insert({
    userId: by.id,
    method: 'AUDIT',
    path: what.slice(0, 255),
    status: 200,
    durationMs: 0,
    createdOn: new Date(Date.now() + IST_OFFSET_MS),
  });

/** The roles must exist; facility codes must exist and be active (exact, case-sensitive). */
const checkRolesAndFacilities = async (m: EntityManager, roles?: string[], codes?: string[]) => {
  if (roles?.length) {
    const found = await m.getRepository(Role).findBy({ key: In(roles) });
    const missing = roles.filter((r) => !found.some((f) => f.key === r));
    if (missing.length) throw appError(ERROR_CODES.ROLE_NOT_FOUND, missing.join(', '));
  }
  if (!codes) return undefined;
  const found = codes.length ? await m.getRepository(MasterFacility).findBy({ code: In(codes), isActive: true }) : [];
  const missing = codes.filter((c) => !found.some((f) => f.code === c));
  if (missing.length) throw appError(ERROR_CODES.FACILITY_NOT_FOUND, missing.join(', '));
  return found;
};

const setRoles = async (m: EntityManager, userId: number, roles: string[]) => {
  const repo = m.getRepository(UserRole);
  await repo.delete({ userId });
  if (roles.length) await repo.insert(roles.map((role) => ({ userId, role })));
};

const setFacilities = async (m: EntityManager, userId: number, found: MasterFacility[]) => {
  const repo = m.getRepository(UserFacility);
  await repo.delete({ userId });
  if (found.length) await repo.insert(found.map((f) => ({ userId, facilityId: f.id })));
};

export const createUser = async (input: UserInput, by: Actor): Promise<UserItem> => {
  const email = input.email!.trim().toLowerCase();
  if (!email.endsWith(`@${env.auth.allowedEmailDomain}`)) throw appError(ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED, env.auth.allowedEmailDomain);
  let id = 0;
  await AppDataSource.transaction(async (m) => {
    const users = m.getRepository(User);
    if (await users.findOneBy({ email })) throw appError(ERROR_CODES.USER_EXISTS, email);
    const found = await checkRolesAndFacilities(m, input.roles ?? [], input.facilities ?? []);
    const user = await users.save(
      users.create({ email, name: input.name?.trim() || nameFromEmail(email), status: USER_STATUS.ACTIVE, poTeam: input.team ?? null, addedBy: by.id }),
    );
    id = user.id;
    await setRoles(m, id, input.roles ?? []);
    await setFacilities(m, id, found ?? []);
    await audit(m, by, `users: added ${email} roles=${(input.roles ?? []).join('+') || '-'} team=${input.team ?? '-'} facilities=${(input.facilities ?? []).join('+') || '-'}`);
  });
  console.log(`[users] ${by.email} added ${email}`);
  if (input.sendEmail !== false) scheduleWelcome(id);
  return (await listUsers()).find((u) => u.id === id)!;
};

export const updateUser = async (id: number, input: UserInput, by: Actor): Promise<UserItem> => {
  const changes: string[] = [];
  await AppDataSource.transaction(async (m) => {
    const users = m.getRepository(User);
    const user = await users.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!user) throw appError(ERROR_CODES.USER_ID_NOT_FOUND, String(id));
    // Nobody locks themselves out: no switching yourself off, no dropping your own admin / developer role.
    if (id === by.id) {
      const keepsAdmin = !input.roles || input.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r));
      if (input.status === USER_STATUS.INACTIVE || !keepsAdmin) throw appError(ERROR_CODES.CANNOT_CHANGE_OWN_ACCESS);
    }
    const found = await checkRolesAndFacilities(m, input.roles, input.facilities);
    const set: Partial<User> = {};
    if (input.name !== undefined && input.name.trim() && input.name.trim() !== user.name) { set.name = input.name.trim(); changes.push(`name=${set.name}`); }
    if (input.team !== undefined && input.team !== user.poTeam) { set.poTeam = input.team; changes.push(`team=${input.team ?? '-'}`); }
    if (input.status !== undefined && input.status !== (user.status ?? USER_STATUS.ACTIVE)) { set.status = input.status; changes.push(`status=${input.status}`); }
    if (Object.keys(set).length) await users.update(id, set);
    if (input.roles) { await setRoles(m, id, input.roles); changes.push(`roles=${input.roles.join('+') || '-'}`); }
    if (found) { await setFacilities(m, id, found); changes.push(`facilities=${input.facilities!.join('+') || '-'}`); }
    if (changes.length) await audit(m, by, `users: changed ${user.email} ${changes.join(' ')}`);
  });
  if (changes.length) console.log(`[users] ${by.email} changed user ${id}: ${changes.join(' ')}`);
  const item = (await listUsers()).find((u) => u.id === id);
  if (!item) throw appError(ERROR_CODES.USER_ID_NOT_FOUND, String(id));
  return item;
};

// ---- Welcome email ----------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Builds the email from what the person can do now (roles -> pages, team, facilities). */
const welcomeMail = async (user: UserItem) => {
  const [roles, access, adder] = await Promise.all([
    AppDataSource.getRepository(Role).findBy({ key: In(user.roles.length ? user.roles : ['']) }),
    resolveAllAccess(user.id, user.roles),
    user.addedBy,
  ]);
  const roleText = roles.map((r) => r.label).join(', ') || 'no role yet';
  const pages = PAGES.filter((p) => p.slug.split('/').length > 2 || !PAGES.some((c) => c.slug.startsWith(`${p.slug}/`)))
    .filter((p) => access[p.slug] && access[p.slug] !== ACCESS_LEVEL.NONE)
    .map((p) => `${p.section === p.label ? p.label : `${p.section} › ${p.label}`} (${access[p.slug] === ACCESS_LEVEL.EDITOR ? 'can edit' : 'view only'})`);
  const team = user.team ? `${TEAM_LABEL[user.team]} team${user.facilities.length ? `, facilities ${user.facilities.join(', ')}` : ''}` : null;
  const url = env.auth.frontendOrigin;
  const lines = [
    `Hi ${user.name},`,
    '',
    `${adder ?? 'An admin'} added you to POST FG as ${roleText}${team ? ` (${team})` : ''}.`,
    '',
    pages.length ? 'You can open:' : 'You have no pages yet; an admin will give you access.',
    ...pages.map((p) => `  • ${p}`),
    '',
    `Sign in with your Google account (${user.email}): ${url}`,
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827;line-height:1.5">
<p>Hi ${esc(user.name)},</p>
<p><b>${esc(adder ?? 'An admin')}</b> added you to <b>POST FG</b> as <b>${esc(roleText)}</b>${team ? ` (${esc(team)})` : ''}.</p>
${pages.length ? `<p>You can open:</p><ul>${pages.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p>You have no pages yet; an admin will give you access.</p>'}
<p><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Sign in to POST FG</a></p>
<p style="color:#6b7280;font-size:12px">Use your Google account ${esc(user.email)}.</p>
</div>`;
  return { to: user.email, subject: WELCOME_EMAIL.SUBJECT, text: lines.join('\n'), html };
};

/** One try: sends and records welcome_sent_at, or records why it failed. */
export const sendWelcome = async (id: number): Promise<{ sent: boolean; error: string | null }> => {
  const user = (await listUsers()).find((u) => u.id === id);
  if (!user) throw appError(ERROR_CODES.USER_ID_NOT_FOUND, String(id));
  try {
    await sendMail(await welcomeMail(user));
    await AppDataSource.getRepository(User).update(id, { welcomeSentAt: new Date(), welcomeError: null });
    console.log(`[users] welcome email sent to ${user.email}`);
    return { sent: true, error: null };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, WELCOME_EMAIL.ERROR_MAX);
    await AppDataSource.getRepository(User).update(id, { welcomeError: error });
    console.warn(`[users] welcome email to ${user.email} failed: ${error}`);
    if (err instanceof AppError && err.code === ERROR_CODES.MAIL_SEND_NOT_ALLOWED) (err as AppError & { final?: boolean }).final = true;
    throw err;
  }
};

/** Tries now, then after each WELCOME_EMAIL.RETRY_DELAYS_MS; stops at the first success or a missing permission. */
const scheduleWelcome = (id: number, attempt = 0): void => {
  sendWelcome(id).catch((err: AppError & { final?: boolean }) => {
    const wait = WELCOME_EMAIL.RETRY_DELAYS_MS[attempt];
    if (err.final || wait === undefined) return;
    setTimeout(() => scheduleWelcome(id, attempt + 1), wait).unref();
  });
};

