/*
 * Seeds login and page access through the ORM: users + their roles, and the default role grants (constants/auth.ts).
 * DRY RUN by default; --apply writes in one transaction. Safe to run again: existing rows are left as they are.
 *
 *   npm run auth:seed -- --developer pavan.eluri@mcaffeine.com
 *   npm run auth:seed -- --developer pavan.eluri@mcaffeine.com --admin a@mcaffeine.com,b@mcaffeine.com --apply
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { DEFAULT_ROLE_GRANTS, ERROR_CODES, ROLE_KEYS, ROLES, RoleKey, USER_STATUS } from '../constants';
import { PagePermission, User, UserRole } from '../entities';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const emails = (v?: string) => (v ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** "pavan.eluri@mcaffeine.com" -> "Pavan Eluri" (users.name is required; editable later on the Admin page). */
const nameFromEmail = (email: string): string =>
  email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const main = async (): Promise<void> => {
  const wanted: { email: string; role: RoleKey }[] = [
    ...emails(arg('developer')).map((email) => ({ email, role: ROLES.DEVELOPER as RoleKey })),
    ...emails(arg('admin')).map((email) => ({ email, role: ROLES.ADMIN as RoleKey })),
  ];
  if (!wanted.length) throw appError(ERROR_CODES.CLI_USAGE, 'Give --developer <email> and/or --admin <email,email> [--apply]');

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  try {
    await AppDataSource.transaction(async (m) => {
      const users = m.getRepository(User);
      const roles = m.getRepository(UserRole);
      const grants = m.getRepository(PagePermission);

      for (const w of wanted) {
        let user = await users.findOneBy({ email: w.email });
        if (!user) {
          console.log(`  + users: ${w.email} ("${nameFromEmail(w.email)}", active)`);
          if (APPLY) user = await users.save(users.create({ email: w.email, name: nameFromEmail(w.email), status: USER_STATUS.ACTIVE }));
        } else console.log(`  = users: ${w.email} exists (id ${user.id}, ${user.status ?? 'active'})`);
        const has = user ? await roles.findOneBy({ userId: user.id, role: w.role }) : null;
        if (has) console.log(`  = user_roles: ${w.email} already ${w.role}`);
        else {
          console.log(`  + user_roles: ${w.email} -> ${w.role}`);
          if (APPLY && user) await roles.insert({ userId: user.id, role: w.role });
        }
      }

      for (const role of ROLE_KEYS) {
        for (const g of DEFAULT_ROLE_GRANTS[role]) {
          const existing = await grants.findOneBy({ role, pageSlug: g.pageSlug });
          if (existing) console.log(`  = page_permissions: ${role} ${g.pageSlug} ${existing.accessLevel} (left as it is)`);
          else {
            console.log(`  + page_permissions: ${role} ${g.pageSlug} ${g.access}`);
            if (APPLY) await grants.insert({ role, pageSlug: g.pageSlug, accessLevel: g.access });
          }
        }
      }
    });
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
