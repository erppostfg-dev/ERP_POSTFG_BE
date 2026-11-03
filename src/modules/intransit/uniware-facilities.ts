import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { FACILITY_GROUPS, type FacilityGroups, TABLES } from '../../constants';
import { UniwareConfig } from './sources/uniware';

/*
 * The facilities the Uniware fetch exports (user, 2026-10-26): master_facilities rows with uniware_export = yes and
 * still active (add a facility = switch it on there). Only where the database has no such column yet, or no database
 * is connected (a script run without one), the old .env UNIWARE_FACILITY list is used.
 */

export const uniwareFacilities = async (): Promise<{ codes: string[]; from: 'database' | 'env' }> => {
  if (AppDataSource.isInitialized) {
    try {
      const rows = (await AppDataSource.query(
        `SELECT code FROM ${TABLES.MASTER_FACILITIES} WHERE uniware_export = 1 AND is_active = 1 ORDER BY code`,
      )) as { code: string }[];
      return { codes: rows.map((r) => r.code), from: 'database' };
    } catch (err) {
      // ER_BAD_FIELD_ERROR: migration FacilityUniwareExport not run on this database yet
      if ((err as { code?: string }).code !== 'ER_BAD_FIELD_ERROR') throw err;
    }
  }
  return { codes: env.intransit.uniware.facilities, from: 'env' };
};

/**
 * The stock a report counts (user, 2026-10-30: facilities are added from the Facility check, not in code): active
 * master_facilities rows with an intransit_group, as [group, Channel type, facilities], groups in FACILITY_GROUPS order
 * (any other group after). FACILITY_GROUPS where there is no database or no row has a group yet.
 */
export const facilityGroups = async (): Promise<FacilityGroups> => {
  if (!AppDataSource.isInitialized) return FACILITY_GROUPS;
  const rows = (await AppDataSource.query(
    `SELECT code, intransit_group AS grp, intransit_type AS type FROM ${TABLES.MASTER_FACILITIES}
      WHERE intransit_group IS NOT NULL AND intransit_group <> '' AND is_active = 1 ORDER BY code`,
  )) as { code: string; grp: string; type: string | null }[];
  if (!rows.length) return FACILITY_GROUPS;
  const order = FACILITY_GROUPS.map(([g]) => g);
  const groups = new Map<string, [string, string[]]>();
  for (const r of rows) {
    const g = groups.get(r.grp) ?? [r.type || r.grp, []];
    g[1].push(r.code);
    groups.set(r.grp, g);
  }
  const rank = (g: string): number => (order.includes(g) ? order.indexOf(g) : order.length);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([g, [type, codes]]) => [g, type, codes] as const);
};

/** The Uniware settings with the facilities to export and the stock facilities filled in. */
export const uniwareConfig = async (): Promise<UniwareConfig> => ({
  ...env.intransit.uniware,
  facilities: (await uniwareFacilities()).codes,
  stockFacilities: (await facilityGroups()).flatMap(([, , codes]) => codes),
});
