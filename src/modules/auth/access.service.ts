import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ACCESS_LEVEL, AccessLevel, PAGES } from '../../constants';
import { PagePermission, UserPagePermission } from '../../entities';

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

export const resolveAccess = async (userId: number, roles: string[], pageSlug: string): Promise<AccessLevel> => {
  const overrides = AppDataSource.getRepository(UserPagePermission);
  const grants = AppDataSource.getRepository(PagePermission);
  for (let slug: string | null = pageSlug; slug; slug = parentSlug(slug)) {
    const own = await overrides.findOneBy({ userId, pageSlug: slug });
    if (own) return own.accessLevel;
    if (roles.length) {
      const rows = await grants.findBy({ role: In(roles), pageSlug: slug });
      if (rows.length) return best(rows.map((r) => r.accessLevel));
    }
  }
  return ACCESS_LEVEL.NONE;
};

/** Every page's level for the user (for /auth/me: the sidebar hides `none` and locks `viewer`). */
export const resolveAllAccess = async (userId: number, roles: string[]): Promise<Record<string, AccessLevel>> => {
  const out: Record<string, AccessLevel> = {};
  for (const p of PAGES) out[p.slug] = await resolveAccess(userId, roles, p.slug);
  return out;
};
