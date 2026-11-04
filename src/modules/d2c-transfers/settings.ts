import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { D2C_DEFAULT_SETTINGS, D2C_STATE_KEY, TABLES } from '../../constants';

/*
 * d2c:settings (app_state, seeded by migration D2cTransfers1793800000000): the transfer types, the allowed channels,
 * the default PO expiry, the production gate and the PEPIMS cutover date. Missing keys fall back to the defaults.
 */
export type D2cSettings = typeof D2C_DEFAULT_SETTINGS;

/** A JSON column as mysql2 returns it (already parsed) or as text. */
export const jsonOf = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

export const readSettings = async (m?: EntityManager): Promise<D2cSettings> => {
  const q = m ?? AppDataSource.manager;
  const [row] = await q.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [D2C_STATE_KEY.SETTINGS]);
  const stored = jsonOf<Partial<D2cSettings>>(row?.value, {});
  return {
    ...D2C_DEFAULT_SETTINGS,
    ...stored,
    types: Array.isArray(stored.types) && stored.types.length ? stored.types : D2C_DEFAULT_SETTINGS.types,
    channels: Array.isArray(stored.channels) && stored.channels.length ? stored.channels : D2C_DEFAULT_SETTINGS.channels,
    defaultExpiryDays: Number.isInteger(stored.defaultExpiryDays) ? Number(stored.defaultExpiryDays) : D2C_DEFAULT_SETTINGS.defaultExpiryDays,
  };
};
