import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ERROR_CODES, FACILITY_CHECK, IST_OFFSET_MS, MAIL_LIST, MASTER_SOURCE, STOCK_BUCKETS, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { ActivityLog, MasterFacility } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { log as appLog } from '../../utils/logger';
import { sendToList } from '../mail/mail-lists.service';
import { facilityCheckMail } from './facility-check-mail';
import { assertMastersWritable } from './masters-db';
import { withLock } from './s3/lock';
import { PROD_SCOPE, writeScope } from './s3/scope';
import { searchFacilityParties, uniwareCatalog, type UniwareFacility, UNIWARE_KEYS } from './sources/uniware';

/*
 * The weekly Uniware facility check (user, 2026-10-30: "each week it checks for all the active facilities from
 * uniware and then just prompt the user to add them through the click"). Every Monday from 09:00 IST the live server
 * asks Uniware (facility/search) for its enabled facilities and compares them with master_facilities:
 *   new       enabled in Uniware, but neither exported (uniware_export) nor counted as stock (intransit_group) here;
 *   disabled  exported or counted here, but no longer enabled in Uniware (or no longer visible to our Uniware user).
 * The result is kept in app_state, shown as a banner on In-transit Stock and Masters > Warehouses, and mailed to the
 * "In-transit facility changes" list. Add = pick its stock bucket (a guess from the code is offered): the facility is
 * exported and counted from the next fetch / build. Not stock = never prompted again. Stop = no longer exported or
 * counted. Each click is in activity_log (AUDIT, "facility-check: ...").
 */

export interface NewFacility extends UniwareFacility {
  /** It has a master_facilities row already (else Add creates one). */
  inMaster: boolean;
  /** The bucket its code suggests (STOCK_BUCKETS group), or null. */
  guess: string | null;
}

export interface DisabledFacility {
  code: string;
  name: string | null;
  group: string | null;
  exported: boolean;
}

export interface FacilityCheckState {
  /** When the last check that reached Uniware ran (ISO); null = never. */
  checkedAt: string | null;
  /** When the last check was tried, and its error when it failed. */
  attemptedAt: string | null;
  error: string | null;
  newFacilities: NewFacility[];
  disabled: DisabledFacility[];
  /** Codes marked "Not stock": never prompted as new again. */
  ignored: string[];
}

export interface FacilityCheckView extends FacilityCheckState {
  buckets: typeof STOCK_BUCKETS;
}

interface MasterRow {
  id: number;
  code: string;
  name: string | null;
  aliases: string[] | string | null;
  intransit_group: string | null;
  uniware_export: number | boolean;
  is_active: number | boolean;
}

interface Actor {
  id: number | null;
}

const EMPTY: FacilityCheckState = { checkedAt: null, attemptedAt: null, error: null, newFacilities: [], disabled: [], ignored: [] };
const lc = (s: string): string => s.trim().toLowerCase();

/** The stock bucket a facility code suggests (Uniware naming), or null when it says nothing. */
export const guessBucket = (code: string): string | null => {
  const c = lc(code);
  if (c.startsWith('ds_')) return 'DarkStore';
  if (c.startsWith('return_')) return 'Return';
  if (/kol.*warehouse|warehouse.*kol|b2b_kol/.test(c)) return 'KOLMWH';
  if (/ggn.*warehouse|warehouse.*ggn|b2b_ggn/.test(c)) return 'GGNMWH';
  if (/mum.*warehouse|warehouse.*mum|b2b_mum/.test(c)) return 'MUMMWH';
  if (/^(mcaff_|hyp_(sr|dl|sp|by|ahmd))/.test(c)) return 'D2C';
  return null;
};

const aliasesOf = (r: MasterRow): string[] =>
  Array.isArray(r.aliases) ? r.aliases : r.aliases ? (JSON.parse(r.aliases) as string[]) : [];

/** New and disabled facilities from Uniware's enabled list and master_facilities (codes compared ignoring case). */
export const compareFacilities = (
  enabled: readonly UniwareFacility[], master: readonly MasterRow[], ignored: readonly string[],
): { newFacilities: NewFacility[]; disabled: DisabledFacility[] } => {
  const inUse = (r: MasterRow): boolean => !!Number(r.is_active) && (!!Number(r.uniware_export) || !!r.intransit_group);
  const byCode = new Map<string, MasterRow[]>();
  for (const r of master) {
    for (const k of [r.code, ...aliasesOf(r)]) byCode.set(lc(k), [...(byCode.get(lc(k)) ?? []), r]);
  }
  const skip = new Set(ignored.map(lc));
  const enabledCodes = new Set(enabled.map((f) => lc(f.code)));
  const newFacilities = enabled
    .filter((f) => !skip.has(lc(f.code)) && !(byCode.get(lc(f.code)) ?? []).some(inUse))
    .map((f) => ({ ...f, inMaster: byCode.has(lc(f.code)), guess: guessBucket(f.code) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const disabled = master
    .filter((r) => inUse(r) && ![r.code, ...aliasesOf(r)].some((k) => enabledCodes.has(lc(k))))
    .map((r) => ({ code: r.code, name: r.name, group: r.intransit_group, exported: !!Number(r.uniware_export) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { newFacilities, disabled };
};

// ---- state (app_state) -----------------------------------------------------------------------------------------

const readState = async (): Promise<FacilityCheckState> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [FACILITY_CHECK.STATE_KEY]);
  let v = row?.value;
  if (Buffer.isBuffer(v)) v = v.toString('utf8');
  if (typeof v === 'string') v = JSON.parse(v) as unknown;
  return v && typeof v === 'object' ? { ...EMPTY, ...(v as Partial<FacilityCheckState>) } : { ...EMPTY };
};

const writeState = (s: FacilityCheckState): Promise<unknown> =>
  AppDataSource.query(
    `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [FACILITY_CHECK.STATE_KEY, JSON.stringify(s), new Date()],
  );

export const getFacilityCheck = async (): Promise<FacilityCheckView> => ({ ...(await readState()), buckets: STOCK_BUCKETS });

// ---- the check -------------------------------------------------------------------------------------------------

const masterRows = (): Promise<MasterRow[]> =>
  AppDataSource.query<MasterRow[]>(`SELECT id, code, name, aliases, intransit_group, uniware_export, is_active FROM ${TABLES.MASTER_FACILITIES}`);

/** Ask Uniware, compare, keep the result and mail it when there is something to do. */
export const runFacilityCheck = async (): Promise<FacilityCheckState> => {
  const before = await readState();
  const attemptedAt = new Date().toISOString();
  try {
    const enabled = await searchFacilityParties(uniwareCatalog(env.intransit.uniware), 'ENABLED');
    if (!enabled.length) throw new Error('Uniware returned no enabled facility for this user');
    const found = compareFacilities(enabled, await masterRows(), before.ignored);
    const state: FacilityCheckState = { ...before, ...found, checkedAt: attemptedAt, attemptedAt, error: null };
    await writeState(state);
    appLog.info(LOG_SOURCE.APP, `[facility-check] ${enabled.length} enabled in Uniware: ${found.newFacilities.length} new, ${found.disabled.length} disabled`);
    if (found.newFacilities.length || found.disabled.length) {
      await sendToList(MAIL_LIST.INTRANSIT_FACILITY_CHANGES, facilityCheckMail(state))
        .catch((err) => logError(LOG_SOURCE.APP, '[facility-check] mail not sent', err));
    }
    return state;
  } catch (err) {
    await writeState({ ...before, attemptedAt, error: (err as Error).message.slice(0, 500) });
    throw err;
  }
};

const DAY_MS = 86_400_000;
const RETRY_AFTER_ERROR_MS = 6 * 3_600_000;

/** Due: never checked, a week since the last check, Monday 09:00 IST not yet checked today, or 6 h after a failure. */
export const checkDue = (s: Pick<FacilityCheckState, 'checkedAt' | 'attemptedAt' | 'error'>, now = Date.now()): boolean => {
  if (s.error && s.attemptedAt) return now - Date.parse(s.attemptedAt) >= RETRY_AFTER_ERROR_MS;
  if (!s.checkedAt) return true;
  const last = Date.parse(s.checkedAt);
  if (now - last >= 7 * DAY_MS) return true;
  const ist = new Date(now + IST_OFFSET_MS);
  const lastDay = new Date(last + IST_OFFSET_MS).toISOString().slice(0, 10);
  return ist.getUTCDay() === FACILITY_CHECK.WEEKDAY && ist.getUTCHours() >= FACILITY_CHECK.FROM_HOUR_IST && lastDay !== ist.toISOString().slice(0, 10);
};

let timer: NodeJS.Timeout | null = null;

/** Every hour, run the check when due: live scope, database, Uniware set up, INTRANSIT_FACILITY_CHECK on. One machine at a time. */
export const startFacilityCheck = (): void => {
  if (timer || !AppDataSource.isInitialized || env.laptopMode || !env.intransit.facilityCheck || writeScope() !== PROD_SCOPE) return;
  const { tenant, username, password } = env.intransit.uniware;
  if (!tenant || !username || !password) {
    appLog.info(LOG_SOURCE.APP, `[facility-check] off: ${UNIWARE_KEYS.join(', ')} not set`);
    return;
  }
  const tick = (): void => void withLock('it:facility-check', async () => {
    if (checkDue(await readState())) await runFacilityCheck();
  }, 0).catch((err) => logError(LOG_SOURCE.APP, '[facility-check] check failed', err));
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, FACILITY_CHECK.TICK_MS);
  timer.unref();
};

export const stopFacilityCheck = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};

// ---- the clicks ------------------------------------------------------------------------------------------------

const audit = (by: Actor, what: string): Promise<unknown> =>
  AppDataSource.getRepository(ActivityLog).insert({
    userId: by.id,
    method: 'AUDIT',
    path: `facility-check: ${what}`.slice(0, 255),
    status: 200,
    durationMs: 0,
    createdOn: new Date(Date.now() + IST_OFFSET_MS),
  });

/** The master row of `code` (exact spelling first, then ignoring case). */
const findMaster = async (code: string): Promise<MasterFacility | null> => {
  const repo = AppDataSource.getRepository(MasterFacility);
  return (await repo.findOneBy({ code })) ?? (await repo.createQueryBuilder('f').where('LOWER(f.code) = :c', { c: lc(code) }).getOne());
};

/** Add a new facility: exported from the next Uniware fetch, its stock counted in bucket `group` from the next build. */
export const addFacility = async (code: string, group: string, by: Actor): Promise<FacilityCheckView> => {
  assertMastersWritable();
  const bucket = STOCK_BUCKETS.find((b) => b.group === group);
  if (!bucket) throw appError(ERROR_CODES.INTRANSIT_BUCKET_UNKNOWN, group);
  const state = await readState();
  const item = state.newFacilities.find((f) => f.code === code);
  if (!item) throw appError(ERROR_CODES.INTRANSIT_FACILITY_NOT_IN_CHECK, code);
  const repo = AppDataSource.getRepository(MasterFacility);
  const row = (await findMaster(code)) ?? repo.create({ code: item.code, name: item.name, source: MASTER_SOURCE.UNIWARE });
  Object.assign(row, { uniwareExport: true, intransitGroup: bucket.group, intransitType: bucket.type, isActive: true });
  await repo.save(row);
  await audit(by, `added ${row.code} as ${bucket.group}`);
  await writeState({ ...state, newFacilities: state.newFacilities.filter((f) => f !== item) });
  return getFacilityCheck();
};

/** "Not stock": never prompted again (nothing else changes). */
export const ignoreFacility = async (code: string, by: Actor): Promise<FacilityCheckView> => {
  assertMastersWritable();
  const state = await readState();
  if (!state.newFacilities.some((f) => f.code === code)) throw appError(ERROR_CODES.INTRANSIT_FACILITY_NOT_IN_CHECK, code);
  await audit(by, `${code} marked not stock`);
  await writeState({ ...state, newFacilities: state.newFacilities.filter((f) => f.code !== code), ignored: [...new Set([...state.ignored, code])] });
  return getFacilityCheck();
};

/** A facility no longer enabled in Uniware: no longer exported, nor counted as stock. */
export const stopFacility = async (code: string, by: Actor): Promise<FacilityCheckView> => {
  assertMastersWritable();
  const state = await readState();
  if (!state.disabled.some((f) => f.code === code)) throw appError(ERROR_CODES.INTRANSIT_FACILITY_NOT_IN_CHECK, code);
  const row = await findMaster(code);
  if (row) {
    Object.assign(row, { uniwareExport: false, intransitGroup: null, intransitType: null });
    await AppDataSource.getRepository(MasterFacility).save(row);
  }
  await audit(by, `stopped ${code}`);
  await writeState({ ...state, disabled: state.disabled.filter((f) => f.code !== code) });
  return getFacilityCheck();
};
