import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  D2C_BALANCE_CLOSED_REASON, D2C_FINAL_STAGES, D2C_REQUEST_STATE, D2C_SO_JOBS, D2C_STAGE, D2C_UNDISPATCHED_STAGES, ERROR_CODES, round2,
  SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, TABLES,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoInvoice } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { flushChanges } from '../po-overview/po-overview.live';
import { takeSoCode, todayIst } from './reference';
import { D2cSettings, readSettings } from './settings';
import { deriveStage, statusTextsOf } from './stage';
import { isTestLane, laneText, receivingOfLocation, testCodesOf } from './test-mode';
import {
  Actor, cancelDraft, checkId, linesOfTransfer, lockTransfer, LogRow, nowSeconds, reasonOf, writeLogs,
} from './transfers.service';
import {
  cancelSaleOrderItems, classify, createSaleOrder, errorText, getSaleOrder, isCancelledItem, isOpenItem, itemCodeOf, refusalOf, SoInput, SoItem,
  SoView, statusLine, stockAt, trim, uniwareClient, UniwarePoster,
} from './uniware-transfers';

/*
 * Sale orders of D2C internal transfers in Uniware (phase 5; plan 1.4, 2.11, 5.4, 5.6 + the user's answers of
 * 2026-11-03: SO price 15% of MRP, code erp_it_<yyyymmdd><NNN>, nothing automatic on expiry, close short / cancel only
 * by Ops in the tool, the tool cancels the open SO items by API).
 *
 *   POST /stock-check {ids}   read-only: per line needed vs available at the sender (no write anywhere).
 *   POST /create-so {ids}     202 + job: per transfer, independently, 3 at a time:
 *       reserve (locked txn)  draft, soState NULL / failed, route with customer + Uniware channel, every line with an
 *                             MRP, gate; SO code taken once (kept on retries); soState requested; log so_requested;
 *       call (no txn)         create in Uniware;
 *       confirm (locked txn)  success -> created, stage recomputed (sale_order), log so_created;
 *                             refused -> failed + soError, stays an editable draft, log so_failed;
 *                             duplicate code / HTTP / timeout -> unknown, then reconcileSo(): get by code ->
 *                             found with our reference -> created; clean "unknown code" -> failed; get error -> stays unknown.
 *   POST /:id/cancel          until dispatched; with an SO: cancel its open items in Uniware first, then cancelled.
 *   POST /:id/close-short     cancel every open SO item; lines actually cancelled get updatedQty = what was not cancelled.
 * Uniware calls never run inside a transaction; each write re-reads the transfer under its row lock and calls
 * flushChanges() after commit.
 */

const R = D2C_REQUEST_STATE;
const LOG = '[d2c-so]';

// ---- production gate (plan 2.11) -------------------------------------------------------------------------------------

/** Who a Uniware write is about: the transfer's sender and receiving facility (codes). */
export interface WriteLane { sender: string | null; receiving: string | null }
/** Where the write happens: a sale order / cancel / close short at the sender, an inward PO at the receiving facility. */
export type WriteAt = 'sender' | 'receiving';

/**
 * The Uniware write gate (plan 2.11 + local test mode, test-mode.ts):
 *   test only (env.d2c.testOnly)  sender AND receiving facility both test facilities (settings.live / env ignored);
 *   open (settings.live AND env D2C_UNIWARE_WRITES)  the facility the write happens at (`at`) must be known;
 *   closed                        sender AND receiving facility both test facilities.
 */
export const uniwareWritesAllowed = (
  s: Pick<D2cSettings, 'live' | 'testFacilities'>, envWrites: boolean, lane: WriteLane, at: WriteAt, testOnly = env.d2c.testOnly,
): boolean => {
  if (!testOnly && s.live === true && envWrites) return !!(at === 'sender' ? lane.sender : lane.receiving);
  return isTestLane(s, lane.sender, lane.receiving);
};

/** The refusal of the gate: D2C_TEST_ONLY in test only mode, else D2C_NOT_LIVE. */
export const gateError = (lane: WriteLane, testOnly = env.d2c.testOnly): AppError =>
  appError(testOnly ? ERROR_CODES.D2C_TEST_ONLY : ERROR_CODES.D2C_NOT_LIVE, laneText(lane.sender, lane.receiving));

/** A gate refusal code (either mode). */
export const isGateCode = (code: string | undefined): boolean => code === ERROR_CODES.D2C_NOT_LIVE || code === ERROR_CODES.D2C_TEST_ONLY;

export const gateOf = (s: Pick<D2cSettings, 'live' | 'testFacilities'>) => ({
  live: s.live === true, envWrites: env.d2c.uniwareWrites, testOnly: env.d2c.testOnly,
  open: !env.d2c.testOnly && s.live === true && env.d2c.uniwareWrites, testFacilities: testCodesOf(s),
});

const assertWritable = (s: D2cSettings, lane: WriteLane, at: WriteAt) => {
  if (!uniwareWritesAllowed(s, env.d2c.uniwareWrites, lane, at)) throw gateError(lane);
};

// ---- shared reads ----------------------------------------------------------------------------------------------------

export interface RouteCodes { id: number; uniwareChannelCode: string | null; customerCode: string | null; vendorCode?: string | null }

/** The transfer's route: the chosen one, else the only active route of its sender + location (inward POs use its vendor). */
export const routeOf = async (m: EntityManager, po: Pick<MasterPurchaseOrder, 'facilityId' | 'locationId' | 'transferRouteId'>): Promise<RouteCodes | null> => {
  const rows = await m.query<{ id: number; uniware_channel_code: string | null; customer_code: string | null; vendor_code: string | null; is_active: number }[]>(
    `SELECT id, uniware_channel_code, customer_code, vendor_code, is_active FROM ${TABLES.D2C_TRANSFER_ROUTES}
      WHERE (dispatch_facility_id = ? AND location_id = ?) OR id = ? ORDER BY id`,
    [po.facilityId ?? 0, po.locationId ?? 0, po.transferRouteId ?? 0],
  );
  const active = rows.filter((r) => Number(r.is_active) === 1);
  const r = po.transferRouteId !== null && po.transferRouteId !== undefined
    ? rows.find((x) => Number(x.id) === Number(po.transferRouteId))
    : active.length === 1 ? active[0] : undefined;
  return r ? { id: Number(r.id), uniwareChannelCode: r.uniware_channel_code, customerCode: r.customer_code, vendorCode: r.vendor_code } : null;
};

const invoicesOf = (m: EntityManager, uid: string) => m.getRepository(PoInvoice).find({ where: { poUid: uid }, order: { id: 'ASC' } });

const liveQty = (l: DetailsPurchaseOrder) => l.updatedQty ?? l.qty ?? 0;
/** MRP of one unit of a line, frozen at save (gmv = MRP x qty). */
export const lineMrp = (l: Pick<DetailsPurchaseOrder, 'gmv' | 'qty'>): number | null => {
  const qty = l.qty ?? 0;
  const v = qty > 0 ? Number(l.gmv ?? 0) / qty : 0;
  return v > 0 ? v : null;
};

/** The stage of a locked transfer from its rows (plan 1.1). */
const stageOf = (po: MasterPurchaseOrder, soState: string | null, lines: DetailsPurchaseOrder[], invoices: PoInvoice[], updatedQty?: Map<string, number>) =>
  deriveStage({
    stage: po.transferStage,
    soState,
    lines: lines.map((l) => ({ updatedQty: updatedQty?.get(l.id) ?? liveQty(l), dispatched: l.dispatchedQty ?? 0 })),
    invoices: invoices.map((i) => ({
      packageStatus: i.packageStatus, invoiced: !!i.invoiceCode, dispatched: !!i.dispatchedAt, inwardPoState: i.inwardPoState,
      grnCompleted: !!i.grnCompletedAt, variance: (i.receivedUnits ?? 0) - (i.units ?? 0), varianceReason: i.varianceReason,
    })),
  });

/** Header fields of a stage change (texts + time), or nothing when the stage stays. */
const stageFields = (po: MasterPurchaseOrder, stage: string, now: Date): Partial<MasterPurchaseOrder> =>
  (po.transferStage === stage ? {} : { transferStage: stage, transferStageAt: now, ...statusTextsOf(stage as Parameters<typeof statusTextsOf>[0]) });

/** Header update of a locked transfer. */
const setHeader = (m: EntityManager, uid: string, h: Partial<MasterPurchaseOrder>) =>
  m.getRepository(MasterPurchaseOrder).update({ uid }, h as QueryDeepPartialEntity<MasterPurchaseOrder>);

const done = () => {
  void flushChanges();
};

// ---- create SO: pure decisions (unit-tested) --------------------------------------------------------------------------

export interface ReserveFacts {
  stage: string | null;
  soState: string | null;
  sender: string | null;
  reference: string | null;
  route: RouteCodes | null;
  lines: { skuCode: string | null; qty: number; mrp: number | null }[];
}

/** Why a transfer cannot be sent to Uniware now, or null (plan 5.4 reserve). */
export const reserveBlock = (f: ReserveFacts): string | null => {
  if (f.stage !== D2C_STAGE.DRAFT) return `it is ${f.stage ?? 'not a draft'}, not a draft`;
  if (f.soState === R.CREATED) return 'its sale order is already in Uniware';
  if (f.soState === R.REQUESTED || f.soState === R.UNKNOWN) return `its sale order request is ${f.soState}: wait until it is resolved`;
  if (!f.sender) return 'it has no dispatch facility';
  if (!f.reference) return 'it has no reference ID';
  if (!f.route) return 'no route (Uniware channel / customer) for its dispatch facility and location: add it in Masters';
  if (!f.route.uniwareChannelCode) return 'its route has no Uniware channel code: add it in Masters';
  if (!f.route.customerCode) return 'its route has no Uniware customer code: add it in Masters';
  const active = f.lines.filter((l) => l.qty > 0);
  if (!active.length) return 'it has no line with a quantity';
  const noMrp = active.filter((l) => l.mrp === null).map((l) => l.skuCode ?? '?');
  if (noMrp.length) return `no MRP for ${noMrp.join(', ')} (the SO price is 15% of MRP)`;
  return null;
};

export type CreateOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };

/**
 * What the answer to the create call means: created; failed (Uniware refused it, nothing exists); or reconcile
 * (duplicate code = an earlier request got through, or no answer = it may have): the SO is looked up by its code.
 */
export const decideAfterCreate = (o: CreateOutcome): { state: 'created' | 'failed' | 'reconcile'; error: string | null } => {
  if (o.ok) return { state: R.CREATED, error: null };
  const c = classify(o.error);
  if (c === 'refused') return { state: R.FAILED, error: errorText(o.error) };
  return { state: 'reconcile', error: c === 'duplicate' ? `Uniware already has this SO code (${errorText(o.error)})` : `no answer from Uniware: ${errorText(o.error)}` };
};

export type GetOutcome = { kind: 'found'; so: SoView } | { kind: 'not_found' } | { kind: 'error'; error: unknown };

/**
 * A lookup of an SO request by its code: found with OUR reference -> created; found with another reference -> stays
 * unknown (someone must look: the code is ours but the order does not match); Uniware answered "unknown code" ->
 * failed (safe: a retry sends the same code, which Uniware refuses as a duplicate if it shows up later); the lookup
 * itself failed -> stays unknown (never failed while we cannot see).
 */
export const decideAfterGet = (g: GetOutcome, reference: string | null): { state: 'created' | 'failed' | 'unknown'; error: string | null } => {
  if (g.kind === 'error') return { state: R.UNKNOWN, error: `could not check Uniware: ${errorText(g.error)}` };
  if (g.kind === 'not_found') return { state: R.FAILED, error: 'not found in Uniware after the request: try again (the same SO code is sent)' };
  if ((g.so.displayOrderCode ?? '') === (reference ?? '')) return { state: R.CREATED, error: null };
  return { state: R.UNKNOWN, error: `SO ${g.so.code} in Uniware has reference ${g.so.displayOrderCode ?? '-'}, not ${reference ?? '-'}: check it in Uniware` };
};

// ---- create SO: one transfer -----------------------------------------------------------------------------------------

export interface SoResult {
  uid: string; transferCode: string | null; outcome: 'created' | 'failed' | 'unknown' | 'skipped'; soCode: string | null; error: string | null; code?: string;
}

const resultOfError = (uid: string, err: unknown): SoResult => {
  const e = err instanceof AppError ? err : null;
  return { uid, transferCode: null, outcome: 'skipped', soCode: null, error: e ? e.message : errorText(err), code: e?.code };
};

/** Reserve (locked): checks, SO code, soState requested. Returns what to send. */
const reserve = async (uid: string, by: Actor, stockWarning: string | null): Promise<{ input: SoInput; transferCode: string }> =>
  AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    const settings = await readSettings(m);
    const lines = await linesOfTransfer(m, uid);
    const route = await routeOf(m, po);
    const block = reserveBlock({
      stage: po.transferStage, soState: po.soState, sender: po.facility, reference: po.poNumber, route,
      lines: lines.map((l) => ({ skuCode: l.skuCode, qty: liveQty(l), mrp: lineMrp(l) })),
    });
    if (block) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode as string, block);
    if (!settings.channels.includes(po.channel ?? '')) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode as string, `channel ${po.channel ?? '-'} is not a transfer channel in the settings`);
    assertWritable(settings, { sender: po.facility, receiving: await receivingOfLocation(m, po.locationId) }, 'sender');
    const code = po.orderNo1 || (await takeSoCode(m, todayIst()));
    const input: SoInput = {
      code, displayOrderCode: po.poNumber as string, channel: route!.uniwareChannelCode as string, customerCode: route!.customerCode as string,
      facility: po.facility as string,
      lines: lines.filter((l) => liveQty(l) > 0).map((l) => ({ lineId: l.id, skuCode: l.skuCode as string, qty: liveQty(l), mrp: lineMrp(l) as number })),
    };
    const now = nowSeconds();
    await m.getRepository(MasterPurchaseOrder).update({ uid }, {
      orderNo1: code, soState: R.REQUESTED, soRequestedAt: new Date(), soError: null, customerCode: route!.customerCode, updatedAt: now,
    });
    const logs: LogRow[] = [];
    if (stockWarning) logs.push({ uid, action: SHIPMENT_LOG_ACTION.STOCK_WARNING, source: SHIPMENT_LOG_SOURCE.TOOL_API, remark: stockWarning.slice(0, 2000) });
    logs.push({ uid, action: SHIPMENT_LOG_ACTION.SO_REQUESTED, source: SHIPMENT_LOG_SOURCE.TOOL_API, field: 'orderNo1', oldValue: po.orderNo1, newValue: code, remark: trim({ facility: input.facility, request: input }) });
    await writeLogs(m, logs, randomUUID(), by.id);
    return { input, transferCode: po.transferCode as string };
  });

/**
 * Applies a decided SO state under the row lock, only while the request is still ours (soState requested / unknown
 * with the same code): a sync may have resolved it meanwhile. Returns the state the transfer has afterwards.
 */
const applySoState = async (
  uid: string, code: string, state: 'created' | 'failed' | 'unknown', error: string | null, by: Actor | null, remark: string | null, uniwareStatus: string | null,
): Promise<string | null> => {
  const after = await AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    if (po.orderNo1 !== code || (po.soState !== R.REQUESTED && po.soState !== R.UNKNOWN)) return po.soState;
    if (state === R.UNKNOWN && po.soState === R.UNKNOWN && po.soError === error) return po.soState;
    const now = nowSeconds();
    const header: Partial<MasterPurchaseOrder> = { soState: state, soError: state === R.CREATED ? null : error, updatedAt: now };
    const stage = state === R.CREATED ? stageOf(po, R.CREATED, await linesOfTransfer(m, uid), await invoicesOf(m, uid)) : po.transferStage;
    if (state === R.CREATED && stage) Object.assign(header, stageFields(po, stage, now));
    await setHeader(m, uid, header);
    // unknown has no action of its own: a sync_error row (the request's answer is not known yet)
    const action = state === R.CREATED ? SHIPMENT_LOG_ACTION.SO_CREATED : state === R.FAILED ? SHIPMENT_LOG_ACTION.SO_FAILED : SHIPMENT_LOG_ACTION.SYNC_ERROR;
    const source = by ? SHIPMENT_LOG_SOURCE.TOOL_API : SHIPMENT_LOG_SOURCE.SYSTEM;
    const logs: LogRow[] = [{
      uid, action, source, field: 'soState', oldValue: po.soState, newValue: state, remark: [error, remark].filter(Boolean).join(' | ').slice(0, 4000) || null, uniwareStatus,
    }];
    if (stage !== po.transferStage) logs.push({ uid, action: SHIPMENT_LOG_ACTION.STAGE_CHANGED, source, field: 'transferStage', oldValue: po.transferStage, newValue: stage, uniwareStatus });
    await writeLogs(m, logs, randomUUID(), by?.id ?? null);
    return state;
  });
  done();
  return after;
};

/** One transfer: reserve -> call -> confirm (-> reconcile). Never throws: the result says what happened. */
const createSoFor = async (uid: string, by: Actor, api?: UniwarePoster, stockWarning: string | null = null): Promise<SoResult> => {
  let reserved: { input: SoInput; transferCode: string };
  try {
    reserved = await reserve(uid, by, stockWarning);
  } catch (err) {
    return resultOfError(uid, err);
  }
  done();
  const { input, transferCode } = reserved;
  const base = { uid, transferCode, soCode: input.code };
  let outcome: CreateOutcome;
  try {
    const client = api ?? uniwareClient();
    outcome = { ok: true, response: (await createSaleOrder(client, input)).response };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const d = decideAfterCreate(outcome);
  try {
    if (d.state !== 'reconcile') {
      const respText = outcome.ok ? trim(outcome.response) : null;
      const state = await applySoState(uid, input.code, d.state, d.error, by, respText, null);
      return { ...base, outcome: state === R.CREATED ? 'created' : state === R.FAILED ? 'failed' : 'unknown', error: d.error };
    }
    await applySoState(uid, input.code, R.UNKNOWN, d.error, by, null, null);
    const r = await reconcileSo(uid, { api, by, graceMs: 0 });
    return { ...base, outcome: r.state === R.CREATED ? 'created' : r.state === R.FAILED ? 'failed' : 'unknown', error: r.error ?? d.error };
  } catch (err) {
    // the database failed after the call: the request stays requested / unknown; the sync reconciles it
    log.error(LOG_SOURCE.APP, `${LOG} confirm failed`, { uid, error: errorText(err) });
    return { ...base, outcome: 'unknown', error: `saved state unclear: ${errorText(err)}` };
  }
};

/** The SO-request facts reconcile reads (a master_purchase_orders row). */
export type ReconcileFacts = Pick<MasterPurchaseOrder, 'soState' | 'soRequestedAt' | 'orderNo1' | 'facility' | 'poNumber'>;
export type ReconcileCheck =
  | { checked: false; why: string }
  | { checked: true; state: 'created' | 'failed' | 'unknown'; error: string | null; remark: string | null; uniwareStatus: string | null };

/** Default grace before a request is looked up (plan 5.4: > the 120 s timeout + 429 back-off). */
const SO_RECONCILE_GRACE_MS = 15 * 60_000;

/**
 * The Uniware half of a reconcile (no database): skips what is not in flight or still within the grace; else looks
 * the SO up by its code at the sender and decides with decideAfterGet.
 */
export const reconcileCheck = async (po: ReconcileFacts, api: UniwarePoster, graceMs = SO_RECONCILE_GRACE_MS, now = Date.now()): Promise<ReconcileCheck> => {
  if (po.soState !== R.REQUESTED && po.soState !== R.UNKNOWN) return { checked: false, why: `soState ${po.soState ?? 'none'}` };
  if (!po.orderNo1 || !po.facility) return { checked: false, why: 'no SO code or sender' };
  if (graceMs > 0 && po.soRequestedAt && now - new Date(po.soRequestedAt).getTime() < graceMs) return { checked: false, why: 'still within the grace period' };
  let g: GetOutcome;
  try {
    const { so } = await getSaleOrder(api, po.orderNo1, po.facility);
    g = so ? { kind: 'found', so } : { kind: 'not_found' };
  } catch (error) {
    g = { kind: 'error', error };
  }
  const d = decideAfterGet(g, po.poNumber);
  return {
    checked: true, state: d.state, error: d.error,
    remark: g.kind === 'found' ? trim({ code: g.so.code, status: g.so.status, displayOrderCode: g.so.displayOrderCode, items: g.so.items }) : null,
    uniwareStatus: g.kind === 'found' ? statusLine(g.so) : null,
  };
};

/**
 * Reconcile an SO request in soState requested / unknown (plan 5.4 step 3; the sync of phase 6 calls it per
 * transfer): reconcileCheck, then the decision applied under the row lock (only while the request is still the same).
 * @public
 */
export const reconcileSo = async (
  uid: string, o: { api?: UniwarePoster; by?: Actor | null; graceMs?: number } = {},
): Promise<{ state: string | null; error: string | null; checked: boolean }> => {
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });
  if (!po || !po.transferCode) throw appError(ERROR_CODES.D2C_NOT_FOUND, uid);
  if (po.soState !== R.REQUESTED && po.soState !== R.UNKNOWN) return { state: po.soState, error: po.soError, checked: false };
  const c = await reconcileCheck(po, o.api ?? uniwareClient(), o.graceMs);
  if (!c.checked) return { state: po.soState, error: po.soError, checked: false };
  const state = await applySoState(uid, po.orderNo1 as string, c.state, c.error, o.by ?? null, c.remark, c.uniwareStatus);
  return { state, error: c.error, checked: true };
};

// ---- create SO: many (background job) --------------------------------------------------------------------------------

export interface SoJob {
  id: string; status: 'running' | 'done'; total: number; done: number; startedAt: string; finishedAt: string | null; results: SoResult[];
}
const jobs = new Map<string, SoJob>();

const prune = () => {
  const cutoff = Date.now() - D2C_SO_JOBS.KEEP_MS;
  for (const [id, j] of jobs) if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) jobs.delete(id);
};

/** Runs `work` over items, at most `limit` at a time. */
export const runPool = async <T>(items: T[], limit: number, work: (t: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const t = items[next++];
      await work(t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
};

/** { ids: string[] } -> unique checked ids (400 on a bad list). */
const idsOf = (body: unknown): string[] => {
  const raw = (body && typeof body === 'object' ? (body as Record<string, unknown>).ids : undefined);
  if (!Array.isArray(raw) || !raw.length) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'ids', code: ERROR_CODES.FIELD_REQUIRED, message: 'ids must be a non-empty list of transfer ids' }]);
  }
  if (raw.length > D2C_SO_JOBS.MAX_IDS) throw appError(ERROR_CODES.D2C_TOO_MANY, D2C_SO_JOBS.MAX_IDS);
  return [...new Set(raw.map((x) => checkId(String(x))))];
};

/**
 * POST /create-so { ids, stockWarnings?: { [id]: text } } -> 202 { jobId, total, results } (results so far: ids the
 * gate refuses at once). The rest runs in the background, CONCURRENCY at a time; each result is also a log row + live
 * change. 409 D2C_NOT_LIVE when the gate refuses every id.
 */
export const startCreateSo = async (body: unknown, by: Actor, api?: UniwarePoster): Promise<SoJob> => {
  const ids = idsOf(body);
  const warnings = (body as { stockWarnings?: Record<string, unknown> }).stockWarnings ?? {};
  const settings = await readSettings();
  const heads = await AppDataSource.query<{ uid: string | number; transferCode: string | null; facility: string | null; receiving: string | null }[]>(
    `SELECT p.uid, p.transferCode, p.facility, f.code receiving FROM ${TABLES.MASTER_PURCHASE_ORDERS} p
       LEFT JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = p.locationId LEFT JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id
      WHERE p.uid IN (?)`, [ids],
  );
  const byId = new Map(heads.map((h) => [String(h.uid), h]));
  const pre: SoResult[] = [];
  const todo: string[] = [];
  for (const id of ids) {
    const h = byId.get(id);
    if (!h || !h.transferCode) pre.push({ uid: id, transferCode: null, outcome: 'skipped', soCode: null, error: `No internal transfer ${id}`, code: ERROR_CODES.D2C_NOT_FOUND });
    else if (!uniwareWritesAllowed(settings, env.d2c.uniwareWrites, { sender: h.facility, receiving: h.receiving }, 'sender')) {
      const e = gateError({ sender: h.facility, receiving: h.receiving });
      pre.push({ uid: id, transferCode: h.transferCode, outcome: 'skipped', soCode: null, error: e.message, code: e.code });
    } else todo.push(id);
  }
  if (!todo.length && pre.length && pre.every((p) => isGateCode(p.code))) {
    const lanes = [...new Set(pre.map((p) => laneText(byId.get(p.uid)?.facility, byId.get(p.uid)?.receiving)))].join(', ');
    throw appError(env.d2c.testOnly ? ERROR_CODES.D2C_TEST_ONLY : ERROR_CODES.D2C_NOT_LIVE, lanes);
  }
  prune();
  const job: SoJob = { id: randomUUID(), status: 'running', total: ids.length, done: pre.length, startedAt: new Date().toISOString(), finishedAt: null, results: [...pre] };
  jobs.set(job.id, job);
  const finish = () => {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
  };
  if (!todo.length) finish();
  else {
    void runPool(todo, D2C_SO_JOBS.CONCURRENCY, async (id) => {
      const w = warnings[id];
      const r = await createSoFor(id, by, api, typeof w === 'string' && w.trim() ? w.trim() : null);
      job.results.push(r);
      job.done += 1;
    }).catch((err) => log.error(LOG_SOURCE.APP, `${LOG} job failed`, { job: job.id, error: errorText(err) })).finally(finish);
  }
  return job;
};

/** GET /jobs/:jobId (this server's memory; a restart forgets it, the list still shows each transfer's soState). */
export const soJob = (id: string): SoJob => {
  const j = jobs.get(id);
  if (!j) throw appError(ERROR_CODES.D2C_JOB_NOT_FOUND, id);
  return j;
};

// ---- stock check -----------------------------------------------------------------------------------------------------

export interface StockLine {
  lineId: string; skuCode: string; needed: number; inventory: number; openSale: number; inventoryBlocked: number; available: number;
  short: boolean; shortOverall: boolean;
}

/**
 * Per line: short when needed > available. shortOverall: the selected transfers of the same sender together need more
 * of that SKU than is available (each alone may fit).
 */
export const markShort = (lines: { key: string; needed: number; available: number }[]): { short: boolean; shortOverall: boolean }[] => {
  const total = new Map<string, number>();
  for (const l of lines) total.set(l.key, (total.get(l.key) ?? 0) + l.needed);
  return lines.map((l) => ({ short: l.needed > l.available, shortOverall: (total.get(l.key) ?? 0) > l.available }));
};

/**
 * POST /stock-check { ids } (read only): per transfer and line, needed vs available at the sender.
 * available = inventory - openSale - inventoryBlocked (never below 0). Warnings only: Ops may still go on.
 */
export const stockCheck = async (body: unknown, api?: UniwarePoster) => {
  const ids = idsOf(body);
  const heads = await AppDataSource.query<{ uid: string | number; transferCode: string | null; facility: string | null; transferStage: string | null }[]>(
    `SELECT uid, transferCode, facility, transferStage FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE uid IN (?) AND transferCode IS NOT NULL ORDER BY uid`, [ids],
  );
  const lines = heads.length
    ? await AppDataSource.getRepository(DetailsPurchaseOrder).createQueryBuilder('l').where('l.shipmentOrderId IN (:...uids)', { uids: heads.map((h) => String(h.uid)) }).orderBy('l.id').getMany()
    : [];
  const byFacility = new Map<string, Set<string>>();
  for (const h of heads) {
    if (!h.facility) continue;
    const set = byFacility.get(h.facility) ?? new Set<string>();
    for (const l of lines) if (l.shipmentOrderId === String(h.uid) && liveQty(l) > 0 && l.skuCode) set.add(l.skuCode);
    byFacility.set(h.facility, set);
  }
  const client = api ?? uniwareClient();
  const stock = new Map<string, Map<string, { inventory: number; openSale: number; inventoryBlocked: number; available: number }>>();
  const errors = new Map<string, string>();
  for (const [facility, skus] of byFacility) {
    try {
      stock.set(facility, await stockAt(client, facility, [...skus]));
    } catch (err) {
      errors.set(facility, errorText(err));
    }
  }
  const flat: { uid: string; line: DetailsPurchaseOrder; facility: string; s: { inventory: number; openSale: number; inventoryBlocked: number; available: number } }[] = [];
  for (const h of heads) {
    const s = h.facility ? stock.get(h.facility) : undefined;
    if (!s) continue;
    for (const l of lines) {
      if (l.shipmentOrderId !== String(h.uid) || liveQty(l) <= 0 || !l.skuCode) continue;
      flat.push({ uid: String(h.uid), line: l, facility: h.facility as string, s: s.get(l.skuCode.toLowerCase()) ?? { inventory: 0, openSale: 0, inventoryBlocked: 0, available: 0 } });
    }
  }
  const marks = markShort(flat.map((f) => ({ key: `${f.facility}\u0000${(f.line.skuCode as string).toLowerCase()}`, needed: liveQty(f.line), available: f.s.available })));
  const linesBy = new Map<string, StockLine[]>();
  flat.forEach((f, i) => {
    const arr = linesBy.get(f.uid) ?? [];
    arr.push({ lineId: f.line.id, skuCode: f.line.skuCode as string, needed: liveQty(f.line), ...f.s, ...marks[i] });
    linesBy.set(f.uid, arr);
  });
  const found = new Set(heads.map((h) => String(h.uid)));
  return {
    formula: 'available = inventory - openSale - inventoryBlocked (never below 0)',
    transfers: [
      ...heads.map((h) => {
        const ls = linesBy.get(String(h.uid)) ?? [];
        return {
          uid: String(h.uid), transferCode: h.transferCode, facility: h.facility, stage: h.transferStage,
          error: h.facility ? errors.get(h.facility) ?? null : 'no dispatch facility', short: ls.some((l) => l.short || l.shortOverall), lines: ls,
        };
      }),
      ...ids.filter((id) => !found.has(id)).map((id) => ({ uid: id, transferCode: null, facility: null, stage: null, error: `No internal transfer ${id}`, short: false, lines: [] as StockLine[] })),
    ],
  };
};

// ---- cancel ----------------------------------------------------------------------------------------------------------

/** Item codes of an SO grouped by what the tool can do with them. */
const openItemsOf = (so: SoView) => ({
  open: so.items.filter(isOpenItem),
  shipped: so.items.filter((i) => !isOpenItem(i) && !isCancelledItem(i)),
});

/** Why a transfer with an SO cannot be cancelled (plan 5.6: only before any dispatch), or null. */
export const cancelBlock = (po: Pick<MasterPurchaseOrder, 'transferStage' | 'soState'>, dispatched: number, dispatchedInvoices: number): string | null => {
  if (po.transferStage === D2C_STAGE.CANCELLED) return 'it is already cancelled';
  if (po.soState === R.REQUESTED || po.soState === R.UNKNOWN) return `its sale order request is ${po.soState}: wait until it is resolved`;
  if (!D2C_UNDISPATCHED_STAGES.includes(po.transferStage ?? '')) return `it is ${po.transferStage}: something was dispatched, use Close short`;
  if (dispatched > 0 || dispatchedInvoices > 0) return 'something was dispatched: use Close short';
  return null;
};

const sumDispatched = (lines: DetailsPurchaseOrder[]) => lines.reduce((s, l) => s + (l.dispatchedQty ?? 0), 0);

/** Uniware call failures as the API answers them (nothing changed in the tool). */
const uniwareError = (transferCode: string, err: unknown): AppError =>
  (refusalOf(err) ? appError(ERROR_CODES.D2C_UNIWARE_REFUSED, transferCode, errorText(err)) : appError(ERROR_CODES.D2C_UNIWARE_DOWN, transferCode, errorText(err)));

const readSo = async (api: UniwarePoster, po: MasterPurchaseOrder): Promise<SoView> => {
  try {
    const { so } = await getSaleOrder(api, po.orderNo1 as string, po.facility as string);
    if (!so) throw appError(ERROR_CODES.D2C_UNIWARE_REFUSED, po.transferCode as string, `SO ${po.orderNo1} not found at ${po.facility}`);
    return so;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw uniwareError(po.transferCode as string, err);
  }
};

/** A re-read after a cancel, for the log (never fails the action). */
const reread = async (api: UniwarePoster, po: MasterPurchaseOrder): Promise<SoView | null> => {
  try {
    return (await getSaleOrder(api, po.orderNo1 as string, po.facility as string)).so;
  } catch {
    return null;
  }
};

/**
 * POST /:id/cancel { reason }. No SO (soState NULL / failed): the draft is cancelled (no Uniware call). With an SO:
 * allowed until something is dispatched; the gate applies; the SO is read, every open item is cancelled in Uniware
 * (all in one call), and only when Uniware accepts is the transfer set to cancelled. A refusal changes nothing.
 */
export const cancelTransfer = async (rawId: string, body: unknown, by: Actor, api?: UniwarePoster) => {
  const uid = checkId(rawId);
  const reason = reasonOf(body);
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });
  if (!po || !po.transferCode) throw appError(ERROR_CODES.D2C_NOT_FOUND, uid);
  if (po.soState === R.REQUESTED || po.soState === R.UNKNOWN) throw appError(ERROR_CODES.D2C_IN_FLIGHT, po.transferCode);
  if (po.soState !== R.CREATED) return { ...(await cancelDraft(uid, { reason }, by)), uniware: null };

  const lines = await linesOfTransfer(AppDataSource.manager, uid);
  const invoices = await invoicesOf(AppDataSource.manager, uid);
  const block = cancelBlock(po, sumDispatched(lines), invoices.filter((i) => i.dispatchedAt).length);
  if (block) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode, block);
  assertWritable(await readSettings(), { sender: po.facility, receiving: await receivingOfLocation(AppDataSource.manager, po.locationId) }, 'sender');
  const client = api ?? uniwareClient();
  const so = await readSo(client, po);
  const { open, shipped } = openItemsOf(so);
  if (shipped.length) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode, `Uniware shows shipped items (${shipped.map((i) => `${i.itemSku} ${i.statusCode}`).join(', ')}): use Close short`);
  let response: unknown = null;
  if (open.length) {
    try {
      response = (await cancelSaleOrderItems(client, { code: po.orderNo1 as string, facility: po.facility as string, itemCodes: open.map((i) => i.code), reason })).response;
    } catch (err) {
      throw uniwareError(po.transferCode, err);
    }
  }
  const after = await reread(client, po);
  const status = after ? statusLine(after) : `${so.status} (cancel sent for ${open.length} item(s))`;
  await AppDataSource.transaction(async (m) => {
    const cur = await lockTransfer(m, uid);
    if (cur.transferStage === D2C_STAGE.CANCELLED) return;
    const now = nowSeconds();
    await setHeader(m, uid, { ...stageFields(cur, D2C_STAGE.CANCELLED, now), updatedAt: now });
    await m.getRepository(DetailsPurchaseOrder).update({ shipmentOrderId: uid }, { updatedQty: 0, updatedGmv: 0, updatedPoValue: 0, updatedAt: now });
    await writeLogs(m, [{
      uid, action: SHIPMENT_LOG_ACTION.CANCELLED, source: SHIPMENT_LOG_SOURCE.TOOL_API, field: 'transferStage', oldValue: cur.transferStage, newValue: D2C_STAGE.CANCELLED,
      remark: `${reason} | Uniware: cancelled ${open.map((i) => i.code).join(', ') || 'nothing open'} ${response ? trim(response, 1000) : ''}`.trim().slice(0, 4000), uniwareStatus: status,
    }], randomUUID(), by.id);
  });
  done();
  return { uid, stage: D2C_STAGE.CANCELLED, uniware: { soCode: po.orderNo1, cancelledItems: open.map((i) => i.code), status } };
};

// ---- close short -----------------------------------------------------------------------------------------------------

export interface LineRef { id: string; skuCode: string | null }

/** The transfer line of an SO item: by our item code L<lineId>, else by SKU. */
export const lineOfItem = (item: Pick<SoItem, 'code' | 'itemSku'>, lines: LineRef[]): LineRef | undefined =>
  lines.find((l) => itemCodeOf(l.id) === item.code) ?? lines.find((l) => (l.skuCode ?? '').toLowerCase() === item.itemSku.toLowerCase());

/** Close short: which SO items to cancel (every open one) and which cannot be (with why). */
export const closeShortPlan = (so: SoView, lines: LineRef[]) => {
  const cancel: { itemCode: string; sku: string; lineId: string | null }[] = [];
  const skipped: { itemCode: string; sku: string; why: string }[] = [];
  for (const i of so.items) {
    if (isCancelledItem(i)) continue;
    if (!isOpenItem(i)) {
      skipped.push({ itemCode: i.code, sku: i.itemSku, why: `already ${i.statusCode}` });
      continue;
    }
    cancel.push({ itemCode: i.code, sku: i.itemSku, lineId: lineOfItem(i, lines)?.id ?? null });
  }
  return { cancel, skipped };
};

/**
 * The new updatedQty of a line whose item was cancelled: what Uniware says was not cancelled (total - cancelled) when
 * it reports both, never below what was dispatched; else what was dispatched.
 */
export const closedQty = (dispatched: number, item: Pick<SoItem, 'totalQuantity' | 'cancelledQuantity'> | undefined): number => {
  if (item && item.totalQuantity !== null && item.cancelledQuantity !== null) return Math.max(dispatched, item.totalQuantity - item.cancelledQuantity);
  return dispatched;
};

/**
 * POST /:id/close-short { reason }: SO created, an open balance, gate. Reads the SO and cancels every item still open,
 * one call per item so that each refusal is known by name. Lines whose item Uniware cancelled get updatedQty = the
 * part not cancelled (see closedQty); others keep theirs. balanceClosedReason = close_short; stage recomputed (nothing
 * dispatched and nothing left = cancelled). When Uniware cancels nothing, nothing changes (422 with the reasons).
 */
export const closeShort = async (rawId: string, body: unknown, by: Actor, api?: UniwarePoster) => {
  const uid = checkId(rawId);
  const reason = reasonOf(body);
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });
  if (!po || !po.transferCode) throw appError(ERROR_CODES.D2C_NOT_FOUND, uid);
  if (po.soState === R.REQUESTED || po.soState === R.UNKNOWN) throw appError(ERROR_CODES.D2C_IN_FLIGHT, po.transferCode);
  if (po.soState !== R.CREATED) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode, 'it has no sale order in Uniware: cancel the draft instead');
  if (D2C_FINAL_STAGES.includes(po.transferStage ?? '')) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode, `it is ${po.transferStage}`);
  const lines = await linesOfTransfer(AppDataSource.manager, uid);
  const balance = lines.reduce((s, l) => s + Math.max(0, liveQty(l) - (l.dispatchedQty ?? 0)), 0);
  if (balance <= 0) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode, 'nothing is left to close');
  assertWritable(await readSettings(), { sender: po.facility, receiving: await receivingOfLocation(AppDataSource.manager, po.locationId) }, 'sender');
  const client = api ?? uniwareClient();
  const so = await readSo(client, po);
  const plan = closeShortPlan(so, lines);
  if (!plan.cancel.length) {
    throw appError(ERROR_CODES.D2C_UNIWARE_REFUSED, po.transferCode, `no open item to cancel in Uniware${plan.skipped.length ? ` (${plan.skipped.map((s) => `${s.sku} ${s.why}`).join(', ')})` : ''}: the sync will update the transfer`);
  }
  const cancelled: typeof plan.cancel = [];
  const refused: { itemCode: string; sku: string; why: string }[] = [];
  for (const c of plan.cancel) {
    try {
      await cancelSaleOrderItems(client, { code: po.orderNo1 as string, facility: po.facility as string, itemCodes: [c.itemCode], reason });
      cancelled.push(c);
    } catch (err) {
      refused.push({ itemCode: c.itemCode, sku: c.sku, why: refusalOf(err) ? errorText(err) : `no answer (${errorText(err)}): the sync will show if it was cancelled` });
    }
  }
  if (!cancelled.length) {
    throw appError(ERROR_CODES.D2C_UNIWARE_REFUSED, po.transferCode, refused.map((r) => `${r.sku}: ${r.why}`).join('; '))
      .withDetails(refused.map((r) => ({ field: r.sku, itemCode: r.itemCode, message: `${r.sku}: ${r.why}` })));
  }
  const after = await reread(client, po);
  const afterBy = new Map((after?.items ?? []).map((i) => [i.code, i]));
  const result = await AppDataSource.transaction(async (m) => {
    const cur = await lockTransfer(m, uid);
    const curLines = await linesOfTransfer(m, uid);
    const now = nowSeconds();
    const newQty = new Map<string, number>();
    const changes: string[] = [];
    for (const c of cancelled) {
      const line = curLines.find((l) => l.id === c.lineId);
      if (!line) continue;
      const q = closedQty(line.dispatchedQty ?? 0, afterBy.get(c.itemCode));
      if (q >= liveQty(line)) continue;
      newQty.set(line.id, q);
      const qty = line.qty ?? 0;
      const unitGmv = qty ? Number(line.gmv ?? 0) / qty : 0;
      const unitPo = qty ? Number(line.poValue ?? 0) / qty : 0;
      await m.getRepository(DetailsPurchaseOrder).update({ id: line.id }, { updatedQty: q, updatedGmv: round2(unitGmv * q), updatedPoValue: round2(unitPo * q), updatedAt: now });
      changes.push(`${line.skuCode} ${liveQty(line)} -> ${q}`);
    }
    const stage = stageOf(cur, cur.soState, curLines, await invoicesOf(m, uid), newQty);
    await setHeader(m, uid, { balanceClosedReason: D2C_BALANCE_CLOSED_REASON.CLOSE_SHORT, ...stageFields(cur, stage, now), updatedAt: now });
    const logs: LogRow[] = [{
      uid, action: SHIPMENT_LOG_ACTION.BALANCE_CLOSED, source: SHIPMENT_LOG_SOURCE.TOOL_API, field: 'balanceClosedReason', oldValue: cur.balanceClosedReason,
      newValue: D2C_BALANCE_CLOSED_REASON.CLOSE_SHORT,
      remark: [reason, `cancelled in Uniware: ${cancelled.map((c) => c.sku).join(', ')}`, changes.length ? `updated qty: ${changes.join(', ')}` : '',
        refused.length ? `not cancelled: ${refused.map((r) => `${r.sku} (${r.why})`).join(', ')}` : '', plan.skipped.length ? `already ${plan.skipped.map((s) => `${s.sku} ${s.why}`).join(', ')}` : '']
        .filter(Boolean).join(' | ').slice(0, 4000),
      uniwareStatus: after ? statusLine(after) : null,
    }];
    if (stage !== cur.transferStage) logs.push({ uid, action: SHIPMENT_LOG_ACTION.STAGE_CHANGED, source: SHIPMENT_LOG_SOURCE.TOOL_API, field: 'transferStage', oldValue: cur.transferStage, newValue: stage });
    await writeLogs(m, logs, randomUUID(), by.id);
    return { stage, changes };
  });
  done();
  return {
    uid, stage: result.stage, cancelled: cancelled.map((c) => ({ itemCode: c.itemCode, sku: c.sku })), refused, skipped: plan.skipped, updated: result.changes,
  };
};
