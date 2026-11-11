import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  D2C_INWARD_PO, D2C_PACKAGE_STATUS, D2C_REQUEST_STATE, D2C_STAGE, D2C_VARIANCE_REASON, d2cInwardPoCode, ERROR_CODES, SHIPMENT_LOG_ACTION,
  SHIPMENT_LOG_SOURCE, TABLES,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoInvoice, PoInvoiceSkuQty } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { flushChanges } from '../po-overview/po-overview.live';
import { addDays, todayIst } from './reference';
import { readSettings } from './settings';
import { gateError, isGateCode, routeOf, runPool, uniwareWritesAllowed } from './so.service';
import { assertTestTransfer, laneText, receivingOfLocation } from './test-mode';
import { deriveStage, statusTextsOf } from './stage';
import { joinInwardCodes, stageInvoices, varianceOf } from './sync-plan';
import { Actor, linesOfTransfer, lockTransfer, LogRow, nowSeconds, writeLogs } from './transfers.service';
import {
  classifyPo, createPurchaseOrder, errorText, getPurchaseOrder, InwardPoInput, InwardPoItem, PoDetail, trim, uniwareClient, UniwarePoster,
} from './uniware-transfers';

/*
 * Inward POs of D2C internal transfers (phase 7; plan 1.1, 1.3, 1.4, 2.3, 5.5, 5.6 variance + the user's answers of
 * 2026-11-03: one inward PO per DISPATCHED invoice, code <SO code>-<n>, unit price 1, vendor = the route's vendor_code,
 * the warehouse approves the PO in Uniware, the tool only creates it; nothing automatic).
 *
 *   POST /create-inward-po { invoiceIds }   202 + job: per invoice, independently, 2 at a time:
 *       reserve (locked txn on its transfer)  SO created, invoice dispatched, inward_po_state NULL / failed, receiving
 *                                             facility known, route with a vendor code, SKUs with dispatched > 0, gate
 *                                             (the SENDER facility, as for the SO); code taken once (kept on retries);
 *                                             sku_qty.inward = what is sent; state requested; log inward_po_requested;
 *       call (no txn)                         purchaseOrder/create at the RECEIVING facility;
 *       confirm (locked txn)                  success -> created, header poNumberInwardCWH re-joined, stage recomputed,
 *                                             log inward_po_created; refused -> failed (+ error), log inward_po_failed;
 *                                             duplicate code / HTTP / timeout -> unknown, then reconcileInwardPo():
 *                                             details by our code -> found with our SO code in ReferenceNo -> created;
 *                                             "invalid code" -> failed (a retry sends the same code); get error -> stays unknown.
 *   POST /invoices/:invoiceId/variance-reason { reason, note }   once the invoice is GRN-complete with variance != 0
 *                                             and no reason yet; logged; stage recomputed (may close the transfer).
 * The GRN read is in the sync (sync.service.ts / sync-plan.ts planGrn). Uniware calls never run inside a transaction.
 */

const R = D2C_REQUEST_STATE;
const LOG = '[d2c-inward-po]';

// ---- pure rules (unit-tested) --------------------------------------------------------------------------------------

/** The next n of <SO code>-<n> in a transfer: 1 + the highest n already taken by its invoices. */
export const nextInwardNumber = (soCode: string, codes: (string | null | undefined)[]): number => {
  const prefix = `${soCode}-`;
  let max = 0;
  for (const c of codes) {
    if (!c || !c.startsWith(prefix)) continue;
    const n = Number(c.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
};

/** The invoice's inward PO code: the one it already has (stable on retries), else the next of its transfer. */
export const inwardCodeOf = (soCode: string, own: string | null, siblings: (string | null)[]): string =>
  own || d2cInwardPoCode(soCode, nextInwardNumber(soCode, siblings));

/** Items of an invoice's inward PO: SKU -> dispatched on that invoice (0 left out), in SKU order. */
export const inwardItemsOf = (skuQty: PoInvoiceSkuQty | null | undefined): InwardPoItem[] =>
  Object.entries(skuQty ?? {}).map(([sku, v]) => ({ sku, qty: Math.max(0, Math.round(Number(v?.dispatched ?? 0))) }))
    .filter((i) => i.qty > 0).sort((a, b) => a.sku.localeCompare(b.sku));

/** Expiry / delivery date of the PO: the transfer's expiry when it is today or later, else today + days. */
export const inwardExpiryOf = (labelsLink: string | null, today: string, days: number): string =>
  (labelsLink && /^\d{4}-\d{2}-\d{2}$/.test(labelsLink) && labelsLink >= today ? labelsLink : addDays(today, days));

export interface InwardReserveFacts {
  soState: string | null;
  soCode: string | null;
  reference: string | null;
  sender: string | null;
  receiving: string | null;
  route: { vendorCode?: string | null } | null;
  invoice: Pick<PoInvoice, 'dispatchedAt' | 'packageStatus' | 'inwardPoState' | 'inwardPoCode' | 'skuQty'>;
}

/** Why an inward PO cannot be made for this invoice now, or null (plan 5.5 reserve). */
export const inwardReserveBlock = (f: InwardReserveFacts): string | null => {
  const i = f.invoice;
  if (f.soState !== R.CREATED || !f.soCode) return 'its transfer has no sale order in Uniware';
  if (!i.dispatchedAt || i.packageStatus === D2C_PACKAGE_STATUS.CANCELLED) return 'the invoice is not dispatched';
  if (i.inwardPoState === R.CREATED) return `it already has inward PO ${i.inwardPoCode ?? ''}`.trim();
  if (i.inwardPoState === R.REQUESTED || i.inwardPoState === R.UNKNOWN) {
    return `its inward PO request ${i.inwardPoCode ?? ''} is ${i.inwardPoState}: wait until it is resolved (the sync checks it)`;
  }
  if (!f.reference) return 'its transfer has no reference ID';
  if (!f.receiving) return 'no receiving facility for the transfer location: fill it in Masters';
  if (!f.route || !f.route.vendorCode) return `vendor code missing on route ${f.sender ?? '-'} -> ${f.receiving}: fill it in Masters`;
  if (!inwardItemsOf(i.skuQty).length) return 'nothing was dispatched on this invoice';
  return null;
};

export type PoCreateOutcome = { ok: true; response: unknown } | { ok: false; error: unknown };

/**
 * created; failed (Uniware refused, nothing exists); reconcile (duplicate code = an earlier request got through, or no
 * answer = it may have): the PO is looked up by its code.
 */
export const decideAfterPoCreate = (o: PoCreateOutcome): { state: 'created' | 'failed' | 'reconcile'; error: string | null } => {
  if (o.ok) return { state: R.CREATED, error: null };
  const c = classifyPo(o.error);
  if (c === 'refused') return { state: R.FAILED, error: errorText(o.error) };
  return { state: 'reconcile', error: c === 'duplicate' ? `Uniware already has this PO code (${errorText(o.error)})` : `no answer from Uniware: ${errorText(o.error)}` };
};

export type PoGetOutcome = { kind: 'found'; po: PoDetail } | { kind: 'not_found' } | { kind: 'error'; error: unknown };

/**
 * A lookup of an inward PO request by our code: found with OUR SO code in ReferenceNo -> created; found with another ->
 * stays unknown (someone must look); Uniware says the code is invalid -> failed (safe: a retry sends the same code);
 * the lookup itself failed -> stays unknown (never failed while we cannot see).
 */
export const decideAfterPoGet = (g: PoGetOutcome, soCode: string | null): { state: 'created' | 'failed' | 'unknown'; error: string | null } => {
  if (g.kind === 'error') return { state: R.UNKNOWN, error: `could not check Uniware: ${errorText(g.error)}` };
  if (g.kind === 'not_found') return { state: R.FAILED, error: 'not found in Uniware after the request: try again (the same PO code is sent)' };
  const ref = g.po.fields.ReferenceNo ?? null;
  if (ref && ref === soCode) return { state: R.CREATED, error: null };
  return { state: R.UNKNOWN, error: `PO ${g.po.code} in Uniware has ReferenceNo ${ref ?? '-'}, not ${soCode ?? '-'}: check it in Uniware` };
};

/**
 * Why a variance reason cannot be set (or changed: editors may change a saved one, user 2026-11-03, every change logged)
 * on this invoice now, or null (plan 5.6).
 */
export const varianceBlock = (i: Pick<PoInvoice, 'grnCompletedAt' | 'receivedUnits' | 'units' | 'varianceReason'>): string | null => {
  if (!i.grnCompletedAt) return 'its GRN is not complete yet';
  if (varianceOf(i) === 0) return 'it has no variance (received = dispatched)';
  return null;
};

const REASONS = Object.values(D2C_VARIANCE_REASON) as string[];

/** The log remark of a variance reason save: the invoice, then the note (old -> new when it changed). */
export const varianceRemark = (head: string, oldNote: string | null, note: string | null): string =>
  [head, oldNote !== null && oldNote !== note ? `note: ${oldNote} -> ${note ?? '-'}` : note].filter(Boolean).join(' | ').slice(0, 4000);

/** { reason, note } of the variance-reason call (400 with every problem). */
export const varianceBodyOf = (body: unknown): { reason: string; note: string | null } => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
  const problems: { field: string; code: string; message: string }[] = [];
  if (!REASONS.includes(reason)) problems.push({ field: 'reason', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `reason must be one of ${REASONS.join(', ')}` });
  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') problems.push({ field: 'note', code: ERROR_CODES.FIELD_REQUIRED, message: 'note must be text' });
  if (note && note.length > D2C_INWARD_PO.NOTE_MAX) problems.push({ field: 'note', code: ERROR_CODES.FIELD_TOO_LONG, message: `note must be at most ${D2C_INWARD_PO.NOTE_MAX} characters` });
  if (reason === D2C_VARIANCE_REASON.OTHER && !note) problems.push({ field: 'note', code: ERROR_CODES.FIELD_REQUIRED, message: 'a note is required when the reason is "other"' });
  if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  return { reason, note };
};


// ---- shared reads --------------------------------------------------------------------------------------------------

const invoiceNo = (i: Pick<PoInvoice, 'invoiceDisplayCode' | 'invoiceCode' | 'shippingPackageCode'>) => i.invoiceDisplayCode ?? i.invoiceCode ?? i.shippingPackageCode;

/** The receiving facility code of a transfer location (details_channels.transfer_facility_id). */
const receivingOf = receivingOfLocation;

/*
 * The receiving facility an inward PO was made at (fix 2026-11-03, no new column): written at reserve time as the first
 * part of the inward_po_requested log row's remark ("receiving=<code> | <invoice no> | <request>"; new_value = the PO
 * code) and read back from the latest such row for every later call (reconcile, GRN sync, a retry of the same code), so
 * a Masters change of the location's receiving facility never sends us to the wrong facility.
 */
const RECEIVING_TAG = 'receiving='
export const receivingRemark = (receiving: string, rest: string): string => `${RECEIVING_TAG}${receiving} | ${rest}`
export const receivingOfRemark = (remark: string | null | undefined): string | null => {
  if (!remark?.startsWith(RECEIVING_TAG)) return null
  const end = remark.indexOf(' | ')
  const code = (end < 0 ? remark.slice(RECEIVING_TAG.length) : remark.slice(RECEIVING_TAG.length, end)).trim()
  return code || null
}

/** The stored receiving facility of an inward PO code of a transfer, or null when none was recorded. */
export const storedReceivingOf = async (m: EntityManager, uid: string, code: string): Promise<string | null> => {
  const [r] = await m.query<{ remark: string | null }[]>(
    `SELECT remark FROM ${TABLES.SHIPMENT_LOGS} WHERE shipment_uid = ? AND action = ? AND new_value = ? ORDER BY id DESC LIMIT 1`,
    [uid, SHIPMENT_LOG_ACTION.INWARD_PO_REQUESTED, code],
  )
  return receivingOfRemark(r?.remark)
}

/**
 * The receiving facility of an invoice's inward PO: po_invoices.receiving_facility_code (written at reserve time since
 * migration D2cInvoiceReceiving1794100000000), else the log remark of rows requested before it (storedReceivingOf).
 */
export const invoiceReceivingOf = async (
  m: EntityManager, inv: Pick<PoInvoice, 'poUid' | 'inwardPoCode' | 'receivingFacilityCode'>,
): Promise<string | null> => {
  if (inv.receivingFacilityCode) return inv.receivingFacilityCode
  if (!inv.inwardPoCode) return null
  return storedReceivingOf(m, String(inv.poUid), inv.inwardPoCode)
}

/** The transfer uid of an invoice (404 when it is not an invoice of a transfer). */
const uidOfInvoice = async (invoiceId: string): Promise<string> => {
  if (!/^\d{1,19}$/.test(invoiceId)) throw appError(ERROR_CODES.D2C_INVOICE_NOT_FOUND, invoiceId);
  const [r] = await AppDataSource.query<{ uid: string | number }[]>(
    `SELECT i.po_uid uid FROM ${TABLES.PO_INVOICES} i JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = i.po_uid AND p.transferCode IS NOT NULL WHERE i.id = ?`,
    [invoiceId],
  );
  if (!r) throw appError(ERROR_CODES.D2C_INVOICE_NOT_FOUND, invoiceId);
  return String(r.uid);
};

const invoicesOf = (m: EntityManager, uid: string) => m.getRepository(PoInvoice).find({ where: { poUid: uid }, order: { id: 'ASC' } });

/** Stage of a locked transfer + header fields of a change (texts + time). */
const restage = (po: MasterPurchaseOrder, lines: DetailsPurchaseOrder[], invoices: PoInvoice[], now: Date) => {
  const stage = deriveStage({
    stage: po.transferStage, soState: po.soState,
    lines: lines.map((l) => ({ updatedQty: l.updatedQty ?? l.qty ?? 0, dispatched: l.dispatchedQty ?? 0 })),
    invoices: stageInvoices(invoices),
  });
  const fields: Partial<MasterPurchaseOrder> = stage === po.transferStage ? {} : { transferStage: stage, transferStageAt: now, ...statusTextsOf(stage) };
  return { stage, fields };
};

// ---- create: one invoice -------------------------------------------------------------------------------------------

export interface InwardResult {
  invoiceId: string; uid: string | null; transferCode: string | null; invoiceNo: string | null;
  outcome: 'created' | 'failed' | 'unknown' | 'skipped'; inwardPoCode: string | null; error: string | null; code?: string;
}

const resultOfError = (invoiceId: string, err: unknown): InwardResult => {
  const e = err instanceof AppError ? err : null;
  return { invoiceId, uid: null, transferCode: null, invoiceNo: null, outcome: 'skipped', inwardPoCode: null, error: e ? e.message : errorText(err), code: e?.code };
};

interface Reserved { input: InwardPoInput; uid: string; transferCode: string; invoiceNo: string }

const reserve = async (invoiceId: string, by: Actor): Promise<Reserved> => {
  const uid = await uidOfInvoice(invoiceId);
  return AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    const inv = await m.getRepository(PoInvoice).findOneBy({ id: invoiceId });
    if (!inv || String(inv.poUid) !== uid) throw appError(ERROR_CODES.D2C_INVOICE_NOT_FOUND, invoiceId);
    const settings = await readSettings(m);
    // a retry of the same code goes to the facility the first request went to
    const receiving = (inv.inwardPoCode ? await invoiceReceivingOf(m, inv) : null) ?? await receivingOf(m, po.locationId);
    const route = await routeOf(m, po);
    const no = invoiceNo(inv);
    const block = inwardReserveBlock({ soState: po.soState, soCode: po.orderNo1, reference: po.poNumber, sender: po.facility, receiving, route, invoice: inv });
    if (block) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, `${po.transferCode as string} invoice ${no}`, block);
    // the PO is created at the receiving facility: the gate checks it (and, when not open, the sender too)
    if (!uniwareWritesAllowed(settings, env.d2c.uniwareWrites, { sender: po.facility, receiving }, 'receiving')) throw gateError({ sender: po.facility, receiving });
    // every code the transfer ever requested counts (a PO cancelled in Uniware keeps its code there only)
    const requested = await m.query<{ code: string | null }[]>(
      `SELECT new_value code FROM ${TABLES.SHIPMENT_LOGS} WHERE shipment_uid = ? AND action = ?`, [uid, SHIPMENT_LOG_ACTION.INWARD_PO_REQUESTED],
    );
    const siblings = [...(await invoicesOf(m, uid)).map((i) => i.inwardPoCode), ...requested.map((r) => r.code)];
    const code = inwardCodeOf(po.orderNo1 as string, inv.inwardPoCode, siblings);
    const items = inwardItemsOf(inv.skuQty);
    const input: InwardPoInput = {
      code, vendorCode: route!.vendorCode as string, facility: receiving as string, soCode: po.orderNo1 as string, reference: po.poNumber as string,
      expiry: inwardExpiryOf(po.labelsLink, todayIst(), settings.defaultExpiryDays), items,
    };
    const skuQty: PoInvoiceSkuQty = Object.fromEntries(Object.entries(inv.skuQty ?? {}).map(([k, v]) => [k, { ...v, inward: items.find((x) => x.sku === k)?.qty ?? 0 }]));
    await m.getRepository(PoInvoice).update({ id: invoiceId }, {
      inwardPoCode: code, inwardPoState: R.REQUESTED, inwardPoRequestedAt: new Date(), inwardPoError: null, skuQty, receivingFacilityCode: input.facility,
    });
    await m.getRepository(MasterPurchaseOrder).update({ uid }, { updatedAt: nowSeconds() });
    await writeLogs(m, [{
      uid, action: SHIPMENT_LOG_ACTION.INWARD_PO_REQUESTED, source: SHIPMENT_LOG_SOURCE.TOOL_API, field: 'inwardPoCode', oldValue: inv.inwardPoCode, newValue: code,
      remark: receivingRemark(input.facility, `${no} | ${trim({ facility: input.facility, request: input })}`).slice(0, 4000),
    }], randomUUID(), by.id);
    return { input, uid, transferCode: po.transferCode as string, invoiceNo: no };
  });
};

/**
 * Applies a decided inward PO state under the row lock, only while the request is still ours (state requested /
 * unknown with the same code): a sync may have resolved it meanwhile. Returns the invoice's state afterwards.
 */
const applyInwardState = async (
  invoiceId: string, uid: string, code: string, state: 'created' | 'failed' | 'unknown', error: string | null, by: Actor | null, remark: string | null,
  poStatus: string | null,
): Promise<string | null> => {
  const r = await AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    await assertTestTransfer(m, await readSettings(m), po);
    const invoices = await invoicesOf(m, uid);
    const inv = invoices.find((i) => String(i.id) === String(invoiceId));
    if (!inv || inv.inwardPoCode !== code || (inv.inwardPoState !== R.REQUESTED && inv.inwardPoState !== R.UNKNOWN)) return { state: inv?.inwardPoState ?? null, logged: false };
    if (state === R.UNKNOWN && inv.inwardPoState === R.UNKNOWN && inv.inwardPoError === error) return { state, logged: false };
    const now = nowSeconds();
    const prev = inv.inwardPoState;
    const set: Partial<PoInvoice> = { inwardPoState: state, inwardPoError: state === R.CREATED ? null : error };
    if (poStatus) set.inwardPoStatus = poStatus.slice(0, 50);
    await m.getRepository(PoInvoice).update({ id: invoiceId }, set as QueryDeepPartialEntity<PoInvoice>);
    Object.assign(inv, set);
    const header: Partial<MasterPurchaseOrder> = { updatedAt: now };
    const source = by ? SHIPMENT_LOG_SOURCE.TOOL_API : SHIPMENT_LOG_SOURCE.SYSTEM;
    const no = invoiceNo(inv);
    const action = state === R.CREATED ? SHIPMENT_LOG_ACTION.INWARD_PO_CREATED : state === R.FAILED ? SHIPMENT_LOG_ACTION.INWARD_PO_FAILED : SHIPMENT_LOG_ACTION.SYNC_ERROR;
    const logs: LogRow[] = [{
      uid, action, source, field: 'inwardPoState', oldValue: prev, newValue: state,
      remark: [no, code, error, remark].filter(Boolean).join(' | ').slice(0, 4000), uniwareStatus: poStatus ? `PO ${poStatus}`.slice(0, 100) : null,
    }];
    if (state === R.CREATED) {
      const joined = joinInwardCodes(invoices);
      if ((po.poNumberInwardCWH ?? null) !== joined) {
        header.poNumberInwardCWH = joined;
        logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, source, field: 'poNumberInwardCWH', oldValue: po.poNumberInwardCWH, newValue: joined });
      }
      const { stage, fields } = restage(po, await linesOfTransfer(m, uid), invoices, now);
      Object.assign(header, fields);
      if (stage !== po.transferStage) logs.push({ uid, action: SHIPMENT_LOG_ACTION.STAGE_CHANGED, source, field: 'transferStage', oldValue: po.transferStage, newValue: stage });
    }
    await m.getRepository(MasterPurchaseOrder).update({ uid }, header as QueryDeepPartialEntity<MasterPurchaseOrder>);
    await writeLogs(m, logs, randomUUID(), by?.id ?? null);
    return { state, logged: true };
  });
  if (r.logged) void flushChanges();
  return r.state;
};

export type InwardReconcileFacts = Pick<PoInvoice, 'inwardPoState' | 'inwardPoRequestedAt' | 'inwardPoCode'>;
export type InwardReconcileCheck =
  | { checked: false; why: string }
  | { checked: true; state: 'created' | 'failed' | 'unknown'; error: string | null; remark: string | null; poStatus: string | null };

/** The Uniware half of a reconcile (no database): skips what is not in flight or still within the grace. */
export const inwardReconcileCheck = async (
  inv: InwardReconcileFacts, ctx: { soCode: string | null; receiving: string | null }, api: UniwarePoster, graceMs: number = D2C_INWARD_PO.RECONCILE_GRACE_MS,
  now = Date.now(),
): Promise<InwardReconcileCheck> => {
  if (inv.inwardPoState !== R.REQUESTED && inv.inwardPoState !== R.UNKNOWN) return { checked: false, why: `inward_po_state ${inv.inwardPoState ?? 'none'}` };
  if (!inv.inwardPoCode || !ctx.receiving) return { checked: false, why: 'no inward PO code or receiving facility' };
  if (graceMs > 0 && inv.inwardPoRequestedAt && now - new Date(inv.inwardPoRequestedAt).getTime() < graceMs) return { checked: false, why: 'still within the grace period' };
  let g: PoGetOutcome;
  try {
    const { po } = await getPurchaseOrder(api, inv.inwardPoCode, ctx.receiving);
    g = po ? { kind: 'found', po } : { kind: 'not_found' };
  } catch (error) {
    g = { kind: 'error', error };
  }
  const d = decideAfterPoGet(g, ctx.soCode);
  return {
    checked: true, state: d.state, error: d.error,
    remark: g.kind === 'found' ? trim({ code: g.po.code, status: g.po.status, vendorCode: g.po.vendorCode, fields: g.po.fields, items: g.po.items }, 1000) : null,
    poStatus: g.kind === 'found' ? g.po.status : null,
  };
};

/**
 * Reconcile an inward PO request in requested / unknown (plan 5.5; the sync calls it per invoice after the grace).
 * @public
 */
export const reconcileInwardPo = async (
  invoiceId: string, o: { api?: UniwarePoster; by?: Actor | null; graceMs?: number } = {},
): Promise<{ state: string | null; error: string | null; checked: boolean }> => {
  const uid = await uidOfInvoice(invoiceId);
  const inv = await AppDataSource.getRepository(PoInvoice).findOneByOrFail({ id: invoiceId });
  if (inv.inwardPoState !== R.REQUESTED && inv.inwardPoState !== R.UNKNOWN) return { state: inv.inwardPoState, error: inv.inwardPoError, checked: false };
  const po = await AppDataSource.getRepository(MasterPurchaseOrder).findOneByOrFail({ uid });
  const receiving = await invoiceReceivingOf(AppDataSource.manager, inv);
  const c = await inwardReconcileCheck(inv, { soCode: po.orderNo1, receiving }, o.api ?? uniwareClient(), o.graceMs);
  if (!c.checked) return { state: inv.inwardPoState, error: inv.inwardPoError, checked: false };
  const state = await applyInwardState(invoiceId, uid, inv.inwardPoCode as string, c.state, c.error, o.by ?? null, c.remark, c.poStatus);
  return { state, error: c.error, checked: true };
};

/** One invoice: reserve -> call -> confirm (-> reconcile). Never throws: the result says what happened. */
const createInwardFor = async (invoiceId: string, by: Actor, api?: UniwarePoster): Promise<InwardResult> => {
  let r: Reserved;
  try {
    r = await reserve(invoiceId, by);
  } catch (err) {
    return resultOfError(invoiceId, err);
  }
  void flushChanges();
  const base = { invoiceId, uid: r.uid, transferCode: r.transferCode, invoiceNo: r.invoiceNo, inwardPoCode: r.input.code };
  let outcome: PoCreateOutcome;
  try {
    outcome = { ok: true, response: (await createPurchaseOrder(api ?? uniwareClient(), r.input)).response };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const d = decideAfterPoCreate(outcome);
  const label = (s: string | null): InwardResult['outcome'] => (s === R.CREATED ? 'created' : s === R.FAILED ? 'failed' : 'unknown');
  try {
    if (d.state !== 'reconcile') {
      const state = await applyInwardState(invoiceId, r.uid, r.input.code, d.state, d.error, by, outcome.ok ? trim(outcome.response, 1000) : null, null);
      return { ...base, outcome: label(state), error: d.error };
    }
    await applyInwardState(invoiceId, r.uid, r.input.code, R.UNKNOWN, d.error, by, null, null);
    const rc = await reconcileInwardPo(invoiceId, { api, by, graceMs: 0 });
    return { ...base, outcome: label(rc.state), error: rc.error ?? d.error };
  } catch (err) {
    // the database failed after the call: the request stays requested / unknown; the sync reconciles it
    log.error(LOG_SOURCE.APP, `${LOG} confirm failed`, { invoiceId, error: errorText(err) });
    return { ...base, outcome: 'unknown', error: `saved state unclear: ${errorText(err)}` };
  }
};

// ---- create: many (background job) ---------------------------------------------------------------------------------

export interface InwardJob {
  id: string; kind: 'inward_po'; status: 'running' | 'done'; total: number; done: number; startedAt: string; finishedAt: string | null; results: InwardResult[];
}
const jobs = new Map<string, InwardJob>();
const KEEP_MS = 60 * 60 * 1000;

const prune = () => {
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, j] of jobs) if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) jobs.delete(id);
};

/** { invoiceIds: string[] } -> unique ids (400 on a bad list). */
const invoiceIdsOf = (body: unknown): string[] => {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).invoiceIds : undefined;
  if (!Array.isArray(raw) || !raw.length) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'invoiceIds', code: ERROR_CODES.FIELD_REQUIRED, message: 'invoiceIds must be a non-empty list of invoice ids' }]);
  }
  if (raw.length > D2C_INWARD_PO.MAX_IDS) throw appError(ERROR_CODES.D2C_TOO_MANY_INVOICES, D2C_INWARD_PO.MAX_IDS);
  return [...new Set(raw.map((x) => String(x).trim()))];
};

/**
 * POST /create-inward-po { invoiceIds } -> 202 { id, kind, total, done, results } (results so far: ids not found / the
 * gate refuses at once). The rest runs in the background, CONCURRENCY at a time. 409 D2C_NOT_LIVE when the gate
 * refuses every id. GET /jobs/:jobId reads it (inwardJob).
 */
export const startCreateInwardPo = async (body: unknown, by: Actor, api?: UniwarePoster): Promise<InwardJob> => {
  const ids = invoiceIdsOf(body);
  const settings = await readSettings();
  const valid = ids.filter((id) => /^\d{1,19}$/.test(id));
  const heads = valid.length
    ? await AppDataSource.query<{ id: string | number; transferCode: string | null; facility: string | null; receiving: string | null }[]>(
      `SELECT i.id, p.transferCode, p.facility, COALESCE(i.receiving_facility_code, f.code) receiving
         FROM ${TABLES.PO_INVOICES} i JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = i.po_uid
         LEFT JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = p.locationId LEFT JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id
        WHERE i.id IN (?)`, [valid],
    )
    : [];
  const byId = new Map(heads.map((h) => [String(h.id), h]));
  const pre: InwardResult[] = [];
  const todo: string[] = [];
  for (const id of ids) {
    const h = byId.get(id);
    if (!h || !h.transferCode) pre.push({ ...resultOfError(id, appError(ERROR_CODES.D2C_INVOICE_NOT_FOUND, id)) });
    else if (!uniwareWritesAllowed(settings, env.d2c.uniwareWrites, { sender: h.facility, receiving: h.receiving }, 'receiving')) {
      pre.push({ ...resultOfError(id, gateError({ sender: h.facility, receiving: h.receiving })), transferCode: h.transferCode });
    } else todo.push(id);
  }
  if (!todo.length && pre.length && pre.every((p) => isGateCode(p.code))) {
    const lanes = [...new Set(pre.map((p) => laneText(byId.get(p.invoiceId)?.facility, byId.get(p.invoiceId)?.receiving)))].join(', ');
    throw appError(env.d2c.testOnly ? ERROR_CODES.D2C_TEST_ONLY : ERROR_CODES.D2C_NOT_LIVE, lanes);
  }
  prune();
  const job: InwardJob = {
    id: randomUUID(), kind: 'inward_po', status: 'running', total: ids.length, done: pre.length, startedAt: new Date().toISOString(), finishedAt: null, results: [...pre],
  };
  jobs.set(job.id, job);
  const finish = () => {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
  };
  if (!todo.length) finish();
  else {
    void runPool(todo, D2C_INWARD_PO.CONCURRENCY, async (id) => {
      job.results.push(await createInwardFor(id, by, api));
      job.done += 1;
    }).catch((err) => log.error(LOG_SOURCE.APP, `${LOG} job failed`, { job: job.id, error: errorText(err) })).finally(finish);
  }
  return job;
};

/** An inward PO job of this server, or null (GET /jobs/:jobId falls back to the SO jobs). */
export const inwardJob = (id: string): InwardJob | null => jobs.get(id) ?? null;

// ---- variance reason -----------------------------------------------------------------------------------------------

/**
 * POST /invoices/:invoiceId/variance-reason { reason, note }: the invoice is GRN-complete with variance != 0 and has no
 * reason yet (whatever the transfer's balance). Logged; the stage is recomputed (the last open variance closes it).
 */
export const setVarianceReason = async (invoiceId: string, body: unknown, by: Actor) => {
  const { reason, note } = varianceBodyOf(body);
  const uid = await uidOfInvoice(invoiceId);
  const out = await AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    await assertTestTransfer(m, await readSettings(m), po);
    const invoices = await invoicesOf(m, uid);
    const inv = invoices.find((i) => String(i.id) === String(invoiceId));
    if (!inv) throw appError(ERROR_CODES.D2C_INVOICE_NOT_FOUND, invoiceId);
    const no = invoiceNo(inv);
    const block = varianceBlock(inv);
    if (block) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, `${po.transferCode as string} invoice ${no}`, block);
    if (inv.varianceReason === reason && (inv.varianceNote ?? null) === note) return { stage: po.transferStage, closed: po.transferStage === D2C_STAGE.CLOSED, changed: false };
    const old = { reason: inv.varianceReason, note: inv.varianceNote ?? null };
    const now = nowSeconds();
    await m.getRepository(PoInvoice).update({ id: invoiceId }, { varianceReason: reason, varianceNote: note });
    Object.assign(inv, { varianceReason: reason, varianceNote: note });
    const { stage, fields } = restage(po, await linesOfTransfer(m, uid), invoices, now);
    await m.getRepository(MasterPurchaseOrder).update({ uid }, { ...fields, updatedAt: now } as QueryDeepPartialEntity<MasterPurchaseOrder>);
    const v = varianceOf(inv);
    const logs: LogRow[] = [{
      uid, action: SHIPMENT_LOG_ACTION.VARIANCE_REASON, source: SHIPMENT_LOG_SOURCE.SCREEN, field: 'varianceReason', oldValue: old.reason, newValue: reason,
      remark: varianceRemark(`${no} | inward PO ${inv.inwardPoCode ?? '-'} | variance ${v > 0 ? '+' : ''}${v}`, old.note, note),
    }];
    if (stage !== po.transferStage) logs.push({ uid, action: SHIPMENT_LOG_ACTION.STAGE_CHANGED, source: SHIPMENT_LOG_SOURCE.SCREEN, field: 'transferStage', oldValue: po.transferStage, newValue: stage });
    await writeLogs(m, logs, randomUUID(), by.id);
    return { stage, closed: stage === D2C_STAGE.CLOSED, changed: true };
  });
  void flushChanges();
  return { invoiceId, uid, reason, note, ...out };
};
