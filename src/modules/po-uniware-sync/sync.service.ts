import { randomUUID } from 'crypto';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { EntityManager } from 'typeorm';
import {
  ERROR_CODES, PO_UNIWARE_SYNC, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES, UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING, UPLOAD_STATUS,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { MasterPurchaseOrder, ShipmentLog } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { flushChanges } from '../po-overview/po-overview.live';
import { bumpReview } from '../po-review/po-review.live';
import { nextDelayOf, runGentle, withRunLock } from './pacing';
import { planPoSync, PoSyncState } from './plan';
import { readSaleOrder, SoDetail } from './sale-order';
import { isThrottled, poUniwareClient, UniwarePoster } from './uniware-client';

/*
 * Uniware sale order status of CHANNEL POs (2026-11-06, constants/po-uniware-sync.ts). The same way as D2C transfers,
 * read-only, with our OWN Uniware client, saleorder/get parser, pacing and lock (uniware-client.ts, sale-order.ts,
 * pacing.ts; user: not Ajay's code):
 *   - which: master_purchase_orders with transferCode NULL, an SO code (orderNo1) and a facility, not done in Uniware
 *     (uniwareDoneAt, set from Uniware's OWN answer: never a status a person typed) or done less than AFTER_DONE_DAYS
 *     ago; a timed run reads each when it is due (dueSql: in Uniware every EVERY_MIN, not in Uniware yet less often as
 *     it ages, marked uploaded since its last read at once, done once a day); never read / just uploaded first, then
 *     the oldest read, MAX_PER_RUN at most;
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

const jsonOf = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

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

const STATE_COLS: (keyof PoSyncState)[] = [
  'statusPlanning', 'statusWarehouse', 'statusLogistics', 'rtsDate', 'dispatchDate', 'invoiceChallanNumber', 'invoiceDate', 'invoiceValue', 'uniwareStatus', 'syncError',
];

/** A PO to read, with what is stored now (so an answer that changes nothing needs no transaction). */
interface Candidate { uid: string; orderNo1: string; facility: string; state: PoSyncState; doneAt: Date | null; uploadedAt: Date | null }

const dateOrNull = (v: unknown): Date | null => (v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : null);

/**
 * When a timed run reads a PO (2026-11-09, constants/po-uniware-sync.ts). `m` = master_purchase_orders, `up.uploadedAt` =
 * its latest "uploaded into Uniware" mark. Returns the SQL condition + its arguments.
 */
const dueSql = (now: Date): { sql: string; args: unknown[] } => {
  const ago = (min: number) => new Date(now.getTime() - (min - PO_UNIWARE_SYNC.FRESH_SLACK_MIN) * 60_000);
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const S = PO_UNIWARE_SYNC;
  const notIn = 'm.uniwareStatus IN (?, ?)';
  return {
    sql: `(m.lastSyncedAt IS NULL
      OR (up.uploadedAt IS NOT NULL AND up.uploadedAt > m.lastSyncedAt)
      OR (m.uniwareDoneAt IS NOT NULL AND m.lastSyncedAt < ?)
      OR (m.uniwareDoneAt IS NULL AND (m.uniwareStatus IS NULL OR NOT ${notIn}) AND m.lastSyncedAt < ?)
      OR (m.uniwareDoneAt IS NULL AND ${notIn} AND up.uploadedAt IS NOT NULL AND m.lastSyncedAt < ?)
      OR (m.uniwareDoneAt IS NULL AND ${notIn} AND m.lastSyncedAt < CASE
            WHEN COALESCE(m.createdAt, m.lastSyncedAt) > ? THEN ?
            WHEN COALESCE(m.createdAt, m.lastSyncedAt) > ? THEN ? ELSE ? END))`,
    args: [
      ago(S.AFTER_DONE_EVERY_MIN),
      UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING, ago(S.EVERY_MIN),
      UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING, ago(S.NOT_FOUND_EVERY_MIN),
      UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING,
      daysAgo(S.NOT_FOUND_YOUNG_DAYS), ago(S.NOT_FOUND_EVERY_MIN), daysAgo(S.NOT_FOUND_OLD_DAYS), ago(S.NOT_FOUND_MID_EVERY_MIN), ago(S.NOT_FOUND_OLD_EVERY_MIN),
    ],
  };
};

/**
 * The "Sync from Uniware" button (2026-11-09): only what can move. In Uniware and not finished (not read a moment ago),
 * marked uploaded but not seen in Uniware yet (or since the mark), downloaded and never read.
 */
const buttonSql = (now: Date): { sql: string; args: unknown[] } => ({
  sql: `m.uniwareDoneAt IS NULL AND (
      (m.uniwareStatus IS NOT NULL AND m.uniwareStatus NOT IN (?, ?) AND (m.lastSyncedAt IS NULL OR m.lastSyncedAt < ?))
      OR (up.uploadedAt IS NOT NULL AND (m.uniwareStatus IS NULL OR m.uniwareStatus IN (?, ?) OR m.lastSyncedAt IS NULL OR up.uploadedAt > m.lastSyncedAt))
      OR (m.lastSyncedAt IS NULL AND up.downloadedAt IS NOT NULL))`,
  args: [UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING, new Date(now.getTime() - PO_UNIWARE_SYNC.BUTTON_FRESH_MIN * 60_000), UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING],
});

/** The POs to read now (manual = also the ones read a moment ago; button = only what can move). */
const candidates = async (o: PoSyncRunOptions, now = new Date()): Promise<Candidate[]> => {
  const args: unknown[] = [new Date(now.getTime() - PO_UNIWARE_SYNC.AFTER_DONE_DAYS * 86_400_000), UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING];
  // never downloaded, not marked uploaded and not known to Uniware: it cannot be in Uniware, so it is never asked
  let sql = `SELECT m.uid, m.orderNo1, m.facility, m.uniwareDoneAt, up.uploadedAt, ${STATE_COLS.map((c) => `m.${c}`).join(', ')}
    FROM ${TABLES.MASTER_PURCHASE_ORDERS} m
    LEFT JOIN (SELECT po_uid, MAX(uniware_uploaded_at) uploadedAt, MAX(csv_downloaded_at) downloadedAt FROM ${TABLES.PO_UPLOADS}
               WHERE po_uid IS NOT NULL GROUP BY po_uid) up ON up.po_uid = m.uid
    WHERE m.transferCode IS NULL AND m.orderNo1 IS NOT NULL AND m.orderNo1 <> '' AND m.facility IS NOT NULL AND m.facility <> ''
      AND (m.uniwareDoneAt IS NULL OR m.uniwareDoneAt > ?)
      AND (up.downloadedAt IS NOT NULL OR up.uploadedAt IS NOT NULL OR (m.uniwareStatus IS NOT NULL AND m.uniwareStatus NOT IN (?, ?)))`;
  if (o.uids?.length) {
    sql += ' AND m.uid IN (?)';
    args.push(o.uids);
  }
  if (o.button && !o.uids?.length) {
    const b = buttonSql(now);
    sql += ` AND ${b.sql}`;
    args.push(...b.args);
  } else if (!o.manual) {
    const due = dueSql(now);
    sql += ` AND ${due.sql}`;
    args.push(...due.args);
  }
  // never read and just uploaded first, then the oldest read
  sql += ' ORDER BY (m.lastSyncedAt IS NULL OR (up.uploadedAt IS NOT NULL AND up.uploadedAt > m.lastSyncedAt)) DESC, m.lastSyncedAt LIMIT ?';
  args.push(PO_UNIWARE_SYNC.MAX_PER_RUN);
  const found = await AppDataSource.query<(Record<string, unknown> & { uid: string | number; orderNo1: string; facility: string })[]>(sql, args);
  return found.map((r) => ({
    uid: String(r.uid), orderNo1: r.orderNo1, facility: r.facility, doneAt: dateOrNull(r.uniwareDoneAt), uploadedAt: dateOrNull(r.uploadedAt),
    state: Object.fromEntries(STATE_COLS.map((k) => [k, r[k] ?? null])) as unknown as PoSyncState,
  }));
};

// ---- one PO ------------------------------------------------------------------------------------------------------------

/** shipment_logs rows of one PO (source uniware). */
const writeLogs = async (m: EntityManager, uid: string, logs: { field: string; oldValue: unknown; newValue: unknown }[], uniwareStatus: string) => {
  if (!logs.length) return;
  const text = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  };
  const batchId = randomUUID();
  await m.getRepository(ShipmentLog).insert(logs.map((l) => ({
    shipmentUid: uid, userId: null, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source: SHIPMENT_LOG_SOURCE.UNIWARE, fieldName: l.field, lineId: null,
    batchId, oldValue: text(l.oldValue), newValue: text(l.newValue), remark: null, uniwareStatus,
  })));
};

/** Applies one answer to the PO as stored now (row locked). Returns whether anything people see changed. */
const applyAnswer = async (c: Candidate, so: SoDetail | null, now = new Date()): Promise<{ changed: boolean; done: boolean }> =>
  AppDataSource.transaction(async (m) => {
    const repo = m.getRepository(MasterPurchaseOrder);
    const row = await repo.findOne({ where: { uid: c.uid }, lock: { mode: 'pessimistic_write' } });
    // gone, or its SO code changed meanwhile (e.g. re-punch): this answer is not about it any more
    if (!row || row.orderNo1 !== c.orderNo1 || row.transferCode !== null) return { changed: false, done: false };
    const state = Object.fromEntries(STATE_COLS.map((k) => [k, row[k as keyof MasterPurchaseOrder]])) as unknown as PoSyncState;
    const plan = planPoSync(state, so, now, { uploadedAt: c.uploadedAt, wasDone: !!row.uniwareDoneAt });
    // done by Uniware's own answer: from now on only the after-care reads
    const doneNow = plan.done && !row.uniwareDoneAt ? { uniwareDoneAt: now } : {};
    await repo.update({ uid: c.uid }, { ...plan.set, ...doneNow, lastSyncedAt: now, ...(plan.logs.length ? { updatedAt: now } : {}) });
    await writeLogs(m, c.uid, plan.logs, plan.uniwareText);
    return { changed: plan.logs.length > 0, done: plan.done };
  });

/** A Uniware error on one PO: kept on the row (syncError), the run goes on. */
const saveError = (uid: string, text: string, now: Date) =>
  AppDataSource.getRepository(MasterPurchaseOrder).update({ uid }, { syncError: text.slice(0, 2000), lastSyncedAt: now });

/** POs whose answer changed nothing: only "read at", in one UPDATE per TOUCH_CHUNK. */
const touch = async (uids: string[], now: Date) => {
  for (let i = 0; i < uids.length; i += PO_UNIWARE_SYNC.TOUCH_CHUNK) {
    await AppDataSource.query(`UPDATE ${TABLES.MASTER_PURCHASE_ORDERS} SET lastSyncedAt = ? WHERE uid IN (?)`, [now, uids.slice(i, i + PO_UNIWARE_SYNC.TOUCH_CHUNK)]);
  }
};

/**
 * Uniware has the sale order but nobody clicked "Mark uploaded" (2026-11-09, user: "get that data from Uniware to mark
 * uploaded"): the PO's completed upload is marked uploaded (no person: uniware_uploaded_by NULL) + a History row, so it
 * shows in PO Overview. Not when a person removed the mark before (an upload-undone row). Nothing is sent to Uniware.
 */
const markFoundInUniware = async (now: Date): Promise<number> => {
  const found = await AppDataSource.query<{ id: string | number; po_uid: string | number; orderNo1: string }[]>(
    `SELECT u.id, u.po_uid, m.orderNo1 FROM ${TABLES.PO_UPLOADS} u JOIN ${TABLES.MASTER_PURCHASE_ORDERS} m ON m.uid = u.po_uid
      WHERE u.status = ? AND u.uniware_uploaded_at IS NULL AND m.transferCode IS NULL
        AND m.uniwareStatus IS NOT NULL AND m.uniwareStatus NOT IN (?, ?)
        AND NOT EXISTS (SELECT 1 FROM ${TABLES.SHIPMENT_LOGS} s WHERE s.shipment_uid = m.uid AND s.action = ?)`,
    [UPLOAD_STATUS.COMPLETED, UNIWARE_NOT_FOUND, UNIWARE_UPLOADED_MISSING, SHIPMENT_LOG_ACTION.UNIWARE_UPLOAD_UNDONE],
  );
  if (!found.length) return 0;
  await AppDataSource.transaction(async (m) => {
    await m.query(`UPDATE ${TABLES.PO_UPLOADS} SET uniware_uploaded_at = ? WHERE id IN (?) AND uniware_uploaded_at IS NULL`, [now, found.map((f) => f.id)]);
    await m.getRepository(ShipmentLog).insert([...new Map(found.map((f) => [String(f.po_uid), f])).values()].map((f) => ({
      shipmentUid: String(f.po_uid), userId: null, action: SHIPMENT_LOG_ACTION.UNIWARE_UPLOADED, source: SHIPMENT_LOG_SOURCE.UNIWARE,
      remark: `${f.orderNo1} ${PO_UNIWARE_SYNC.FOUND_REMARK}`,
    })));
  });
  bumpReview();
  return found.length;
};

// ---- a run -------------------------------------------------------------------------------------------------------------

/** manual = Sync now (also POs read a moment ago); button = the PO Overview button (only what can move); uids = these POs. */
export interface PoSyncRunOptions { uids?: string[]; manual?: boolean; button?: boolean }

export const runPoSyncPass = async (o: PoSyncRunOptions, api: UniwarePoster = poUniwareClient()) => {
  const startedAt = new Date().toISOString();
  const before = await readRecord();
  const list = await candidates(o);
  const counts: Record<string, number> = { picked: list.length, read: 0, notInUniware: 0, changed: 0, done: 0, errors: 0, notStarted: 0 };
  let logged = false;
  const unchanged: string[] = [];
  const result = await runGentle(list, { concurrency: PO_UNIWARE_SYNC.CONCURRENCY, gapMs: PO_UNIWARE_SYNC.CALL_GAP_MS }, async (c) => {
    try {
      const so = await readSaleOrder(api, c.orderNo1, c.facility);
      counts.read++;
      if (!so) counts.notInUniware++;
      // nothing to change on what is stored: no transaction, only "read at" (in bulk, below)
      const quick = planPoSync(c.state, so, new Date(), { uploadedAt: c.uploadedAt, wasDone: !!c.doneAt });
      if (!Object.keys(quick.set).length && !(quick.done && !c.doneAt)) {
        unchanged.push(c.uid);
        if (quick.done) counts.done++;
        return;
      }
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
  await touch(unchanged, new Date()).catch((err) => logError(LOG_SOURCE.APP, `${LOG} could not save "read at" of ${unchanged.length} PO(s)`, err));
  // in Uniware but never marked uploaded (this run's answers and earlier ones): marked now, so they show in PO Overview
  const marked = await markFoundInUniware(new Date()).catch((err) => { logError(LOG_SOURCE.APP, `${LOG} could not mark the POs found in Uniware`, err); return 0; });
  Object.assign(counts, { markedUploaded: marked });
  if (logged || marked) void flushChanges();
  // nothing read at all while there was something to read = the run failed (Uniware down / login refused / 429)
  const failed = result.throttled || (list.length > 0 && counts.read === 0);
  const error = result.throttled ? 'Uniware answered 429 (too many requests): the rest next time' : failed ? 'no PO could be read from Uniware' : null;
  const nextDelayMin = nextDelayOf(PO_UNIWARE_SYNC.EVERY_MIN, failed, before.lastError ? before.nextDelayMin : null);
  const endedAt = new Date().toISOString();
  await saveRecord({ lastStartedAt: startedAt, lastEndedAt: endedAt, lastOkAt: failed ? before.lastOkAt : endedAt, lastError: error, counts, nextDelayMin, trigger: o.button ? 'button' : o.manual ? 'manual' : 'timer' })
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
  !a ? b : { uids: a.uids?.length && b.uids?.length ? [...new Set([...a.uids, ...b.uids])] : undefined, manual: !!(a.manual || b.manual), button: !!(a.button || b.button) };

const loop = async (o: PoSyncRunOptions): Promise<void> => {
  if (running) {
    pending = merge(pending, o);
    return;
  }
  running = true;
  nextRunAt = null;
  let waitMin: number = PO_UNIWARE_SYNC.EVERY_MIN;
  try {
    const r = await withRunLock(PO_UNIWARE_SYNC.LOCK, () => runJob(PO_UNIWARE_SYNC.JOB, () => runPoSyncPass(o), { trigger: o.manual ? 'manual' : 'timer' }), o.manual ? 5 : 0);
    if (!r) log.info(LOG_SOURCE.APP, `${LOG} another server is running it: skipped`);
    else {
      waitMin = r.nextDelayMin;
      lastWaitMin = r.failed ? r.nextDelayMin : null;
    }
  } catch (err) {
    waitMin = nextDelayOf(waitMin, true, lastWaitMin);
    lastWaitMin = waitMin;
    logError(LOG_SOURCE.APP, `${LOG} run failed, next try in ${waitMin} min`, err);
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
/** The last button click (whole team): { at ISO, by email }. */
interface ButtonClick { at: string | null; by: string | null }
const readButton = async (): Promise<ButtonClick> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [PO_UNIWARE_SYNC.BUTTON_STATE_KEY]);
  return { at: null, by: null, ...jsonOf<Partial<ButtonClick>>(row?.value, {}) };
};
/**
 * Takes the click for this person when the last one is BUTTON_EVERY_MIN or more ago: one conditional UPDATE, so two
 * clicks at the same moment cannot both pass. False = too soon.
 */
const takeButton = async (by: string, now: Date): Promise<boolean> => {
  const key = PO_UNIWARE_SYNC.BUTTON_STATE_KEY;
  await AppDataSource.query(`INSERT IGNORE INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW())`, [key, JSON.stringify({ at: null, by: null })]);
  const cutoff = new Date(now.getTime() - PO_UNIWARE_SYNC.BUTTON_EVERY_MIN * 60_000).toISOString();
  const r = await AppDataSource.query<{ affectedRows?: number }>(
    `UPDATE ${TABLES.APP_STATE} SET value = CAST(? AS JSON), updated_at = NOW()
      WHERE state_key = ? AND (JSON_EXTRACT(value, '$.at') IS NULL OR JSON_TYPE(JSON_EXTRACT(value, '$.at')) = 'NULL' OR JSON_UNQUOTE(JSON_EXTRACT(value, '$.at')) <= ?)`,
    [JSON.stringify({ at: now.toISOString(), by }), key, cutoff],
  );
  return (r.affectedRows ?? 0) > 0;
};

export const poSyncStatus = async () => {
  const [r, click] = await Promise.all([readRecord(), readButton()]);
  const okAt = r.lastOkAt ? Date.parse(r.lastOkAt) : null;
  const clickAt = click.at ? Date.parse(click.at) : null;
  const nextAt = clickAt ? clickAt + PO_UNIWARE_SYNC.BUTTON_EVERY_MIN * 60_000 : null;
  return {
    ...r, timerOn: started, running, queued: pending !== null, nextRunAt: nextRunAt?.toISOString() ?? null, everyMinutes: PO_UNIWARE_SYNC.EVERY_MIN,
    minutesAgo: okAt ? Math.max(0, Math.floor((Date.now() - okAt) / 60_000)) : null, notFoundText: UNIWARE_NOT_FOUND,
    // the button: when it was last clicked, by whom, and when it can be clicked again (null = now)
    button: {
      lastAt: click.at, lastBy: click.by, everyMinutes: PO_UNIWARE_SYNC.BUTTON_EVERY_MIN,
      nextAt: nextAt && nextAt > Date.now() ? new Date(nextAt).toISOString() : null,
    },
  };
};

/**
 * POST /po-overview/uniware-sync { uids? } -> 202 { state: started | queued, ...status }. Without uids = the button: one
 * click per BUTTON_EVERY_MIN for the whole team (409 UNIWARE_SYNC_TOO_SOON), reads only what can move.
 */
export const startPoSync = async (body: unknown, by = 'someone') => {
  const b = (body && typeof body === 'object' ? body : {}) as { uids?: unknown };
  if (b.uids !== undefined && (!Array.isArray(b.uids) || !b.uids.every((u) => /^[1-9]\d{0,18}$/.test(String(u))))) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'uids', code: ERROR_CODES.FIELD_REQUIRED, message: 'uids must be a list of PO uids' }]);
  }
  const uids = Array.isArray(b.uids) ? [...new Set(b.uids.map(String))] : undefined;
  if (uids && uids.length > PO_UNIWARE_SYNC.MANUAL_MAX_IDS) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'uids', code: ERROR_CODES.FIELD_OUT_OF_RANGE, message: `at most ${PO_UNIWARE_SYNC.MANUAL_MAX_IDS} POs at a time` }]);
  }
  const button = !uids?.length;
  if (button && !(await takeButton(by, new Date()))) {
    const click = await readButton();
    const ago = click.at ? Math.max(0, Math.floor((Date.now() - Date.parse(click.at)) / 60_000)) : 0;
    throw appError(ERROR_CODES.UNIWARE_SYNC_TOO_SOON, ago, click.by ?? 'someone', Math.max(1, PO_UNIWARE_SYNC.BUTTON_EVERY_MIN - ago));
  }
  const o: PoSyncRunOptions = { uids: uids?.length ? uids : undefined, manual: true, button };
  let state: 'started' | 'queued' = 'started';
  if (running) { pending = merge(pending, o); state = 'queued'; } else { clearTimeout(timer); void loop(o); }
  return { state, ...(await poSyncStatus()) };
};
