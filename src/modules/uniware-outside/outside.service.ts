import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  ERROR_CODES, errorMessage, IST_OFFSET_MS, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES, UNIWARE_OUTSIDE, UNIWARE_OUTSIDE_ACTION,
  UNIWARE_OUTSIDE_ACTIONS_FOR, UNIWARE_OUTSIDE_STATE, UNIWARE_OUTSIDE_TEXT, UniwareOutsideAction, UPLOAD_STATUS,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { ActivityLog, MasterPurchaseOrder, PoUpload, ShipmentLog, UniwareOutsideOrder } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { flushChanges } from '../po-overview/po-overview.live';
import { rejectPo } from '../po-review/po-review-actions.service';
import { bumpReview } from '../po-review/po-review.live';
import { withRunLock } from '../po-uniware-sync/pacing';
import { isThrottled, poUniwareClient, UniwarePoster } from '../po-uniware-sync/uniware-client';
import { B2bOrder, Candidate, findingsOf, kindOf, ordersOf, poKey } from './match';
import { outsideCounts } from './read';
import { forgetCache } from '../cache/cache.service';
import { CACHE_NS } from '../../constants/cache';

/*
 * POs punched in Uniware outside POST_FG (2026-11-25, constants/uniware-outside.ts). Read-only on Uniware.
 *   run: saleOrder/search { orderCategory B2B, CREATED window } one window at a time (STEP_HOURS each, MAX_CALLS_PER_RUN
 *        a run, a pause between, 429 = stop and keep the place), from the end of the last run less OVERLAP_MIN (first run:
 *        BACKFILL_DAYS back); then ONE grouped query finds the uploads with those PO numbers, match.ts decides, and ONE
 *        insert stores new findings (an unchanged one is not written again); the place is saved in app_state.
 *   timer: every EVERY_MIN on the server (not on a laptop, not with UNIWARE_OUTSIDE_ENABLED=false), one server at a time
 *        (MySQL lock); "Check now": one click per BUTTON_EVERY_MIN for the whole team.
 *   resolve: the person decides per finding (reject / use_code / acknowledge / dismiss), kept on the row.
 */

const LOG = '[uniware-outside]';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Actor { id: number; email: string }

interface RunRecord {
  /** Epoch ms up to which Uniware was read (the next run starts OVERLAP_MIN before it). */
  checkedTo: number | null;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  trigger: string | null;
  counts: { calls: number; orders: number; findings: number; newFindings: number; ms: number };
}
const EMPTY: RunRecord = {
  checkedTo: null, lastStartedAt: null, lastEndedAt: null, lastOkAt: null, lastError: null, trigger: null,
  counts: { calls: 0, orders: 0, findings: 0, newFindings: 0, ms: 0 },
};

const jsonOf = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};
const readState = async <T>(key: string, empty: T): Promise<T> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [key]);
  return { ...empty, ...jsonOf<Partial<T>>(row?.value, {}) };
};
const saveState = (key: string, value: unknown) => AppDataSource.query(
  `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW())
   ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
  [key, JSON.stringify(value)],
);

// ---- Uniware -----------------------------------------------------------------------------------------------------------

/** One saleOrder/search call: B2B orders created in [from, to). */
export const searchB2b = async (api: UniwarePoster, from: number, to: number): Promise<B2bOrder[]> => {
  const body = await api.post<{ elements?: unknown }>(UNIWARE_OUTSIDE.SEARCH, {
    orderCategory: UNIWARE_OUTSIDE.ORDER_CATEGORY, dateType: UNIWARE_OUTSIDE.DATE_TYPE, fromDate: from, toDate: to,
  });
  return ordersOf(body.elements);
};

// ---- DB ----------------------------------------------------------------------------------------------------------------

/** Uploads with these PO numbers that may warrant a finding, with their saved code and Uniware channels. One query per 500. */
const candidatesFor = async (poNumbers: string[]): Promise<Candidate[]> => {
  const out: Candidate[] = [];
  for (let i = 0; i < poNumbers.length; i += 500) {
    const part = poNumbers.slice(i, i + 500);
    const rows = await AppDataSource.query<{ id: string; status: string; po_number: string; uploaded_at: Date | null; orderNo1: string | null; codes: string | null }[]>(
      `SELECT u.id, u.status, u.po_number, u.uniware_uploaded_at AS uploaded_at, po.orderNo1, GROUP_CONCAT(DISTINCT dc.channel_code) AS codes
         FROM ${TABLES.PO_UPLOADS} u
         LEFT JOIN ${TABLES.MASTER_PURCHASE_ORDERS} po ON po.uid = u.po_uid
         LEFT JOIN ${TABLES.MASTER_CHANNELS} mc ON mc.display_name = u.channel
         LEFT JOIN ${TABLES.DETAILS_CHANNELS} dc ON dc.channel_id = mc.id AND dc.channel_code IS NOT NULL
        WHERE u.po_number IN (?) AND u.status IN (?, ?, ?, ?)
        GROUP BY u.id, u.status, u.po_number, u.uniware_uploaded_at, po.orderNo1`,
      [part, UPLOAD_STATUS.NEEDS_REVIEW, UPLOAD_STATUS.PENDING_APPROVAL, UPLOAD_STATUS.REJECTED, UPLOAD_STATUS.COMPLETED],
    );
    for (const r of rows) {
      out.push({
        uploadId: String(r.id), status: r.status, poNumber: r.po_number, uploaded: !!r.uploaded_at, orderNo1: r.orderNo1,
        uniwareChannels: (r.codes ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      });
    }
  }
  return out;
};

/** Stores the findings (one insert); an existing one only gets a new Uniware status / kind. Returns how many are new. */
const storeFindings = async (found: ReturnType<typeof findingsOf>): Promise<number> => {
  if (!found.length) return 0;
  const before = await AppDataSource.query<{ n: string }[]>(`SELECT COUNT(*) AS n FROM ${TABLES.UNIWARE_OUTSIDE_ORDERS}`);
  const values = found.map((f) => [
    f.order.code.slice(0, 100), f.order.channel.slice(0, 100), f.order.displayOrderCode.slice(0, 255), f.order.status?.slice(0, 50) ?? null,
    f.order.created ? new Date(f.order.created) : null, f.uploadId, f.kind,
  ]);
  await AppDataSource.query(
    `INSERT INTO ${TABLES.UNIWARE_OUTSIDE_ORDERS} (uniware_code, uniware_channel, display_order_code, uniware_status, uniware_created_at, upload_id, kind)
     VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
     ON DUPLICATE KEY UPDATE last_seen_at = IF(uniware_status <=> VALUES(uniware_status), last_seen_at, NOW()),
       uniware_status = VALUES(uniware_status), kind = IF(state = '${UNIWARE_OUTSIDE_STATE.OPEN}', VALUES(kind), kind)`,
    values.flat(),
  );
  const after = await AppDataSource.query<{ n: string }[]>(`SELECT COUNT(*) AS n FROM ${TABLES.UNIWARE_OUTSIDE_ORDERS}`);
  return Number(after[0]?.n ?? 0) - Number(before[0]?.n ?? 0);
};

// ---- a run -------------------------------------------------------------------------------------------------------------

/** The windows to read: from the last end (less the overlap) or BACKFILL_DAYS back, STEP_HOURS each, until now. */
export const windowsOf = (checkedTo: number | null, now: number): [number, number][] => {
  let from = checkedTo ? checkedTo - UNIWARE_OUTSIDE.OVERLAP_MIN * 60_000 : now - UNIWARE_OUTSIDE.BACKFILL_DAYS * DAY;
  const out: [number, number][] = [];
  while (from < now) {
    const to = Math.min(from + UNIWARE_OUTSIDE.STEP_HOURS * HOUR, now);
    out.push([from, to]);
    from = to;
  }
  return out;
};

export const runOutsideCheck = async (trigger: string, now = Date.now()): Promise<RunRecord> => {
  const before = await readState<RunRecord>(UNIWARE_OUTSIDE.STATE_KEY, EMPTY);
  const started = Date.now();
  const api = poUniwareClient();
  const windows = windowsOf(before.checkedTo, now).slice(0, UNIWARE_OUTSIDE.MAX_CALLS_PER_RUN);
  const orders: B2bOrder[] = [];
  let checkedTo = before.checkedTo;
  let calls = 0;
  let error: string | null = null;
  for (const [from, to] of windows) {
    if (calls > 0) await sleep(UNIWARE_OUTSIDE.CALL_GAP_MS);
    try {
      calls++;
      orders.push(...(await searchB2b(api, from, to)));
      checkedTo = to;
    } catch (err) {
      error = isThrottled(err) ? 'Uniware said too many requests (429): the rest next time' : err instanceof Error ? err.message.slice(0, 300) : String(err);
      break;
    }
  }
  const poNumbers = [...new Set(orders.map((o) => o.displayOrderCode).filter(Boolean))];
  // the DB keeps PO numbers as written; Uniware may differ in case / spaces: both spellings asked, match.ts compares by poKey
  const asked = [...new Set([...poNumbers, ...poNumbers.map(poKey)])];
  const found = asked.length ? findingsOf(orders, await candidatesFor(asked)) : [];
  const newFindings = await storeFindings(found);
  if (newFindings > 0) bumpReview();
  const ended = new Date().toISOString();
  const rec: RunRecord = {
    checkedTo, lastStartedAt: new Date(started).toISOString(), lastEndedAt: ended, lastOkAt: error ? before.lastOkAt : ended, lastError: error, trigger,
    counts: { calls, orders: orders.length, findings: found.length, newFindings, ms: Date.now() - started },
  };
  await saveState(UNIWARE_OUTSIDE.STATE_KEY, rec);
  log.info(LOG_SOURCE.APP, `${LOG} ${trigger}: ${calls} call(s), ${orders.length} B2B orders, ${found.length} finding(s), ${newFindings} new, ${rec.counts.ms} ms${error ? `, stopped: ${error}` : ''}`);
  return rec;
};

// ---- timer + Check now -------------------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
let started = false;
let running = false;
let nextRunAt: Date | null = null;

const once = async (trigger: string) => {
  if (running) return;
  running = true;
  try {
    const r = await withRunLock(UNIWARE_OUTSIDE.LOCK, () => runJob(UNIWARE_OUTSIDE.JOB, () => runOutsideCheck(trigger), { trigger }), trigger === 'timer' ? 0 : 5);
    if (!r) log.info(LOG_SOURCE.APP, `${LOG} another server is running it: skipped`);
  } catch (err) {
    logError(LOG_SOURCE.APP, `${LOG} run failed`, err);
    // 2026-11-25: a run that could not even start (e.g. Uniware not set up) shows its error on the strip, and a click that
    // ended so gives the button back (it read nothing; the team may try again at once)
    const msg = err instanceof Error ? err.message.slice(0, 300) : String(err);
    const prev = await readState<RunRecord>(UNIWARE_OUTSIDE.STATE_KEY, EMPTY).catch(() => EMPTY);
    await saveState(UNIWARE_OUTSIDE.STATE_KEY, { ...prev, lastEndedAt: new Date().toISOString(), lastError: msg, trigger }).catch(() => undefined);
    if (trigger === 'button') await saveState(UNIWARE_OUTSIDE.BUTTON_STATE_KEY, { at: null, by: null }).catch(() => undefined);
  } finally {
    running = false;
  }
};

const schedule = (ms: number) => {
  if (!started) return;
  clearTimeout(timer);
  nextRunAt = new Date(Date.now() + ms);
  timer = setTimeout(() => { void once('timer').finally(() => schedule(UNIWARE_OUTSIDE.EVERY_MIN * 60_000)); }, ms);
};

/** server.ts: every EVERY_MIN minutes; off on a laptop and with UNIWARE_OUTSIDE_ENABLED=false (Check now still works). */
export const startUniwareOutside = (): { stop: () => void } | undefined => {
  if (!env.uniwareOutside.enabled) {
    log.info(LOG_SOURCE.APP, `${LOG} timer off (UNIWARE_OUTSIDE_ENABLED=false or laptop): Check now still works`);
    return undefined;
  }
  started = true;
  schedule(UNIWARE_OUTSIDE.FIRST_DELAY_MS);
  log.info(LOG_SOURCE.APP, `${LOG} timer on (every ${UNIWARE_OUTSIDE.EVERY_MIN} min)`);
  return { stop: () => { started = false; clearTimeout(timer); nextRunAt = null; } };
};

interface ButtonClick { at: string | null; by: string | null }

/** One conditional UPDATE: two clicks at once cannot both pass. False = too soon. */
const takeButton = async (by: string, now: Date): Promise<boolean> => {
  const key = UNIWARE_OUTSIDE.BUTTON_STATE_KEY;
  await AppDataSource.query(`INSERT IGNORE INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW())`, [key, JSON.stringify({ at: null, by: null })]);
  const cutoff = new Date(now.getTime() - UNIWARE_OUTSIDE.BUTTON_EVERY_MIN * 60_000).toISOString();
  const r = await AppDataSource.query<{ affectedRows?: number }>(
    `UPDATE ${TABLES.APP_STATE} SET value = CAST(? AS JSON), updated_at = NOW()
      WHERE state_key = ? AND (JSON_EXTRACT(value, '$.at') IS NULL OR JSON_TYPE(JSON_EXTRACT(value, '$.at')) = 'NULL' OR JSON_UNQUOTE(JSON_EXTRACT(value, '$.at')) <= ?)`,
    [JSON.stringify({ at: now.toISOString(), by }), key, cutoff],
  );
  return (r.affectedRows ?? 0) > 0;
};

/** GET /po-review/uniware-outside: counts per tab + the last run + the button. */
export const outsideStatus = async () => {
  const [counts, rec, click] = await Promise.all([
    outsideCounts(), readState<RunRecord>(UNIWARE_OUTSIDE.STATE_KEY, EMPTY), readState<ButtonClick>(UNIWARE_OUTSIDE.BUTTON_STATE_KEY, { at: null, by: null }),
  ]);
  const clickAt = click.at ? Date.parse(click.at) : null;
  const nextAt = clickAt ? clickAt + UNIWARE_OUTSIDE.BUTTON_EVERY_MIN * 60_000 : null;
  return {
    counts,
    lastRun: { at: rec.lastEndedAt, okAt: rec.lastOkAt, error: rec.lastError, trigger: rec.trigger, checkedTo: rec.checkedTo ? new Date(rec.checkedTo).toISOString() : null, ...rec.counts },
    timerOn: started, running, nextRunAt: nextRunAt?.toISOString() ?? null, everyMinutes: UNIWARE_OUTSIDE.EVERY_MIN,
    button: { lastAt: click.at, lastBy: click.by, everyMinutes: UNIWARE_OUTSIDE.BUTTON_EVERY_MIN, nextAt: nextAt && nextAt > Date.now() ? new Date(nextAt).toISOString() : null },
  };
};

/** POST /po-review/uniware-outside/check: one click per BUTTON_EVERY_MIN for the whole team; the run goes on in the background. */
export const checkNow = async (by: string) => {
  if (!(await takeButton(by, new Date()))) {
    const click = await readState<ButtonClick>(UNIWARE_OUTSIDE.BUTTON_STATE_KEY, { at: null, by: null });
    const ago = click.at ? Math.max(0, Math.floor((Date.now() - Date.parse(click.at)) / 60_000)) : 0;
    throw appError(ERROR_CODES.UNIWARE_OUTSIDE_TOO_SOON, ago, click.by ?? 'someone', Math.max(1, UNIWARE_OUTSIDE.BUTTON_EVERY_MIN - ago));
  }
  const state = running ? 'running' : 'started';
  if (!running) void once('button');
  return { state, ...(await outsideStatus()) };
};

// ---- resolve -----------------------------------------------------------------------------------------------------------

const audit = (by: Actor, what: string) =>
  AppDataSource.getRepository(ActivityLog).insert({ userId: by.id, method: 'AUDIT', path: what.slice(0, 255), status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS) });

/**
 * POST /po-review/uniware-outside/:id/resolve { action, remark }. The action must fit where the PO is NOW (In Review:
 * reject / dismiss; Rejected: acknowledge / dismiss; Processed not uploaded: use_code / dismiss); dismiss needs a remark.
 */
export const resolveOutside = async (id: string, body: unknown, by: Actor) => {
  const b = (body && typeof body === 'object' ? body : {}) as { action?: unknown; remark?: unknown };
  const action = (typeof b.action === 'string' ? b.action : '') as UniwareOutsideAction;
  const remark = typeof b.remark === 'string' ? b.remark.trim() : '';
  const problems: { field: string; code: string; message: string }[] = [];
  if (!Object.values(UNIWARE_OUTSIDE_ACTION).includes(action)) {
    problems.push({ field: 'action', code: ERROR_CODES.FIELD_BAD_FORMAT, message: errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, 'action', `one of ${Object.values(UNIWARE_OUTSIDE_ACTION).join(', ')}`) });
  }
  if (remark.length > UNIWARE_OUTSIDE.REMARK_MAX) problems.push({ field: 'remark', code: ERROR_CODES.FIELD_TOO_LONG, message: errorMessage(ERROR_CODES.FIELD_TOO_LONG, 'remark', UNIWARE_OUTSIDE.REMARK_MAX) });
  if (action === UNIWARE_OUTSIDE_ACTION.DISMISS && !remark) problems.push({ field: 'remark', code: ERROR_CODES.FIELD_REQUIRED, message: errorMessage(ERROR_CODES.FIELD_REQUIRED, 'remark') });
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  if (!/^[1-9]\d{0,18}$/.test(id)) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_NOT_FOUND, id);

  const repo = AppDataSource.getRepository(UniwareOutsideOrder);
  const row = await repo.findOneBy({ id });
  if (!row) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_NOT_FOUND, id);
  if (row.state !== UNIWARE_OUTSIDE_STATE.OPEN) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_DONE, id);
  const upload = await AppDataSource.getRepository(PoUpload).findOne({ select: ['id', 'status', 'uniwareUploadedAt', 'poUid'], where: { id: row.uploadId } });
  const kind = upload ? kindOf({ status: upload.status, uploaded: !!upload.uniwareUploadedAt }) : null;
  if (!upload || !kind) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_DONE, id);
  if (!UNIWARE_OUTSIDE_ACTIONS_FOR[kind].includes(action)) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_BAD_ACTION, action, kind);
  // waiting for approval: reject it on the Approvals page (its submission is closed there), not here
  if (upload.status === UPLOAD_STATUS.PENDING_APPROVAL && action === UNIWARE_OUTSIDE_ACTION.REJECT) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_BAD_ACTION, action, 'waiting for approval (reject it on the Approvals page)');

  const done = { state: UNIWARE_OUTSIDE_STATE.RESOLVED, resolution: action, remark: remark || null, resolvedBy: by.id, resolvedAt: new Date() };
  if (action === UNIWARE_OUTSIDE_ACTION.REJECT) {
    await rejectPo(String(upload.id), UNIWARE_OUTSIDE_TEXT.REJECT_REMARK(row.uniwareCode, remark), by);
    await repo.update({ id: row.id, state: UNIWARE_OUTSIDE_STATE.OPEN }, done);
  } else if (action === UNIWARE_OUTSIDE_ACTION.USE_CODE) {
    await AppDataSource.transaction(async (m) => {
      const u = await m.getRepository(PoUpload).findOne({ where: { id: upload.id }, lock: { mode: 'pessimistic_write' } });
      if (!u || u.status !== UPLOAD_STATUS.COMPLETED || u.uniwareUploadedAt || !u.poUid) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_DONE, id);
      const po = await m.getRepository(MasterPurchaseOrder).findOne({ select: ['uid', 'orderNo1'], where: { uid: u.poUid } });
      if (!po) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_DONE, id);
      await m.getRepository(MasterPurchaseOrder).update({ uid: po.uid }, { orderNo1: row.uniwareCode });
      await m.getRepository(PoUpload).update({ id: u.id }, { uniwareUploadedAt: new Date(), uniwareUploadedBy: by.id });
      void forgetCache(CACHE_NS.PO_OVERVIEW_COUNTS); // PO Overview list totals (2026-11-27): POs shown there change
      await m.getRepository(ShipmentLog).insert({
        shipmentUid: po.uid, userId: by.id, action: SHIPMENT_LOG_ACTION.UNIWARE_UPLOADED, source: SHIPMENT_LOG_SOURCE.SCREEN,
        remark: UNIWARE_OUTSIDE_TEXT.USE_CODE_REMARK(row.uniwareCode, po.orderNo1, remark),
      });
      await m.getRepository(UniwareOutsideOrder).update({ id: row.id }, done);
    });
    bumpReview();
    void flushChanges();
  } else {
    await repo.update({ id: row.id, state: UNIWARE_OUTSIDE_STATE.OPEN }, done);
    bumpReview();
  }
  await audit(by, `uniware-outside: ${action} finding ${row.id} (${row.uniwareCode}) on upload ${row.uploadId}`);
  log.info(LOG_SOURCE.APP, `${LOG} finding ${row.id} ${action} by ${by.email}`);
  return { id: row.id, uploadId: String(row.uploadId), action, kind };
};

// ---- live read when a person opens a warning (2026-11-25) -------------------------------------------------------------

const lastLive = new Map<string, number>();

/**
 * GET /po-review/uniware-outside/:id/live: reads THIS order in Uniware now (one search by PO number, B2B). Still there =
 * its current status is stored (when it changed); cancelled or gone = the warning closes itself (resolution dismiss,
 * remark GONE_REMARK, nobody as the person). Read again within LIVE_FRESH_MS = the stored answer, no call.
 */
export const liveOutside = async (id: string) => {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_NOT_FOUND, id);
  const repo = AppDataSource.getRepository(UniwareOutsideOrder);
  const row = await repo.findOneBy({ id });
  if (!row) throw appError(ERROR_CODES.UNIWARE_OUTSIDE_NOT_FOUND, id);
  const fresh = (lastLive.get(id) ?? 0) > Date.now() - UNIWARE_OUTSIDE.LIVE_FRESH_MS;
  if (row.state !== UNIWARE_OUTSIDE_STATE.OPEN || fresh) {
    return { id, state: row.state, status: row.uniwareStatus, closed: row.state !== UNIWARE_OUTSIDE_STATE.OPEN, checked: false, otherCodes: [] as string[] };
  }
  const body = await poUniwareClient().post<{ elements?: unknown }>(UNIWARE_OUTSIDE.SEARCH, { orderCategory: UNIWARE_OUTSIDE.ORDER_CATEGORY, displayOrderCode: row.displayOrderCode });
  lastLive.set(id, Date.now());
  const found = ordersOf(body.elements);
  const me = found.find((o) => o.code === row.uniwareCode);
  const otherCodes = found.filter((o) => o.code !== row.uniwareCode && o.channel === row.uniwareChannel).map((o) => o.code);
  const gone = !me || (me.status !== null && UNIWARE_OUTSIDE.IGNORED_STATUSES.includes(me.status.toUpperCase()));
  if (gone) {
    await repo.update({ id: row.id, state: UNIWARE_OUTSIDE_STATE.OPEN }, {
      state: UNIWARE_OUTSIDE_STATE.RESOLVED, resolution: UNIWARE_OUTSIDE_ACTION.DISMISS, remark: UNIWARE_OUTSIDE_TEXT.GONE_REMARK(me?.status ?? null),
      resolvedBy: null, resolvedAt: new Date(), uniwareStatus: me?.status?.slice(0, 50) ?? row.uniwareStatus,
    });
    bumpReview();
    log.info(LOG_SOURCE.APP, `${LOG} finding ${row.id} (${row.uniwareCode}) closed: ${me?.status ?? 'not found'} in Uniware`);
  } else if (me.status !== row.uniwareStatus) {
    await repo.update({ id: row.id }, { uniwareStatus: me.status?.slice(0, 50) ?? null, lastSeenAt: new Date() });
  }
  return { id, state: gone ? UNIWARE_OUTSIDE_STATE.RESOLVED : row.state, status: me?.status ?? null, closed: gone, checked: true, otherCodes };
};

// ---- many at once (2026-11-25) ----------------------------------------------------------------------------------------

/**
 * POST /po-review/uniware-outside/bulk-resolve { ids, action, remark }: each finding like the single resolve, one by one;
 * one that does not fit (another tab's PO, already resolved) is skipped with why. 1..BULK_MAX ids.
 */
export const bulkResolveOutside = async (body: unknown, by: Actor) => {
  const b = (body && typeof body === 'object' ? body : {}) as { ids?: unknown; action?: unknown; remark?: unknown };
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))] : [];
  if (!ids.length || ids.length > UNIWARE_OUTSIDE.BULK_MAX || !ids.every((x) => /^[1-9]\d{0,18}$/.test(x))) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'ids', code: ERROR_CODES.FIELD_BAD_FORMAT, message: errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, 'ids', `a list of 1 to ${UNIWARE_OUTSIDE.BULK_MAX} finding ids`) }]);
  }
  const results: { id: string; result: 'done' | 'skipped'; reason?: string }[] = [];
  for (const id of ids) {
    try {
      await resolveOutside(id, { action: b.action, remark: b.remark }, by);
      results.push({ id, result: 'done' });
    } catch (err) {
      // a bad action / remark is the same for every id: stop at once with the 400
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === ERROR_CODES.VALIDATION_FAILED) throw err;
      results.push({ id, result: 'skipped', reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
};

// ---- check at the moment of action (2026-11-25) ------------------------------------------------------------------------

/**
 * Uniware read up to now: the B2B orders created since the last check (normally ONE call), unless a check ended less than
 * PRECHECK_FRESH_MS ago or another server is running one (then the stored findings are as fresh as they get). Never throws.
 */
const freshCheck = async (): Promise<{ checked: boolean; error: string | null }> => {
  try {
    const rec = await readState<RunRecord>(UNIWARE_OUTSIDE.STATE_KEY, EMPTY);
    if (rec.lastOkAt && Date.parse(rec.lastOkAt) > Date.now() - UNIWARE_OUTSIDE.PRECHECK_FRESH_MS) return { checked: true, error: null };
    const r = await withRunLock(UNIWARE_OUTSIDE.LOCK, () => runJob(UNIWARE_OUTSIDE.JOB, () => runOutsideCheck('action'), { trigger: 'action' }), 5);
    return r ? { checked: !r.lastError, error: r.lastError } : { checked: true, error: null };
  } catch (err) {
    logError(LOG_SOURCE.APP, `${LOG} check before an action failed`, err);
    return { checked: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
};

const idList = (v: unknown, field: string, max: number): string[] => {
  const ids = Array.isArray(v) ? [...new Set(v.map(String))] : [];
  if (!ids.length || ids.length > max || !ids.every((x) => /^[1-9]\d{0,18}$/.test(x))) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field, code: ERROR_CODES.FIELD_BAD_FORMAT, message: errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, field, `a list of 1 to ${max} ids`) }]);
  }
  return ids;
};

/**
 * POST /po-review/uniware-outside/precheck { uploadIds }: Uniware read up to now (freshCheck), then the open findings of
 * these POs: { checked, error, found: [{ id, uploadId, poNumber, code, channel, status }] }. The screen warns; nothing is refused.
 */
export const precheckOutside = async (body: unknown) => {
  const uploadIds = idList((body as { uploadIds?: unknown } | null)?.uploadIds, 'uploadIds', UNIWARE_OUTSIDE.PRECHECK_MAX);
  const fresh = await freshCheck();
  const rows = await AppDataSource.query<{ id: string; upload_id: string; po_number: string | null; uniware_code: string; uniware_channel: string; uniware_status: string | null }[]>(
    `SELECT o.id, o.upload_id, u.po_number, o.uniware_code, o.uniware_channel, o.uniware_status
       FROM ${TABLES.UNIWARE_OUTSIDE_ORDERS} o JOIN ${TABLES.PO_UPLOADS} u ON u.id = o.upload_id
      WHERE o.upload_id IN (?) AND o.state = ? ORDER BY o.id`,
    [uploadIds, UNIWARE_OUTSIDE_STATE.OPEN],
  );
  return {
    ...fresh,
    found: rows.map((r) => ({ id: String(r.id), uploadId: String(r.upload_id), poNumber: r.po_number, code: r.uniware_code, channel: r.uniware_channel, status: r.uniware_status })),
  };
};

/**
 * POST /po-review/uniware-outside/ack { ids, action download|mark|submit|approve, remark? }: the person went ahead
 * although these POs are in Uniware; recorded (audit + log), the warnings stay open. Never refused for the choice itself.
 */
export const ackOutside = async (body: unknown, by: Actor) => {
  const b = (body && typeof body === 'object' ? body : {}) as { ids?: unknown; action?: unknown; remark?: unknown };
  const ids = idList(b.ids, 'ids', UNIWARE_OUTSIDE.PRECHECK_MAX);
  const action = typeof b.action === 'string' ? b.action : '';
  const remark = typeof b.remark === 'string' ? b.remark.trim().slice(0, UNIWARE_OUTSIDE.REMARK_MAX) : '';
  if (!UNIWARE_OUTSIDE.ACK_ACTIONS.includes(action)) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'action', code: ERROR_CODES.FIELD_BAD_FORMAT, message: errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, 'action', `one of ${UNIWARE_OUTSIDE.ACK_ACTIONS.join(', ')}`) }]);
  }
  await audit(by, `uniware-outside: ${action} anyway for finding(s) ${ids.join(',')}${remark ? `: ${remark}` : ''}`);
  log.info(LOG_SOURCE.APP, `${LOG} ${by.email} went ahead (${action}) despite ${ids.length} finding(s)${remark ? `: ${remark}` : ''}`);
  return { recorded: ids.length };
};

