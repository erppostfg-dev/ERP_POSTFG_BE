import { EntityManager } from 'typeorm';
import { env } from '../../config/env';
import { ERROR_CODES, MASTER_LOG_TYPE, TABLES, TEST_FACILITY } from '../../constants';
import { appError } from '../../utils/AppError';
import { type D2cSettings, readSettings } from './settings';

/*
 * Test facilities and local TEST ONLY mode (user, 2026-11-03: "while on local host everything is made in test facility
 * and everything is test so that real working doesn't change").
 *
 * A test facility: TEST_FACILITY or a code of d2c:settings.testFacilities (exact code, as Uniware has it).
 *
 * The Uniware write gate (all modes; uniwareWritesAllowed):
 *   test only (env.d2c.testOnly)  sender AND receiving facility both test facilities, whatever settings.live / env say;
 *   gate open (settings.live AND D2C_UNIWARE_WRITES)  the facility the write happens at must be known: the sender for a
 *                                 sale order / cancel / close short, the receiving facility for an inward PO;
 *   gate closed                   sender AND receiving facility both test facilities.
 *
 * Test only mode also refuses every change (create, import, edit, cancel, expiry, variance reason) of a transfer that
 * is not between two test facilities (assertTestTransfer / validateRows), keeps the sync timer off, limits Sync now to
 * test transfers (testScopeSql) and writes the in-transit feed empty.
 */

/** Exact test facility codes: TEST_FACILITY + d2c:settings.testFacilities. */
export const testCodesOf = (s: Pick<D2cSettings, 'testFacilities'>): string[] =>
  [...new Set([TEST_FACILITY, ...(Array.isArray(s.testFacilities) ? s.testFacilities.map(String) : [])])];

export const isTestFacility = (s: Pick<D2cSettings, 'testFacilities'>, code: string | null | undefined): boolean =>
  !!code && testCodesOf(s).includes(code);

/** Sender and receiving facility both test facilities. */
export const isTestLane = (s: Pick<D2cSettings, 'testFacilities'>, sender: string | null | undefined, receiving: string | null | undefined): boolean =>
  isTestFacility(s, sender) && isTestFacility(s, receiving);

export const laneText = (sender: string | null | undefined, receiving: string | null | undefined) => `${sender || '(no sender)'} -> ${receiving || '(no receiving facility)'}`;

/** The receiving facility code of a transfer location (details_channels.transfer_facility_id), or null. */
export const receivingOfLocation = async (m: EntityManager, locationId: string | number | null | undefined): Promise<string | null> => {
  if (locationId === null || locationId === undefined || locationId === '') return null;
  const [r] = await m.query<{ code: string | null }[]>(
    `SELECT f.code FROM ${TABLES.DETAILS_CHANNELS} d JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id WHERE d.id = ?`, [locationId],
  );
  return r?.code ?? null;
};

/**
 * Test only mode: refuses (409 D2C_TEST_ONLY_CHANGE) a change of a transfer that is not between two test facilities.
 * Off: nothing.
 */
export const assertTestTransfer = async (
  m: EntityManager, s: Pick<D2cSettings, 'testFacilities'>, po: { facility: string | null; locationId: string | null }, testOnly = env.d2c.testOnly,
): Promise<void> => {
  if (!testOnly) return;
  const receiving = await receivingOfLocation(m, po.locationId);
  if (!isTestLane(s, po.facility, receiving)) throw appError(ERROR_CODES.D2C_TEST_ONLY_CHANGE, laneText(po.facility, receiving));
};

/**
 * SQL (on master_purchase_orders alias `p`) keeping only transfers that involve a test facility, for Sync now in test
 * only mode; '' when off.
 */
export const testScopeSql = (s: Pick<D2cSettings, 'testFacilities'>, p = 'p', testOnly = env.d2c.testOnly): { sql: string; args: unknown[] } => {
  if (!testOnly) return { sql: '', args: [] };
  const codes = testCodesOf(s);
  return {
    sql: ` AND (${p}.facility IN (?) OR EXISTS (SELECT 1 FROM ${TABLES.DETAILS_CHANNELS} tsd JOIN ${TABLES.MASTER_FACILITIES} tsf ON tsf.id = tsd.transfer_facility_id
            WHERE tsd.id = ${p}.locationId AND tsf.code IN (?)))`,
    args: [codes, codes],
  };
};

// ---- D2C masters in test only mode ----------------------------------------------------------------------------------

/** The D2C fields of the Masters edit forms that test only mode guards (a transfer route: every edit and switch). */
export const D2C_TEST_GUARDED_KEYS: Readonly<Record<string, readonly string[]>> = {
  [MASTER_LOG_TYPE.LOCATION]: ['transferFacilityId', 'transferPoPrefix'],
  [MASTER_LOG_TYPE.FACILITY]: ['allowInternalTransfer'],
};

/**
 * Why a Masters edit is refused in test only mode, or null. `keys` = the form keys changed ('isActive' for a switch),
 * `codes` = the facility codes the row stands for (route: sender + receiving; location: its current + new transfer
 * facility; warehouse: its code). Pure.
 */
export const testMasterEditBlock = (
  s: Pick<D2cSettings, 'testFacilities'>, type: string, keys: readonly string[], codes: (string | null | undefined)[], testOnly = env.d2c.testOnly,
): string | null => {
  if (!testOnly) return null;
  const guarded = type === MASTER_LOG_TYPE.TRANSFER_ROUTE || keys.some((k) => (D2C_TEST_GUARDED_KEYS[type] ?? []).includes(k));
  if (!guarded) return null;
  const real = codes.length ? codes.filter((c) => !isTestFacility(s, c)).map((c) => c || '(none)') : ['(none)'];
  if (!real.length) return null;
  const what = type === MASTER_LOG_TYPE.TRANSFER_ROUTE ? 'transfer route' : type === MASTER_LOG_TYPE.LOCATION ? 'transfer location' : 'warehouse';
  return `this ${what} is not a TEST_FACILITY row (${[...new Set(real)].join(', ')})`;
};

const codeOfFacility = async (m: EntityManager, id: unknown): Promise<string | null> => {
  if (id === null || id === undefined || id === '') return null;
  const [r] = await m.query<{ code: string }[]>(`SELECT code FROM ${TABLES.MASTER_FACILITIES} WHERE id = ?`, [id]);
  return r?.code ?? null;
};

/**
 * Test only mode: refuses (409 D2C_TEST_ONLY_MASTER) a D2C master edit / switch of a row that is not a test row
 * (testMasterEditBlock). `row` = the locked DB row (snake_case columns), `next` = the checked new values by form key.
 */
export const assertTestMasterEdit = async (
  m: EntityManager, type: string, row: Record<string, unknown>, keys: readonly string[], next: Record<string, unknown> = {}, testOnly = env.d2c.testOnly,
): Promise<void> => {
  if (!testOnly || !testMasterEditBlock({ testFacilities: [] }, type, keys, [], testOnly)) return;
  let codes: (string | null)[] = [];
  if (type === MASTER_LOG_TYPE.TRANSFER_ROUTE) {
    codes = [await codeOfFacility(m, row.dispatch_facility_id), await receivingOfLocation(m, row.location_id as string | number | null)];
  } else if (type === MASTER_LOG_TYPE.LOCATION) {
    codes = [await codeOfFacility(m, row.transfer_facility_id)];
    if ('transferFacilityId' in next) codes.push(await codeOfFacility(m, next.transferFacilityId));
  } else if (type === MASTER_LOG_TYPE.FACILITY) codes = [typeof row.code === 'string' && row.code ? row.code : null];
  const why = testMasterEditBlock(await readSettings(m), type, keys, codes, testOnly);
  if (why) throw appError(ERROR_CODES.D2C_TEST_ONLY_MASTER, why);
};
