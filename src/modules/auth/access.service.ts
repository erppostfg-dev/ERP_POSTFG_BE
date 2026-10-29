import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ACCESS_LEVEL, AccessLevel, CAPABILITIES, Capability, PAGES, TABLES } from '../../constants';
import { USER_ADMIN_ROLES } from '../../constants/users';

/*
 * Page access, ported from prefg's lib/permissions.ts resolveAccess:
 *   1. a per-user override (user_page_permissions) for the page wins;
 *   2. else the BEST grant of the user's roles (page_permissions);
 *   3. nothing on this page -> try its parent ("/operations/po-review" -> "/operations"), up to the top;
 *   4. nothing anywhere -> none.
 * Read from the database on every call, so a change applies at once.
 */

const RANK: Record<AccessLevel, number> = { [ACCESS_LEVEL.NONE]: 0, [ACCESS_LEVEL.VIEWER]: 1, [ACCESS_LEVEL.EDITOR]: 2 };

const best = (levels: AccessLevel[]): AccessLevel =>
  levels.reduce<AccessLevel>((b, l) => (RANK[l] > RANK[b] ? l : b), ACCESS_LEVEL.NONE);

/** "/operations/po-review" -> "/operations", "/operations" -> null. */
const parentSlug = (slug: string): string | null => {
  const i = slug.lastIndexOf('/');
  return i <= 0 ? null : slug.slice(0, i);
};

/** True when `have` is at least `needed` (editor covers viewer). */
export const allows = (have: AccessLevel, needed: AccessLevel): boolean => RANK[have] >= RANK[needed];

/** One person's access rows, read once (2 queries), then any page or capability is worked out in memory. */
export interface AccessRows {
  /** user_page_permissions: page -> level */
  own: Map<string, AccessLevel>;
  /** page_permissions of the person's roles: page -> every role's level */
  grants: Map<string, AccessLevel[]>;
  roles: string[];
}

/*
 * A person's access rows kept for AUTH_CACHE_SECONDS (2026-10-27, user OK with 30 s), per user + roles. Changes in
 * Users & Roles clear them at once (forgetAccess).
 */
const accessCache = new Map<number, { roles: string; rows: AccessRows; until: number }>();

/** Clears cached access rows: of one user, or of everyone (a role's page access changed). */
export const forgetAccess = (userId?: number): void => void (userId === undefined ? accessCache.clear() : accessCache.delete(userId));

/**
 * One query, only the 2 columns used (2026-10-27: was 2 per page per level, ~45-90 for /auth/me, then 2): the person's
 * overrides and their roles' grants together (UNION ALL), then kept for AUTH_CACHE_SECONDS.
 */
export const loadAccess = async (userId: number, roles: string[]): Promise<AccessRows> => {
  const key = [...roles].sort().join(',');
  const hit = accessCache.get(userId);
  if (hit && hit.roles === key && hit.until > Date.now()) return hit.rows;

  const sql = `SELECT 'own' kind, page_slug, access_level FROM ${TABLES.USER_PAGE_PERMISSIONS} WHERE user_id = ?${
    roles.length ? ` UNION ALL SELECT 'role' kind, page_slug, access_level FROM ${TABLES.PAGE_PERMISSIONS} WHERE role IN (?)` : ''
  }`;
  const found = (await AppDataSource.query(sql, roles.length ? [userId, roles] : [userId])) as { kind: 'own' | 'role'; page_slug: string; access_level: AccessLevel }[];
  const own = new Map<string, AccessLevel>();
  const byPage = new Map<string, AccessLevel[]>();
  for (const f of found) {
    if (f.kind === 'own') own.set(f.page_slug, f.access_level);
    else byPage.set(f.page_slug, [...(byPage.get(f.page_slug) ?? []), f.access_level]);
  }
  const rows: AccessRows = { own, grants: byPage, roles };
  if (env.auth.cacheSeconds > 0) accessCache.set(userId, { roles: key, rows, until: Date.now() + env.auth.cacheSeconds * 1000 });
  return rows;
};

/** The rules above, on rows already loaded: no query. */
export const accessFrom = (rows: AccessRows, pageSlug: string): AccessLevel => {
  for (let slug: string | null = pageSlug; slug; slug = parentSlug(slug)) {
    const own = rows.own.get(slug);
    if (own) return own;
    const levels = rows.grants.get(slug);
    if (levels?.length) return best(levels);
  }
  return ACCESS_LEVEL.NONE;
};

export const resolveAccess = async (userId: number, roles: string[], pageSlug: string): Promise<AccessLevel> =>
  accessFrom(await loadAccess(userId, roles), pageSlug);

/** A special permission on loaded rows: admin / developer always; else the role grant (or the person's override) = editor. */
const capabilityFrom = (rows: AccessRows, key: Capability): boolean =>
  rows.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r)) || accessFrom(rows, key) === ACCESS_LEVEL.EDITOR;

/** A special permission (CAPABILITY): admin / developer always (no query); else the role grant (or the person's override) = editor. */
export const hasCapability = async (userId: number, roles: string[], key: Capability): Promise<boolean> =>
  roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r)) || capabilityFrom(await loadAccess(userId, roles), key);

/** Every special permission of the user, for /auth/me (pass `rows` to reuse a load). */
export const resolveCapabilities = async (userId: number, roles: string[], rows?: AccessRows): Promise<Record<string, boolean>> => {
  const loaded = rows ?? (await loadAccess(userId, roles));
  return Object.fromEntries(CAPABILITIES.map((c) => [c.key, capabilityFrom(loaded, c.key)]));
};

/** Every page's level for the user (for /auth/me: the sidebar hides `none` and locks `viewer`; pass `rows` to reuse a load). */
export const resolveAllAccess = async (userId: number, roles: string[], rows?: AccessRows): Promise<Record<string, AccessLevel>> => {
  const loaded = rows ?? (await loadAccess(userId, roles));
  return Object.fromEntries(PAGES.map((p) => [p.slug, accessFrom(loaded, p.slug)]));
};
