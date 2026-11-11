import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  D2C_LIMITS, D2C_PEPIMS_SHIPMENT_ORDERS, D2C_STATE_KEY, D2C_TRANSFER_TYPE, d2cReferenceId, d2cSaleOrderCode, d2cTransferCode, d2cTransferMonth, IST_OFFSET_MS,
  PEPIMS_DATABASE, TABLES,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { D2cSettings, jsonOf } from './settings';

/*
 * Codes of a transfer (plan 2.7 / 2.10 + the user's answers, 2026-11-03):
 *   - Transfer ID IT-<FY>-<MM>-<NNN>: app_state d2c:transfer-code { month, last }, month of the day it is created.
 *   - Reference ID <location PO prefix>|DDMonYYYY|<tag><serial>: ONE daily counter for all transfers, keyed by PO date,
 *     in app_state d2c:ref-serial { byDate }. While PEPIMS may still raise transfers (no cutover date yet, or less than
 *     D2C_LIMITS.PEPIMS_REREAD_DAYS after it) every take re-reads PEPIMS's highest serial of that day (read only), so
 *     we never reuse a number PEPIMS already gave.
 * Both rows are locked (SELECT ... FOR UPDATE) inside the transaction that inserts the transfers; always in the order
 * transfer-code, then ref-serial, so two saves cannot deadlock.
 */

const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

/** Today in India (YYYY-MM-DD). */
export const todayIst = (now = new Date()): string => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** A real calendar day given as YYYY-MM-DD or DD-MM-YYYY -> YYYY-MM-DD; anything else -> null. */
export const parseDay = (raw: unknown): string | null => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  let y: number;
  let mo: number;
  let d: number;
  const a = YMD.exec(s);
  const b = DMY.exec(s);
  if (a) [y, mo, d] = [Number(a[1]), Number(a[2]), Number(a[3])];
  else if (b) [d, mo, y] = [Number(b[1]), Number(b[2]), Number(b[3])];
  else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
};

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The date part of a reference ID: 2026-11-05 -> 05Nov2026. */
export const refDateToken = (day: string): string => d2cReferenceId('', day, D2C_TRANSFER_TYPE.REGULAR, 0).split('|')[1];

/** The serial of a PEPIMS / our reference ID of that day (tag letters skipped), or null when it is not one of that day. */
export const serialOfReference = (poNumber: string, day: string): number | null => {
  const token = refDateToken(day);
  const m = new RegExp(`\\|${token}\\|[A-Za-z ]*(\\d+)\\s*$`, 'i').exec(poNumber ?? '');
  return m ? Number(m[1]) : null;
};

/** Is PEPIMS still read on every take? Before a cutover date is set, and until cutoverDate + PEPIMS_REREAD_DAYS. */
export const shouldReadPepims = (cutoverDate: string | null, today: string): boolean =>
  !cutoverDate || today < addDays(cutoverDate, D2C_LIMITS.PEPIMS_REREAD_DAYS);

/** Next reference serial of a day: above both our counter and PEPIMS's highest. */
export const nextRefSerial = (stored: number, pepimsMax: number): number => Math.max(stored, pepimsMax) + 1;

/** d2c:ref-serial without days older than keepDays before today (the day being taken is always kept). */
export const pruneByDate = (byDate: Record<string, number>, today: string, keep: string[] = []): Record<string, number> => {
  const oldest = addDays(today, -D2C_LIMITS.REF_SERIAL_KEEP_DAYS);
  return Object.fromEntries(Object.entries(byDate).filter(([d]) => d >= oldest || keep.includes(d)));
};

/** Next transfer serial of the month (back to 1 in a new month). */
export const nextTransferSerial = (state: { month: string | null; last: number }, month: string): { month: string; last: number } =>
  ({ month, last: state.month === month ? Number(state.last || 0) + 1 : 1 });

// ---- database ----------------------------------------------------------------------------------------------------

type Q = Pick<EntityManager, 'query'>;
type RefState = { byDate: Record<string, number> };
type CodeState = { month: string | null; last: number };

/**
 * Locks an app_state row (seeded by the migration) and returns its value. Only when the row is missing is it added
 * first: an INSERT IGNORE on an existing row would take a shared lock, and two saves upgrading it would deadlock.
 */
const lockState = async <T>(m: EntityManager, key: string, fallback: T): Promise<T> => {
  const select = () => m.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ? FOR UPDATE`, [key]);
  let [row] = await select();
  if (!row) {
    await m.query(`INSERT IGNORE INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW())`, [key, JSON.stringify(fallback)]);
    [row] = await select();
  }
  return jsonOf<T>(row?.value, fallback);
};

const saveState = (m: EntityManager, key: string, value: unknown) =>
  m.query(`UPDATE ${TABLES.APP_STATE} SET value = CAST(? AS JSON), updated_at = NOW() WHERE state_key = ?`, [JSON.stringify(value), key]);

/** MySQL errors that mean "PEPIMS is not on this server" (the test database, a laptop copy): read as 0, logged. */
const PEPIMS_ABSENT = new Set(['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR']);

/** PEPIMS's highest reference serial of a PO date (read only; plan 2.7). */
export const pepimsMaxSerial = async (q: Q, day: string): Promise<number> => {
  try {
    const rows = await q.query<{ poNumber: string | null }[]>(
      `SELECT poNumber FROM \`${PEPIMS_DATABASE}\`.\`${D2C_PEPIMS_SHIPMENT_ORDERS}\` WHERE poNumber LIKE ?`,
      [`%|${refDateToken(day)}|%`],
    );
    return rows.reduce((max, r) => Math.max(max, serialOfReference(String(r.poNumber ?? ''), day) ?? 0), 0);
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (!PEPIMS_ABSENT.has(code)) throw err;
    log.warn(LOG_SOURCE.DB, '[d2c] PEPIMS shipment_orders not readable here: its reference serials are not checked', { code });
    return 0;
  }
};

/** Reference serials of one transaction: the row stays locked until it commits; PEPIMS read once per day. */
export class RefSerials {
  private pepims = new Map<string, number>();
  private taken: string[] = [];

  private constructor(private m: EntityManager, private state: RefState, private readPepims: boolean, private today: string) {}

  static async open(m: EntityManager, settings: D2cSettings, today: string): Promise<RefSerials> {
    const state = await lockState<RefState>(m, D2C_STATE_KEY.REF_SERIAL, { byDate: {} });
    return new RefSerials(m, { byDate: { ...(state.byDate ?? {}) } }, shouldReadPepims(settings.cutoverDate, today), today);
  }

  async take(day: string): Promise<number> {
    if (this.readPepims && !this.pepims.has(day)) this.pepims.set(day, await pepimsMaxSerial(this.m, day));
    const next = nextRefSerial(Number(this.state.byDate[day] ?? 0), this.pepims.get(day) ?? 0);
    this.state.byDate[day] = next;
    this.taken.push(day);
    return next;
  }

  async save(): Promise<void> {
    await saveState(this.m, D2C_STATE_KEY.REF_SERIAL, { byDate: pruneByDate(this.state.byDate, this.today, this.taken) });
  }
}

/** `n` transfer codes for transfers created today, in order. */
export const takeTransferCodes = async (m: EntityManager, today: string, n: number): Promise<string[]> => {
  let state = await lockState<CodeState>(m, D2C_STATE_KEY.TRANSFER_CODE, { month: null, last: 0 });
  const month = d2cTransferMonth(today);
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    state = nextTransferSerial(state, month);
    codes.push(d2cTransferCode(today, state.last));
  }
  await saveState(m, D2C_STATE_KEY.TRANSFER_CODE, state);
  return codes;
};

/**
 * The reference IDs the next saves would get, without a lock (preview: "may change on save"). `wanted` in save order;
 * serials of the same day follow each other.
 */
export const peekReferences = async (
  wanted: { prefix: string; poDate: string; type: string }[],
  settings: D2cSettings,
  today: string,
  q: Q = AppDataSource.manager,
): Promise<string[]> => {
  if (!wanted.length) return [];
  const [row] = await q.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [D2C_STATE_KEY.REF_SERIAL]);
  const byDate = { ...(jsonOf<RefState>(row?.value, { byDate: {} }).byDate ?? {}) };
  const read = shouldReadPepims(settings.cutoverDate, today);
  const pepims = new Map<string, number>();
  const out: string[] = [];
  for (const w of wanted) {
    if (read && !pepims.has(w.poDate)) pepims.set(w.poDate, await pepimsMaxSerial(q, w.poDate));
    const next = nextRefSerial(Number(byDate[w.poDate] ?? 0), pepims.get(w.poDate) ?? 0);
    byDate[w.poDate] = next;
    out.push(d2cReferenceId(w.prefix, w.poDate, w.type, next));
  }
  return out;
};

/**
 * The next Uniware SO code erp_it_<yyyymmdd><NNN> (user, 2026-11-03: own daily counter, app_state d2c:so-serial
 * { byDate: { 'YYYYMMDD': n } }, separate from the channel POs' erp_ codes). Locked in the caller's transaction (the
 * create-SO reserve); days older than REF_SERIAL_KEEP_DAYS are dropped.
 */
export const takeSoCode = async (m: EntityManager, today: string): Promise<string> => {
  const state = await lockState<RefState>(m, D2C_STATE_KEY.SO_SERIAL, { byDate: {} });
  const key = today.replace(/-/g, '');
  const next = Number(state.byDate?.[key] ?? 0) + 1;
  const oldest = addDays(today, -D2C_LIMITS.REF_SERIAL_KEEP_DAYS).replace(/-/g, '');
  const byDate = Object.fromEntries(Object.entries({ ...(state.byDate ?? {}), [key]: next }).filter(([d]) => d >= oldest));
  await saveState(m, D2C_STATE_KEY.SO_SERIAL, { byDate });
  return d2cSaleOrderCode(today, next);
};
