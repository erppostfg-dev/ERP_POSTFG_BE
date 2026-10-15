import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCESS_LEVEL,
  COLUMN_ACCESS,
  ColumnAccess,
  FACILITY_SCOPED_TEAMS,
  PAGE,
  PO_TEAM_ORDER,
  PoTeam,
  ROLES,
  UserTeam,
} from '../../constants';
import { MasterFacility, TeamColumnAccess, User, UserFacility } from '../../entities';
import { resolveAccess } from '../auth/access.service';

/*
 * A person's PO Overview access (2026-10-14, user's decisions), worked out once per request:
 *   - page access first: no access to /operations/po-overview = nothing (requirePage already refuses); a VIEWER on the
 *     page can never edit, whatever the team says.
 *   - a person WITH a team (users.po_team): exactly that team's rows of team_column_access (missing row = none), even
 *     for a developer / admin (so anyone can test as a team).
 *   - no team: admin / developer edit every column group; anyone else only views.
 *   - warehouse / logistics teams: edit only shipments of their facilities (user_facilities); the screen opens filtered
 *     to them, others stay visible read-only (option c). No facility = view everything, edit nothing.
 */

export interface PoOverviewAccess {
  team: UserTeam | null;
  /** Access per column group (planning / warehouse / logistics / accounts). */
  groups: Record<PoTeam, ColumnAccess>;
  /** true = edits limited to `facilityIds`. */
  facilityScoped: boolean;
  facilityIds: number[];
  /** Codes of those facilities (the screen's default facility filter). */
  facilityCodes: string[];
}

const all = (access: ColumnAccess): Record<PoTeam, ColumnAccess> =>
  Object.fromEntries(PO_TEAM_ORDER.map((t) => [t, access])) as Record<PoTeam, ColumnAccess>;

export const accessFor = async (user: User, roles: string[]): Promise<PoOverviewAccess> => {
  const page = await resolveAccess(user.id, roles, PAGE.PO_OVERVIEW);
  const pageEdits = page === ACCESS_LEVEL.EDITOR;
  const cap = (a: ColumnAccess): ColumnAccess => (a === COLUMN_ACCESS.EDIT && !pageEdits ? COLUMN_ACCESS.VIEW : a);

  let groups: Record<PoTeam, ColumnAccess>;
  if (user.poTeam) {
    const rows = await AppDataSource.getRepository(TeamColumnAccess).findBy({ team: user.poTeam });
    groups = Object.fromEntries(PO_TEAM_ORDER.map((t) => [t, cap(rows.find((r) => r.columnGroup === t)?.access ?? COLUMN_ACCESS.NONE)])) as Record<PoTeam, ColumnAccess>;
  } else {
    const full = roles.includes(ROLES.ADMIN) || roles.includes(ROLES.DEVELOPER);
    groups = all(cap(full ? COLUMN_ACCESS.EDIT : COLUMN_ACCESS.VIEW));
  }

  const facilityScoped = !!user.poTeam && FACILITY_SCOPED_TEAMS.includes(user.poTeam);
  const links = facilityScoped ? await AppDataSource.getRepository(UserFacility).findBy({ userId: user.id }) : [];
  const facilities = links.length
    ? await AppDataSource.getRepository(MasterFacility).find({ select: ['id', 'code'], where: { id: In(links.map((l) => l.facilityId)) } })
    : [];
  return { team: user.poTeam, groups, facilityScoped, facilityIds: facilities.map((f) => f.id), facilityCodes: facilities.map((f) => f.code) };
};

/** May this person edit this shipment at all (before the per-column check)? */
export const canEditShipment = (a: PoOverviewAccess, facilityId: number | null): boolean =>
  Object.values(a.groups).includes(COLUMN_ACCESS.EDIT) && (!a.facilityScoped || (facilityId !== null && a.facilityIds.includes(facilityId)));
