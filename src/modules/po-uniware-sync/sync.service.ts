import { randomUUID } from 'crypto';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  D2C_UNIWARE, ERROR_CODES, PO_UNIWARE_SYNC, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES, UNIWARE_NOT_FOUND, UNIWARE_SO_DONE,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { MasterPurchaseOrder } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { jsonOf } from '../d2c-transfers/settings';
import { isThrottled, nextDelayOf, runGentle, soDetailOf, SoDetail } from '../d2c-transfers/sync-plan';
import { writeLogs } from '../d2c-transfers/transfers.service';
import { refusalOf, uniwareClient, UniwarePoster } from '../d2c-transfers/uniware-transfers';
import { withLock } from '../intransit/s3/lock';
import { flushChanges } from '../po-overview/po-overview.live';
import { planPoSync, PoSyncState } from './plan';

/*
 * Uniware sale order status of CHANNEL POs (2026-11-06, constants/po-uniware-sync.ts). The same way as D2C transfers
 * (d2c-transfers/sync.service.ts, whose Uniware client, saleorder/get parser and pacing it reuses), read-only:
 *   - which: master_purchase_orders with transferCode NULL, an SO code (orderNo1) and a facility, not done yet (Uniware
 *     COMPLETE / CANCELLED, or Status (Warehouse) already Dispatched); a timed run skips the ones read within the last
 *     EVERY_MIN - FRESH_SLACK_MIN minutes; oldest read first, MAX_PER_RUN at most;
 *   - per PO: saleorder/get with Facility = the PO's facility, OUTSIDE any transaction; then in one transaction the row
 *     FOR UPDATE, planPoSync on what is stored NOW, only the changed fields + lastSyncedAt, History rows (source uniware);
 *   - INVALID_SALE_ORDER_CODE = not uploaded yet: uniwareStatus "Not in Uniware yet", read again next time;
 *   - 2 at a time with a pause (the API user is shared with in-transit / D2C); a 429 that outlives the retries stops the
 *     run (the rest next time) and the next one waits twice as long (at most 2 h);
 *   - every EVERY_MIN minutes on the server (not on a laptop, not with PO_UNIWARE_SYNC_ENABLED=false); "Sync now" from
 *     PO Overview at any time (also on a laptop: it only reads).
 */

const LOG = '[po-uniware-sync]';

export interface PoSyncRecord {
  lastStartedAt: string | null; lastEndedAt: string | null; lastOkAt: string | null; lastError: string | null;
  counts: Record<string, number>; nextDelayMin: number | null; trigger: string | null;
}
const EMPTY: PoSyncRecord = { lastStartedAt: null, lastEndedAt: null, lastOkAt: null, lastError: null, counts: {}, nextDelayMin: null, trigger: null };

const readRecord = async (): Promise<PoSyncRecord> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [PO_UNIWARE_SYNC.STATE_KEY]);
  return { ...EMPTY, ...jsonOf<Partial<PoSyncRecord>>(row?.value, {}) };
};
const saveRecord = (r: PoSyncRecord) => AppDataSource.query(
  `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW())
   ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
  [PO_UNIWARE_SYNC.STATE_KEY, JSON.stringify(r)],
);

// ---- which POs ---------------------------------------------------------------------------------------------------------

interface Candidate { uid: string; orderNo1: string; facility: string }

/** The POs to read now (manual = also the ones read a moment ago). */
const candidates = async (o: { uids?: string[]; manual?: boolean }, now = new Date()): Promise<Candidate[]> => {
  const done = UNIWARE_SO_DONE.map((s) => `${s}%`);
  const args: unknown[] = [...done, 'Dispatched'];
  let sql = `SELECT uid, orderNo1, facility FROM ${TABLES.MASTER_PURCHASE_ORDERS}
    WHERE transferCode IS NULL AND orderNo1 IS NOT NULL AND orderNo1 <> '' AND facility IS NOT NULL AND facility <> ''
      AND (uniwareStatus IS NULL OR (${done.map(() => 'uniwareStatus NOT LIKE ?').join(' AND ')}))
      AND (statusWarehouse IS NULL OR statusWarehouse <> ?)`;
  if (o.uids?.length) {
    sql += ' AND uid IN (?)';
    args.push(o.uids);
  }
  if (!o.manual) {
    sql += ' AND (lastSyncedAt IS NULL OR lastSyncedAt < ?)';
    args.push(new Date(now.getTime() - (PO_UNIWARE_SYNC.EVERY_MIN - PO_UNIWARE_SYNC.FRESH_SLACK_MIN) * 60_000));
  }
  sql += ' ORDER BY lastSyncedAt IS NOT NULL, lastSyncedAt LIMIT ?';
  args.push(PO_UNIWARE_SYNC.MAX_PER_RUN);
  return (await AppDataSource.query<Candidate[]>(sql, args)).map((r) => ({ uid: String(r.uid), orderNo1: r.orderNo1, facility: r.facility }));
};

// ---- one PO ------------------------------------------------------------------------------------------------------------

/** saleorder/get: the parsed SO, or null when Uniware does not know the code (not uploaded yet). Other errors throw. */
const readSaleOrder = async (api: UniwarePoster, code: string, facility: string): Promise<SoDetail | null> => {
  try {
    const body = await api.post<{ saleOrderDTO?: Record<string, unknown> }>(D2C_UNIWARE.GET_SO, { code }, facility);
    return body.saleOrderDTO ? soDetailOf(body.saleOrderDTO) : null;
  } catch (err) {
    const r = refusalOf(err);
    if (r && r.messages.some((m) => m.includes(D2C_UNIWARE.INVALID_SALE_ORDER_CODE))) return null;
    throw err;
  }
};

const STATE_COLS: (keyof PoSyncState)[] = [
  'statusPlanning', 'statusWarehouse', 'statusLogistics', 'rtsDate', 'dispatchDate', 'invoiceChallanNumber', 'invoiceDate', 'invoiceValue', 'uniwareStatus', 'syncError',
];

/** Applies one answer to the PO as stored now (row locked). Returns whether anything people see changed. */
const applyAnswer = async (c: Candidate, so: SoDetail | null, now = new Date()): Promise<{ changed: boolean; done: boolean }> =>
  AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(MasterPurchaseOrder);
    const row = await repo.findOne({ where: { uid: c.uid }, lock: { mode: 'pessimistic_write' } });
    // gone, or its SO code changed meanwhile (e.g. re-punch): this answer is not about it any more
    if (!row || row.orderNo1 !== c.orderNo1 || row.transferCode !== null) return { changed: false, done: false };
    const state = Object.fromEntries(STATE_COLS.map((k) => [k, row[k as keyof MasterPurchaseOrder]])) as unknown as PoSyncState;
    const plan = planPoSync(state, so, now);
    await repo.update({ uid: c.uid }, { ...plan.set, lastSyncedAt: now, ...(plan.logs.length ? { updatedAt: now } : {}) });
    await writeLogs(m, plan.logs.map((l) => ({
      uid: c.uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, field: l.field, oldValue: l.oldValue, newValue: l.newValue, uniwareStatus: plan.uniwareText,
    })), randomUUID(), null, SHIPMENT_LOG_SOURCE.UNIWARE);
    return { changed: plan.logs.length > 0, done: plan.done };
  });

/** A Uniware error on one PO: kept on the row (syncError), the run goes on. */
const saveError = (uid: string, text: string, now: Date) =>
  AppDataSource.getRepository(MasterPurchaseOrder).update({ uid }, { syncError: text.slice(0, 2000), lastSyncedAt: now });

// ---- a run -------------------------------------------------------------------------------------------------------------

export interface PoSyncRunOptions { uids?: string[]; manual?: boolean }

export const runPoSyncPass = async (o: PoSyncRunOptions, api: UniwarePoster = uniwareClient()) => {
  const startedAt = new Date().toISOString();
  const before = await readRecord();
  const list = await candidates(o);
  const counts = { picked: list.length, read: 0, notInUniware: 0, changed: 0, done: 0, errors: 0, notStarted: 0 };
  let logged = false;
  const result = await runGentle(list, { concurrency: PO_UNIWARE_SYNC.CONCURRENCY, gapMs: PO_UNIWARE_SYNC.CALL_GAP_MS }, async (c) => {
    try {
      const so = await readSaleOrder(api, c.orderNo1, c.facility);
      counts.read++;
      if (!so) counts.notInUniware++;
      const r = await applyAnswer(c, so);
      if (r.changed) { counts.changed++; logged = true; }
      if (r.done) counts.done++;
    } catch (err) {
      if (isThrottled(err)) throw err;
      counts.errors++;
      await saveError(c.uid, err instanceof Error ? err.message : String(err), new Date()).catch(() => undefined);
    }
  });
  counts.notStarted = result.notStarted;
  if (logged) void flushChanges();
  // nothing read at all while there was something to read = the run failed (Uniware down / login refused / 429)
  const failed = result.throttled || (list.length > 0 && counts.read === 0);
  const error = result.throttled ? 'Uniware answered 429 (too many requests): the rest next time' : failed ? 'no PO could be read from Uniware' : null;
  const nextDelayMin = nextDelayOf(PO_UNIWARE_SYNC.EVERY_MIN, failed, before.lastError ? before.nextDelayMin : null);
  const endedAt = new Date().toISOString();
  await saveRecord({ lastStartedAt: startedAt, lastEndedAt: endedAt, lastOkAt: failed ? before.lastOkAt : endedAt, lastError: error, counts, nextDelayMin, trigger: o.manual ? 'manual' : 'timer' })
    .catch((err) => logError(LOG_SOURCE.APP, `${LOG} could not save its record`, err));
  log.info(LOG_SOURCE.APP, `${LOG} ${failed ? 'failed' : 'done'}: ${JSON.stringify(counts)}${error ? ` | ${error}` : ''}; next in ${nextDelayMin} min`);
  return { counts, failed, nextDelayMin };
};

// ---- timer + Sync now --------------------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
let started = false;
let running = false;
let pending: PoSyncRunOptions | null = null;
let nextRunAt: Date | null = null;
let lastWaitMin: number | null = null;

const schedule = (ms: number) => {
  if (!started) return;
  clearTimeout(timer);
  nextRunAt = new Date(Date.now() + ms);
  timer = setTimeout(() => void loop({}), ms);
};
const merge = (a: PoSyncRunOptions | null, b: PoSyncRunOptions): PoSyncRunOptions =>
  !a ? b : { uids: a.uids?.length && b.uids?.length ? [...new Set([...a.uids, ...b.uids])] : undefined, manual: !!(a.manual || b.manual) };

const loop = async (o: PoSyncRunOptions): Promise<void> => {
  if (running) {
    pending = merge(pending, o);
    return;
  }
  running = true;
  nextRunAt = null;
  let waitMin: number = PO_UNIWARE_SYNC.EVERY_MIN;
  try {
    const r = await withLock(PO_UNIWARE_SYNC.LOCK, () => runJob(PO_UNIWARE_SYNC.JOB, () => runPoSyncPass(o), { trigger: o.manual ? 'manual' : 'timer' }), o.manual ? 5 : 0);
    waitMin = r.nextDelayMin;
    lastWaitMin = r.failed ? r.nextDelayMin : null;
  } catch (err) {
    if (err instanceof AppError && err.code === ERROR_CODES.INTRANSIT_BUSY) log.info(LOG_SOURCE.APP, `${LOG} another server is running it: skipped`);
    else {
      waitMin = nextDelayOf(waitMin, true, lastWaitMin);
      lastWaitMin = waitMin;
      logError(LOG_SOURCE.APP, `${LOG} run failed, next try in ${waitMin} min`, err);
    }
  } finally {
    running = false;
  }
  if (pending) {
    const p = pending;
    pending = null;
    void loop(p);
    return;
  }
  schedule(waitMin * 60_000);
};

/** server.ts: every EVERY_MIN minutes. Off on a laptop and with PO_UNIWARE_SYNC_ENABLED=false (Sync now still works). */
export const startPoUniwareSync = (): { stop: () => void } | undefined => {
  if (!env.poUniwareSync.enabled) {
    log.info(LOG_SOURCE.APP, `${LOG} timer off (PO_UNIWARE_SYNC_ENABLED=false or laptop): Sync now still works`);
    return undefined;
  }
  started = true;
  schedule(PO_UNIWARE_SYNC.FIRST_DELAY_MS);
  log.info(LOG_SOURCE.APP, `${LOG} timer on (every ${PO_UNIWARE_SYNC.EVERY_MIN} min)`);
  return { stop: () => { started = false; clearTimeout(timer); nextRunAt = null; } };
};

/** GET /po-overview/uniware-sync: "Uniware · synced N min ago". */
export const poSyncStatus = async () => {
  const r = await readRecord();
  const okAt = r.lastOkAt ? Date.parse(r.lastOkAt) : null;
  return {
    ...r, timerOn: started, running, queued: pending !== null, nextRunAt: nextRunAt?.toISOString() ?? null, everyMinutes: PO_UNIWARE_SYNC.EVERY_MIN,
    minutesAgo: okAt ? Math.max(0, Math.floor((Date.now() - okAt) / 60_000)) : null, notFoundText: UNIWARE_NOT_FOUND,
  };
};

/** POST /po-overview/uniware-sync { uids? } -> 202 { state: started | queued, ...status }. */
export const startPoSync = async (body: unknown) => {
  const b = (body && typeof body === 'object' ? body : {}) as { uids?: unknown };
  if (b.uids !== undefined && (!Array.isArray(b.uids) || !b.uids.every((u) => /^[1-9]\d{0,18}$/.test(String(u))))) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'uids', code: ERROR_CODES.FIELD_REQUIRED, message: 'uids must be a list of PO uids' }]);
  }
  const uids = Array.isArray(b.uids) ? [...new Set(b.uids.map(String))] : undefined;
  if (uids && uids.length > PO_UNIWARE_SYNC.MANUAL_MAX_IDS) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'uids', code: ERROR_CODES.FIELD_OUT_OF_RANGE, message: `at most ${PO_UNIWARE_SYNC.MANUAL_MAX_IDS} POs at a time` }]);
  }
  const o: PoSyncRunOptions = { uids: uids?.length ? uids : undefined, manual: true };
  let state: 'started' | 'queued' = 'started';
  if (running) { pending = merge(pending, o); state = 'queued'; } else { clearTimeout(timer); void loop(o); }
  return { state, ...(await poSyncStatus()) };
};
