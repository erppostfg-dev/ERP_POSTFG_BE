import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCESS_LEVEL,
  AccessLevel,
  ERROR_CODES,
  IST_OFFSET_MS,
  PAGES,
  ROLE_EXCLUDED_PAGES,
  ROLE_KEY_PATTERN,
  TABLES,
} from '../../constants';
import { ActivityLog, PagePermission, Role } from '../../entities';
import { appError } from '../../utils/AppError';

/*
 * Roles (2026-10-15, user: "based on the role he can only access a few routes"). A role = a label + page grants
 * (page_permissions): for each route none / viewer / editor. Every editable page gets its own row (so a child page can
 * be hidden even when its section is open). Built-in roles (developer, admin) keep full access and are not editable
 * here; /admin (Users & Roles) cannot be given to a custom role. Roles are never deleted from the screen.
 */

export type Grants = Record<string, AccessLevel>;

export interface RoleItem {
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  users: number;
  grants: Grants;
}

/** Pages a custom role can be given, in sidebar order (section first, then its pages). */
export const rolePages = () =>
  PAGES.filter((p) => !ROLE_EXCLUDED_PAGES.includes(p.slug)).map((p) => ({
    slug: p.slug,
    label: p.label,
    section: p.section,
    /** A section row ("/operations") vs one of its pages ("/operations/po-overview"). */
    isSection: p.slug.split('/').length === 2,
  }));

export const listRoles = async (): Promise<RoleItem[]> => {
  const [roles, grants, counts] = await Promise.all([
    AppDataSource.getRepository(Role).find({ order: { isSystem: 'DESC', label: 'ASC' } }),
    AppDataSource.getRepository(PagePermission).find(),
    AppDataSource.query(`SELECT role, COUNT(*) n FROM ${TABLES.USER_ROLES} GROUP BY role`) as Promise<{ role: string; n: string | number }[]>,
  ]);
  return roles.map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    isSystem: r.isSystem,
    users: Number(counts.find((c) => c.role === r.key)?.n ?? 0),
    grants: Object.fromEntries(grants.filter((g) => g.role === r.key).map((g) => [g.pageSlug, g.accessLevel])),
  }));
};

/** Only known pages, never the excluded ones, only none / viewer / editor. */
const checkGrants = (grants: Grants): Grants => {
  const known = new Set(rolePages().map((p) => p.slug));
  for (const [slug, level] of Object.entries(grants)) {
    if (!known.has(slug)) throw appError(ERROR_CODES.ROLE_PAGE_NOT_ALLOWED, slug);
    if (!(Object.values(ACCESS_LEVEL) as string[]).includes(level)) throw appError(ERROR_CODES.FIELD_NOT_ONE_OF, slug, Object.values(ACCESS_LEVEL).join(', '));
  }
  return grants;
};

/** Writes one row per editable page: the given level, else none. */
const writeGrants = async (m: EntityManager, role: string, grants: Grants) => {
  const repo = m.getRepository(PagePermission);
  await repo.delete({ role });
  await repo.insert(rolePages().map((p) => ({ role, pageSlug: p.slug, accessLevel: grants[p.slug] ?? ACCESS_LEVEL.NONE })));
};

const audit = (m: EntityManager, userId: number, what: string) =>
  m.getRepository(ActivityLog).insert({ userId, method: 'AUDIT', path: what.slice(0, 255), status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS) });

const summary = (g: Grants) => Object.entries(g).filter(([, l]) => l !== ACCESS_LEVEL.NONE).map(([s, l]) => `${s}:${l}`).join(' ') || 'none';

/** "Warehouse Ops" -> "warehouse-ops". */
export const roleKeyOf = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const createRole = async (input: { label: string; description?: string | null; grants: Grants }, by: { id: number; email: string }): Promise<RoleItem> => {
  const key = roleKeyOf(input.label);
  if (!ROLE_KEY_PATTERN.test(key)) throw appError(ERROR_CODES.FIELD_NOT_TEXT, 'label');
  const grants = checkGrants(input.grants);
  await AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(Role);
    if (await repo.findOneBy({ key })) throw appError(ERROR_CODES.ROLE_EXISTS, key);
    await repo.insert({ key, label: input.label.trim(), description: input.description?.trim() || null, isSystem: false, createdBy: by.id });
    await writeGrants(m, key, grants);
    await audit(m, by.id, `roles: added ${key} ${summary(grants)}`);
  });
  console.log(`[roles] ${by.email} added role ${key}`);
  return (await listRoles()).find((r) => r.key === key)!;
};

export const updateRole = async (
  key: string,
  input: { label?: string; description?: string | null; grants?: Grants },
  by: { id: number; email: string },
): Promise<RoleItem> => {
  await AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(Role);
    const role = await repo.findOne({ where: { key }, lock: { mode: 'pessimistic_write' } });
    if (!role) throw appError(ERROR_CODES.ROLE_NOT_FOUND, key);
    if (role.isSystem) throw appError(ERROR_CODES.ROLE_IS_SYSTEM, role.label);
    const set: Partial<Role> = {};
    if (input.label?.trim()) set.label = input.label.trim();
    if (input.description !== undefined) set.description = input.description?.trim() || null;
    if (Object.keys(set).length) await repo.update(key, set);
    if (input.grants) await writeGrants(m, key, checkGrants(input.grants));
    await audit(m, by.id, `roles: changed ${key}${set.label ? ` label=${set.label}` : ''}${input.grants ? ` ${summary(input.grants)}` : ''}`);
  });
  console.log(`[roles] ${by.email} changed role ${key}`);
  return (await listRoles()).find((r) => r.key === key)!;
};
