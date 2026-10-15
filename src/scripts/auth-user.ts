/*
 * Manages ONE person until the Admin page exists (user, 2026-10-14): adds them if missing, sets their PO Overview team
 * (one per person) and their facilities, switches them off or on. DRY RUN by default; --apply writes in one
 * transaction and records the change in activity_log (method CLI). Never deletes a person.
 *
 *   npm run auth:user -- --email ravi@mcaffeine.com --team warehouse --facilities MUM_WAREHOUSE2,MUM_Warehouse2 [--apply]
 *   npm run auth:user -- --email ravi@mcaffeine.com --team none                  (no team: page access only)
 *   npm run auth:user -- --email ravi@mcaffeine.com --off | --on                 (switch off / on)
 *   options: --name "Ravi Kumar" (else made from the email). --facilities replaces the person's whole list (exact
 *   codes: MUM_WAREHOUSE2 and MUM_Warehouse2 are different warehouses); --facilities "" clears it.
 */
import 'reflect-metadata';
import { In } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { ERROR_CODES, IST_OFFSET_MS, USER_STATUS, USER_TEAM, UserTeam } from '../constants';
import { ActivityLog, MasterFacility, User, UserFacility } from '../entities';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] ?? '' : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const APPLY = flag('apply');
const NO_TEAM = 'none';
const TEAMS = Object.values(USER_TEAM) as string[];
const USAGE = `auth:user -- --email <email> [--name "<name>"] [--team <${[...TEAMS, NO_TEAM].join('|')}>] [--facilities <code,code>] [--off | --on] [--apply]`;

/** "ravi.kumar@mcaffeine.com" -> "Ravi Kumar" (users.name is required). */
const nameFromEmail = (email: string): string =>
  email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const main = async (): Promise<void> => {
  const email = arg('email')?.trim().toLowerCase();
  const team = arg('team')?.trim();
  const facilityArg = arg('facilities');
  if (!email || (team !== undefined && ![...TEAMS, NO_TEAM].includes(team)) || (flag('off') && flag('on'))) throw appError(ERROR_CODES.CLI_USAGE, USAGE);
  const codes = facilityArg === undefined ? undefined : [...new Set(facilityArg.split(',').map((c) => c.trim()).filter(Boolean))];

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  const started = Date.now();
  const changes: string[] = [];
  try {
    await AppDataSource.transaction(async (m) => {
      const users = m.getRepository(User);
      let user = await users.findOneBy({ email });
      if (!user) {
        const name = arg('name')?.trim() || nameFromEmail(email);
        changes.push(`add user ${email} ("${name}", active)`);
        if (APPLY) user = await users.save(users.create({ email, name, status: USER_STATUS.ACTIVE }));
      }

      const set: Partial<User> = {};
      if (team !== undefined) {
        const next = team === NO_TEAM ? null : (team as UserTeam);
        if ((user?.poTeam ?? null) !== next) { set.poTeam = next; changes.push(`team ${user?.poTeam ?? 'none'} -> ${next ?? 'none'}`); }
      }
      if (flag('off') && user?.status !== USER_STATUS.INACTIVE) { set.status = USER_STATUS.INACTIVE; changes.push('switch OFF'); }
      if (flag('on') && user && user.status === USER_STATUS.INACTIVE) { set.status = USER_STATUS.ACTIVE; changes.push('switch ON'); }
      const name = arg('name')?.trim();
      if (user && name && name !== user.name) { set.name = name; changes.push(`name "${user.name}" -> "${name}"`); }
      if (APPLY && user && Object.keys(set).length) await users.update(user.id, set);

      if (codes) {
        // Exact codes: the column is case-sensitive, so MUM_WAREHOUSE2 and MUM_Warehouse2 are found separately.
        const found = codes.length ? await m.getRepository(MasterFacility).findBy({ code: In(codes), isActive: true }) : [];
        const missing = codes.filter((c) => !found.some((f) => f.code === c));
        if (missing.length) throw appError(ERROR_CODES.CLI_USAGE, `unknown or switched-off facility code(s): ${missing.join(', ')} (codes are case-sensitive)`);
        const links = m.getRepository(UserFacility);
        const have = user ? await links.findBy({ userId: user.id }) : [];
        const want = new Set(found.map((f) => f.id));
        const codeOf = new Map(found.map((f) => [f.id, f.code]));
        const add = found.filter((f) => !have.some((h) => h.facilityId === f.id));
        const remove = have.filter((h) => !want.has(h.facilityId));
        if (add.length) changes.push(`facilities + ${add.map((f) => f.code).join(', ')}`);
        if (remove.length) changes.push(`facilities - ${remove.map((h) => codeOf.get(h.facilityId) ?? `id ${h.facilityId}`).join(', ')}`);
        if (APPLY && user) {
          if (remove.length) await links.delete(remove.map((h) => ({ userId: h.userId, facilityId: h.facilityId })));
          if (add.length) await links.insert(add.map((f) => ({ userId: user!.id, facilityId: f.id })));
        }
      }

      if (!changes.length) changes.push('nothing to change');
      for (const c of changes) console.log(`  ${email}: ${c}`);
      if (APPLY && user && changes[0] !== 'nothing to change') {
        await m.getRepository(ActivityLog).insert({
          userId: null,
          method: 'CLI',
          path: `auth:user ${email}: ${changes.join('; ')}`.slice(0, 255),
          status: 200,
          durationMs: Date.now() - started,
          createdOn: new Date(Date.now() + IST_OFFSET_MS),
        });
      }
    });
    console.log(APPLY ? 'Done.' : 'Dry run only. Add --apply to write.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
