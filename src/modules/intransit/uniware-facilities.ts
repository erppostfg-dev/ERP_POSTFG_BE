import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { TABLES } from '../../constants';
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

/** The Uniware settings with the facilities to export filled in. */
export const uniwareConfig = async (): Promise<UniwareConfig> => ({ ...env.intransit.uniware, facilities: (await uniwareFacilities()).codes });
