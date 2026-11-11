import { randomUUID } from 'crypto';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  D2C_DEFAULT_SETTINGS, D2C_PO_STATUS, D2C_REQUEST_STATE, D2C_STATE_KEY, D2C_SYNC, D2C_SYNC_STAGES, ERROR_CODES, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoInvoice } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { withLock } from '../intransit/s3/lock';
import { flushChanges } from '../po-overview/po-overview.live';
import { jsonOf, readSettings } from './settings';
import { sleep } from '../intransit/sources/http';
import { invoiceReceivingOf, reconcileInwardPo } from './inward-po.service';
import { reconcileSo } from './so.service';
import { testScopeSql } from './test-mode';
import { grnsToRead, isThrottled, nextDelayOf, planGrn, planSync, runGentle, RunErrors, soDetailOf } from './sync-plan';
import { checkId, linesOfTransfer, lockTransfer, writeLogs } from './transfers.service';
import {
  errorText, getGrn, getPurchaseOrder, getSaleOrder, GrnDetail, grnCodesOf, PoDetail, refusalOf, uniwareClient, UniwarePoster,
} from './uniware-transfers';

/*
 * The Uniware SO status sync of D2C internal transfers (phase 6; plan 6, 1.4, 2.7 d2c:sync, 3 live updates).
 * Read-only on Uniware (saleorder/get only). One run:
 *   1. reconcile SO requests in soState requested / unknown (reconcileSo, its 15-min grace);
 *   2. per transfer with an SO and a stage in sale_order .. partly_dispatched (full resync: every stage), oldest sync
 *      first: get the SO at the sender (no transaction), then lock + re-read + apply the plan of sync-plan.ts (po_invoices
 *      upsert, lines, header, stage, logs only for changes); flushChanges() after each commit that logged something;
 *   3. inward POs (phase 7): requests in requested / unknown reconciled (reconcileInwardPo, 15-min grace); per invoice
 *      with an inward PO created and no complete GRN: PO details + GRN list + each GRN not stored as COMPLETE at the
 *      RECEIVING facility, then lock + re-read + apply planGrn (grn_codes, received, sku_qty.received, lines'
 *      channelInwardingQuantity, grn_completed_at, deliveryDate, stage); the timer skips transfers synced within the
 *      interval (picked before step 2, which marks the transfers it reads as synced);
 *   4. d2c:sync = { lastStartedAt, lastEndedAt, lastOkAt, lastError, counts, nextDelayMin, trigger }.
 * Gentle on Uniware (our API user is shared with the in-transit fetch): 2 reads at a time with a pause, transfers
 * synced within the interval are skipped by the timer, closed / cancelled / draft ones are never read (unless full);
 * a final 429 stops the run (progress kept) and the next run waits twice as long, up to 2 h.
 * Scheduler: startD2cSync() from server.ts (not in laptop mode, not without a DB, not with D2C_SYNC_ENABLED=false);
 * runs never overlap on a server, and withLock('d2c-transfers-sync') keeps a second server out. Sync now
 * (requestSync) starts a run at once or queues one after the run going on.
 */

const LOG = '[d2c-sync]';
const R = D2C_REQUEST_STATE;

export interface SyncCounts {
  /** SO requests looked up (requested / unknown). */
  reconciled: number;
  /** Transfers picked for an SO read, read, changed (something written), unchanged, failed. */
  candidates: number; read: number; changed: number; unchanged: number; errors: number;
  /** Left for the next run (stopped by a 429). */
  notStarted: number;
  /** Phase 7: inward PO requests looked up; invoices whose GRN was read / changed / failed. */
  reconciledInward?: number; grnRead?: number; grnChanged?: number; grnErrors?: number;
}
export interface SyncRecord {
  lastStartedAt: string | null; lastEndedAt: string | null; lastOkAt: string | null; lastError: string | null;
  counts: SyncCounts | null; nextDelayMin: number | null; trigger: string | null;
}
export interface SyncRunOptions {
  /** Only these transfers (Sync now on some rows). */
  ids?: string[];
  /** Every stage incl. closed / cancelled (CAPABILITY.D2C_RESYNC). */
  full?: boolean;
  /** Sync now: transfers synced within the interval are read too. */
  manual?: boolean;
  api?: UniwarePoster;
}

const EMPTY: SyncRecord = { lastStartedAt: null, lastEndedAt: null, lastOkAt: null, lastError: null, counts: null, nextDelayMin: null, trigger: null };

const readRecord = async (): Promise<SyncRecord> => {
  const [row] = await AppDataSource.query<{ value: unknown }[]>(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [D2C_STATE_KEY.SYNC]);
  return { ...EMPTY, ...jsonOf<Partial<SyncRecord>>(row?.value, {}) };
};
const saveRecord = (r: SyncRecord) => AppDataSource.query(
  `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), NOW())
   ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
  [D2C_STATE_KEY.SYNC, JSON.stringify(r)],
);

// ---- what to read ----------------------------------------------------------------------------------------------------

const idFilter = (ids: string[] | undefined) => (ids?.length ? { sql: ' AND p.uid IN (?)', args: [ids] as unknown[] } : { sql: '', args: [] as unknown[] });

/** Local test mode (env.d2c.testOnly): only transfers that involve a test facility are read (testScopeSql). */
type Scope = { sql: string; args: unknown[] };

/** SO requests to reconcile (plan 6 step 1). */
const reconcileCandidates = async (o: SyncRunOptions, scope: Scope): Promise<string[]> => {
  const f = idFilter(o.ids);
  const rows = await AppDataSource.query<{ uid: string | number }[]>(
    `SELECT p.uid FROM ${TABLES.MASTER_PURCHASE_ORDERS} p WHERE p.transferCode IS NOT NULL AND p.soState IN (?, ?)${f.sql}${scope.sql} ORDER BY p.uid`,
    [R.REQUESTED, R.UNKNOWN, ...f.args, ...scope.args],
  );
  return rows.map((r) => String(r.uid));
};

/**
 * Transfers whose SO is read (plan 6 step 2): SO created, a stage that can still change in Uniware (full: any), and,
 * for the timer, not synced within the interval. Oldest sync first, at most MAX_PER_RUN. (Their inward POs: grnCandidates.)
 */
const statusCandidates = async (o: SyncRunOptions, syncMinutes: number, scope: Scope): Promise<string[]> => {
  const f = idFilter(o.ids);
  const args: unknown[] = [R.CREATED];
  let where = `p.transferCode IS NOT NULL AND p.soState = ? AND p.orderNo1 IS NOT NULL AND p.facility IS NOT NULL`;
  if (!o.full) {
    where += ' AND p.transferStage IN (?)';
    args.push(D2C_SYNC_STAGES);
  }
  if (!o.manual && !o.ids?.length) {
    where += ' AND (p.lastSyncedAt IS NULL OR p.lastSyncedAt < ?)';
    args.push(new Date(Date.now() - Math.max(0, syncMinutes * 60_000 - D2C_SYNC.FRESH_SLACK_MS)));
  }
  const rows = await AppDataSource.query<{ uid: string | number }[]>(
    `SELECT p.uid FROM ${TABLES.MASTER_PURCHASE_ORDERS} p WHERE ${where}${f.sql}${scope.sql}
      ORDER BY p.lastSyncedAt IS NOT NULL, p.lastSyncedAt, p.uid LIMIT ${D2C_SYNC.MAX_PER_RUN}`,
    [...args, ...f.args, ...scope.args],
  );
  return rows.map((r) => String(r.uid));
};

/** Inward PO requests to reconcile (phase 7): invoices in requested / unknown. */
const inwardReconcileCandidates = async (o: SyncRunOptions, scope: Scope): Promise<string[]> => {
  const ids = o.ids?.length ? o.ids : null;
  const rows = await AppDataSource.query<{ id: string | number }[]>(
    `SELECT i.id FROM ${TABLES.PO_INVOICES} i JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = i.po_uid
      WHERE p.transferCode IS NOT NULL AND i.inward_po_state IN (?, ?)${ids ? ' AND p.uid IN (?)' : ''}${scope.sql} ORDER BY i.id`,
    [R.REQUESTED, R.UNKNOWN, ...(ids ? [ids] : []), ...scope.args],
  );
  return rows.map((r) => String(r.id));
};

/**
 * Invoices whose GRN is read (phase 7; plan 6 step 3): inward PO created, GRN not complete, dispatched; for the timer
 * only of transfers not synced within the interval. Oldest sync first, at most MAX_PER_RUN.
 */
const grnCandidates = async (o: SyncRunOptions, syncMinutes: number, scope: Scope): Promise<string[]> => {
  const ids = o.ids?.length ? o.ids : null;
  const args: unknown[] = [R.CREATED];
  let where = 'p.transferCode IS NOT NULL AND i.inward_po_state = ? AND i.grn_completed_at IS NULL AND i.dispatched_at IS NOT NULL AND i.inward_po_code IS NOT NULL';
  if (!o.manual && !ids) {
    where += ' AND (p.lastSyncedAt IS NULL OR p.lastSyncedAt < ?)';
    args.push(new Date(Date.now() - Math.max(0, syncMinutes * 60_000 - D2C_SYNC.FRESH_SLACK_MS)));
  }
  if (ids) {
    where += ' AND p.uid IN (?)';
    args.push(ids);
  }
  where += scope.sql;
  args.push(...scope.args);
  const rows = await AppDataSource.query<{ id: string | number }[]>(
    `SELECT i.id FROM ${TABLES.PO_INVOICES} i JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = i.po_uid
      WHERE ${where} ORDER BY p.lastSyncedAt IS NOT NULL, p.lastSyncedAt, i.id LIMIT ${D2C_SYNC.MAX_PER_RUN}`,
    args,
  );
  return rows.map((r) => String(r.id));
};

// ---- one transfer ----------------------------------------------------------------------------------------------------

type One = 'changed' | 'unchanged' | 'error' | 'skipped';

/**
 * The run's syncError of one transfer (combineSyncErrors of its SO read + GRN reads; null = all read fine): written
 * only when it differs from the stored one, with a sync_error log when it is set to a new text (a clear is not logged).
 * A transfer with an error also gets lastSyncedAt (it was read).
 */
const applySyncError = async (uid: string, text: string | null, now: Date): Promise<void> => {
  const logged = await AppDataSource.transaction(async (m) => {
    const cur = await lockTransfer(m, uid);
    const same = (cur.syncError ?? null) === text;
    if (same && !text) return false;
    await m.getRepository(MasterPurchaseOrder).update({ uid }, { ...(text ? { lastSyncedAt: now } : {}), ...(same ? {} : { syncError: text }) });
    if (!same && text) {
      await writeLogs(m, [{ uid, action: SHIPMENT_LOG_ACTION.SYNC_ERROR, source: SHIPMENT_LOG_SOURCE.SYSTEM, field: 'syncError', oldValue: cur.syncError, newValue: text }], randomUUID(), null);
    }
    return !same && !!text;
  });
  if (logged) void flushChanges();
};

/**
 * Read the SO (no transaction), then lock + re-read + apply (plan 1.4). Throws only a 429 (the run stops) or a
 * database error; a Uniware refusal / no answer is this transfer's syncError.
 */
const syncOne = async (uid: string, api: UniwarePoster, errs: RunErrors): Promise<{ result: One; down: boolean }> => {
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });
  if (!po || !po.transferCode || po.soState !== R.CREATED || !po.orderNo1 || !po.facility) return { result: 'skipped', down: false };
  let raw: unknown;
  try {
    const got = await getSaleOrder(api, po.orderNo1, po.facility);
    if (!got.so) {
      errs.so(uid, `SO ${po.orderNo1} not found in Uniware at ${po.facility}`);
      return { result: 'error', down: false };
    }
    raw = got.raw;
  } catch (err) {
    if (isThrottled(err)) throw err;
    errs.so(uid, `Uniware read failed: ${errorText(err)}`);
    return { result: 'error', down: !refusalOf(err) };
  }
  const so = soDetailOf(raw as Record<string, unknown>);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const out = await AppDataSource.transaction(async (m): Promise<{ result: One; logged: boolean }> => {
    const cur = await lockTransfer(m, uid);
    // the SO changed meanwhile (cancelled and re-sent ...): the next run reads it again
    if (cur.soState !== R.CREATED || cur.orderNo1 !== po.orderNo1) return { result: 'skipped', logged: false };
    const lines = await linesOfTransfer(m, uid);
    const invoices = await m.getRepository(PoInvoice).find({ where: { poUid: uid }, order: { id: 'ASC' } });
    const plan = planSync({ header: cur, lines, invoices }, so, now);
    for (const inv of plan.invoices) {
      if (inv.isNew) await m.getRepository(PoInvoice).insert({ ...inv.set, poUid: uid, shippingPackageCode: inv.code } as QueryDeepPartialEntity<PoInvoice>);
      else await m.getRepository(PoInvoice).update({ poUid: uid, shippingPackageCode: inv.code }, inv.set as QueryDeepPartialEntity<PoInvoice>);
    }
    for (const l of plan.lines) await m.getRepository(DetailsPurchaseOrder).update({ id: l.id }, { ...l.set, updatedAt: now } as QueryDeepPartialEntity<DetailsPurchaseOrder>);
    await m.getRepository(MasterPurchaseOrder).update({ uid }, {
      ...plan.header, lastSyncedAt: now, ...(plan.changed ? { updatedAt: now } : {}),
    } as QueryDeepPartialEntity<MasterPurchaseOrder>);
    await writeLogs(m, plan.logs, randomUUID(), null, SHIPMENT_LOG_SOURCE.UNIWARE);
    if (plan.unmatched.length) log.warn(LOG_SOURCE.APP, `${LOG} SO items with no transfer line`, { uid, items: plan.unmatched });
    errs.so(uid, null);
    return { result: plan.changed || plan.logs.length ? 'changed' : 'unchanged', logged: plan.logs.length > 0 };
  });
  if (out.logged) void flushChanges();
  return { result: out.result, down: false };
};

/**
 * One invoice's GRN (phase 7): read the PO, its GRN list and every GRN not stored as COMPLETE at the receiving facility
 * (no transaction), then lock + re-read + apply planGrn. Throws only a 429 (the run stops) or a database error; a
 * Uniware refusal / no answer is the transfer's syncError.
 */
const syncGrnOne = async (invoiceId: string, api: UniwarePoster, pause: () => Promise<void>, errs: RunErrors): Promise<{ result: One; down: boolean }> => {
  const inv = await AppDataSource.getRepository(PoInvoice).findOneBy({ id: invoiceId });
  if (!inv || inv.inwardPoState !== R.CREATED || inv.grnCompletedAt || !inv.inwardPoCode) return { result: 'skipped', down: false };
  const uid = String(inv.poUid);
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });
  if (!po || !po.transferCode) return { result: 'skipped', down: false };
  const code = inv.inwardPoCode;
  // the facility the PO was made at (stored at reserve time), never today's Masters value
  const receiving = await invoiceReceivingOf(AppDataSource.manager, inv);
  const invNo = inv.invoiceDisplayCode ?? inv.invoiceCode ?? inv.shippingPackageCode;
  if (!receiving) {
    errs.grn(uid, `inward PO ${code} (${invNo}): its receiving facility was not recorded at request time`);
    return { result: 'error', down: false };
  }
  let read: { po: PoDetail; codes: string[]; grns: GrnDetail[] };
  try {
    const got = await getPurchaseOrder(api, code, receiving);
    if (!got.po) {
      errs.grn(uid, `inward PO ${code} (${invNo}) not found in Uniware at ${receiving}`);
      return { result: 'error', down: false };
    }
    await pause();
    const codes = await grnCodesOf(api, code, receiving);
    const grns: GrnDetail[] = [];
    for (const g of grnsToRead(inv.grnCodes, codes)) {
      await pause();
      grns.push(await getGrn(api, g, receiving));
    }
    read = { po: got.po, codes, grns };
  } catch (err) {
    if (isThrottled(err)) throw err;
    errs.grn(uid, `Uniware GRN read failed for inward PO ${code} (${invNo}): ${errorText(err)}`);
    return { result: 'error', down: !refusalOf(err) };
  }
  if (read.po.status === D2C_PO_STATUS.CANCELLED && read.codes.length) {
    errs.grn(uid, `inward PO ${code} (${invNo}) is cancelled in Uniware but has GRN ${read.codes.join(', ')}: check it in Uniware`);
    return { result: 'error', down: false };
  }
  errs.grn(uid, null);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const out = await AppDataSource.transaction(async (m): Promise<{ result: One; logged: boolean }> => {
    const cur = await lockTransfer(m, uid);
    const invoices = await m.getRepository(PoInvoice).find({ where: { poUid: uid }, order: { id: 'ASC' } });
    const fresh = invoices.find((i) => String(i.id) === invoiceId);
    // resolved / re-created meanwhile: the next run reads it again
    if (!fresh || fresh.inwardPoState !== R.CREATED || fresh.inwardPoCode !== code || fresh.grnCompletedAt) return { result: 'skipped', logged: false };
    const lines = await linesOfTransfer(m, uid);
    const plan = planGrn({ header: cur, lines, invoices }, { invoiceId, ...read }, now);
    if (Object.keys(plan.invoice).length) await m.getRepository(PoInvoice).update({ id: invoiceId }, plan.invoice as QueryDeepPartialEntity<PoInvoice>);
    for (const l of plan.lines) await m.getRepository(DetailsPurchaseOrder).update({ id: l.id }, { ...l.set, updatedAt: now } as QueryDeepPartialEntity<DetailsPurchaseOrder>);
    await m.getRepository(MasterPurchaseOrder).update({ uid }, {
      ...plan.header, lastSyncedAt: now, ...(plan.changed ? { updatedAt: now } : {}),
    } as QueryDeepPartialEntity<MasterPurchaseOrder>);
    await writeLogs(m, plan.logs, randomUUID(), null, SHIPMENT_LOG_SOURCE.UNIWARE);
    return { result: plan.changed || plan.logs.length ? 'changed' : 'unchanged', logged: plan.logs.length > 0 };
  });
  if (out.logged) void flushChanges();
  return { result: out.result, down: false };
};

// ---- one run ---------------------------------------------------------------------------------------------------------

/** One pass (no lock of its own: the scheduler / Sync now wrap it in withLock). */
export const runSyncPass = async (o: SyncRunOptions = {}): Promise<{ counts: SyncCounts; failed: boolean; nextDelayMin: number; error: string | null }> => {
  const settings = await readSettings();
  const before = await readRecord();
  const startedAt = new Date().toISOString();
  const trigger = o.full ? 'full' : o.ids?.length ? 'ids' : o.manual ? 'manual' : 'timer';
  await saveRecord({ ...before, lastStartedAt: startedAt, trigger });
  const counts: SyncCounts = { reconciled: 0, candidates: 0, read: 0, changed: 0, unchanged: 0, errors: 0, notStarted: 0 };
  let error: string | null = null;
  let failed = false;
  const errs = new RunErrors();
  try {
    const api = o.api ?? uniwareClient();
    const gentle = { concurrency: D2C_SYNC.CONCURRENCY, gapMs: D2C_SYNC.CALL_GAP_MS };
    // picked first: step 2 marks the transfers it reads as synced, which would hide their GRN from the timer
    const scope = testScopeSql(settings);
    const grnTodo = await grnCandidates(o, settings.syncMinutes, scope);
    const toReconcile = await reconcileCandidates(o, scope);
    await runGentle(toReconcile, { ...gentle, concurrency: 1 }, async (uid) => {
      const r = await reconcileSo(uid, { api });
      if (r.checked) counts.reconciled++;
    });
    const todo = await statusCandidates(o, settings.syncMinutes, scope);
    counts.candidates = todo.length;
    let down = 0;
    const run = await runGentle(todo, gentle, async (uid) => {
      const r = await syncOne(uid, api, errs);
      if (r.result === 'skipped') return;
      counts.read++;
      if (r.result === 'error') counts.errors++;
      else counts[r.result]++;
      if (r.down) down++;
    });
    counts.notStarted = run.notStarted;
    counts.errors += run.errors.length;
    if (run.errors.length) logError(LOG_SOURCE.APP, `${LOG} ${run.errors.length} transfer(s) failed to save`, run.errors[0]);
    if (run.throttled) {
      failed = true;
      error = `Uniware answered 429 (too many requests): stopped after ${counts.read} transfer(s), ${run.notStarted} left for the next run`;
    } else {
      // phase 7: inward PO requests, then GRNs (same gentleness: a final 429 stops the run, progress kept)
      counts.reconciledInward = 0;
      counts.grnRead = 0;
      counts.grnChanged = 0;
      counts.grnErrors = 0;
      const inward = await runGentle(await inwardReconcileCandidates(o, scope), { ...gentle, concurrency: 1 }, async (id) => {
        const r = await reconcileInwardPo(id, { api });
        if (r.checked) counts.reconciledInward = (counts.reconciledInward ?? 0) + 1;
      });
      const pause = () => sleep(D2C_SYNC.CALL_GAP_MS);
      let grnDown = 0;
      const grn = inward.throttled ? null : await runGentle(grnTodo, gentle, async (id) => {
        const r = await syncGrnOne(id, api, pause, errs);
        if (r.result === 'skipped') return;
        counts.grnRead = (counts.grnRead ?? 0) + 1;
        if (r.result === 'error') counts.grnErrors = (counts.grnErrors ?? 0) + 1;
        else if (r.result === 'changed') counts.grnChanged = (counts.grnChanged ?? 0) + 1;
        if (r.down) grnDown++;
      });
      if (grn) {
        counts.notStarted += grn.notStarted;
        counts.grnErrors = (counts.grnErrors ?? 0) + grn.errors.length;
        if (grn.errors.length) logError(LOG_SOURCE.APP, `${LOG} ${grn.errors.length} GRN read(s) failed to save`, grn.errors[0]);
      }
      const total = counts.read + (counts.grnRead ?? 0);
      if (inward.throttled || grn?.throttled) {
        failed = true;
        error = `Uniware answered 429 (too many requests) during the inward PO / GRN reads: ${grn?.notStarted ?? grnTodo.length} invoice(s) left for the next run`;
      } else if (total > 0 && down + grnDown === total) {
        failed = true;
        error = 'Uniware could not be reached (no answer for any transfer)';
      }
    }
  } catch (err) {
    failed = true;
    error = err instanceof AppError ? err.message : errorText(err);
    logError(LOG_SOURCE.APP, `${LOG} run failed`, err);
  }
  // one syncError per transfer read this run (SO + GRN errors combined): no flip between the two steps
  const errAt = new Date();
  for (const [uid, text] of errs.results()) {
    await applySyncError(uid, text, errAt).catch((err) => logError(LOG_SOURCE.APP, `${LOG} could not save the sync error of ${uid}`, err));
  }
  const nextDelayMin = nextDelayOf(settings.syncMinutes, failed, before.lastError ? before.nextDelayMin : null);
  const endedAt = new Date().toISOString();
  await saveRecord({
    lastStartedAt: startedAt, lastEndedAt: endedAt, lastOkAt: failed ? before.lastOkAt : endedAt, lastError: error, counts, nextDelayMin, trigger,
  }).catch((err) => logError(LOG_SOURCE.APP, `${LOG} could not save d2c:sync`, err));
  log.info(LOG_SOURCE.APP, `${LOG} ${failed ? 'failed' : 'done'} (${trigger}): ${JSON.stringify(counts)}${error ? ` | ${error}` : ''}; next in ${nextDelayMin} min`);
  return { counts, failed, nextDelayMin, error };
};

// ---- scheduler + Sync now --------------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
let started = false;
let stopped = false;
let running = false;
let pending: SyncRunOptions | null = null;
let nextRunAt: Date | null = null;
let lastWaitMin: number | null = null;

const schedule = (ms: number) => {
  if (!started || stopped) return;
  clearTimeout(timer);
  nextRunAt = new Date(Date.now() + ms);
  timer = setTimeout(() => void loop({}), ms);
};

/** Two queued requests as one: all transfers wins over some, full wins over not. */
const mergeRuns = (a: SyncRunOptions | null, b: SyncRunOptions): SyncRunOptions => {
  if (!a) return b;
  const ids = a.ids?.length && b.ids?.length ? [...new Set([...a.ids, ...b.ids])] : undefined;
  return { ids, full: !!(a.full || b.full), manual: !!(a.manual || b.manual) };
};

const loop = async (o: SyncRunOptions): Promise<void> => {
  if (running) {
    pending = mergeRuns(pending, o);
    return;
  }
  running = true;
  nextRunAt = null;
  let waitMin = D2C_DEFAULT_SETTINGS.syncMinutes;
  try {
    waitMin = (await readSettings()).syncMinutes;
    const r = await withLock(D2C_SYNC.LOCK, () => runJob(D2C_SYNC.JOB, () => runSyncPass(o), { trigger: o.manual ? 'manual' : 'timer' }), o.manual ? D2C_SYNC.MANUAL_LOCK_WAIT_S : 0);
    waitMin = r.nextDelayMin;
    lastWaitMin = r.failed ? r.nextDelayMin : null;
  } catch (err) {
    if (err instanceof AppError && err.code === ERROR_CODES.INTRANSIT_BUSY) log.info(LOG_SOURCE.APP, `${LOG} another server is running the sync: skipped`);
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
/** Starts the timer (server.ts). Off with D2C_SYNC_ENABLED=false (laptop mode switches it off). */
export const startD2cSync = (): { stop: () => void } | undefined => {
  if (env.d2c.testOnly) {
    log.info(LOG_SOURCE.APP, `${LOG} timer off (local test mode, D2C_TEST_ONLY): Sync now reads test-facility transfers only`);
    return undefined;
  }
  if (!env.d2c.syncEnabled) {
    log.info(LOG_SOURCE.APP, `${LOG} timer off (D2C_SYNC_ENABLED=false): Sync now still works`);
    return undefined;
  }
  started = true;
  stopped = false;
  schedule(D2C_SYNC.FIRST_DELAY_MS);
  log.info(LOG_SOURCE.APP, `${LOG} timer on (every d2c:settings.syncMinutes, first run in ${D2C_SYNC.FIRST_DELAY_MS / 1000} s)`);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      nextRunAt = null;
    },
  };
};

/** Sync now: a run at once, or right after the run going on ('queued'). */
const requestSync = (o: SyncRunOptions): 'started' | 'queued' => {
  if (running) {
    pending = mergeRuns(pending, o);
    return 'queued';
  }
  clearTimeout(timer);
  void loop(o);
  return 'started';
};

/** GET /d2c-transfers/sync-status: the header's "Uniware · synced N min ago". */
export const syncStatus = async () => {
  const [r, settings] = await Promise.all([readRecord(), readSettings()]);
  const okAt = r.lastOkAt ? Date.parse(r.lastOkAt) : null;
  return {
    ...r,
    timerOn: started && !stopped,
    running,
    queued: pending !== null,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    syncMinutes: settings.syncMinutes,
    /** Local test mode (env.d2c.testOnly): only TEST_FACILITY transfers; the page shows a banner. */
    testOnly: env.d2c.testOnly,
    minutesAgo: okAt ? Math.max(0, Math.floor((Date.now() - okAt) / 60_000)) : null,
  };
};

/**
 * POST /d2c-transfers/sync { ids?, full? } -> 202 { state: started | queued, ...status }. full needs
 * CAPABILITY.D2C_RESYNC (checked by the route: canResync).
 */
export const startSync = async (body: unknown, canResync: boolean) => {
  const b = (body && typeof body === 'object' ? body : {}) as { ids?: unknown; full?: unknown };
  if (b.ids !== undefined && !Array.isArray(b.ids)) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'ids', code: ERROR_CODES.FIELD_REQUIRED, message: 'ids must be a list of transfer ids' }]);
  }
  if (b.full !== undefined && typeof b.full !== 'boolean') {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'full', code: ERROR_CODES.FIELD_NOT_BOOLEAN, message: 'full must be true or false' }]);
  }
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((x) => checkId(String(x))))] : undefined;
  if (ids && ids.length > D2C_SYNC.MAX_IDS) throw appError(ERROR_CODES.D2C_TOO_MANY, D2C_SYNC.MAX_IDS);
  if (b.full === true && !canResync) throw appError(ERROR_CODES.D2C_RESYNC_FORBIDDEN);
  const state = requestSync({ ids: ids?.length ? ids : undefined, full: b.full === true, manual: true });
  return { state, ...(await syncStatus()) };
};
