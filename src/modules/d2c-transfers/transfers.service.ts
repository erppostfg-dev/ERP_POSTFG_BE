import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../../config/data-source';
import {
  D2C_FINAL_STAGES, D2C_LIMITS, D2C_REQUEST_STATE, D2C_STAGE, d2cReferenceId, ERROR_CODES, NEW_PO_STATUS, round2, SHIPMENT_LOG_ACTION,
  SHIPMENT_LOG_SOURCE, ShipmentLogAction, ShipmentLogSource,
} from '../../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder, ShipmentLog } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { flushChanges } from '../po-overview/po-overview.live';
import { parseDay, RefSerials, takeTransferCodes, todayIst } from './reference';
import { readSettings } from './settings';
import { createdRemark, editToken, EditableState, statusTextsOf } from './stage';
import { assertTestTransfer } from './test-mode';
import { loadMasters, ProposedTransfer, RawRow, ValidationOutcome, validateRows } from './validate';

/*
 * Writes of D2C internal transfers without Uniware (plan 1.4 / 2.2 / 5.1-5.3 / 5.6, phase 3):
 *   insertTransfers()  new drafts (upload import or form) in the caller's transaction: transfer codes and reference
 *                      serials taken in order, master_purchase_orders + details_purchase_orders filled as plan 2.2 /
 *                      2.4 "insert must fill", one `created` log per transfer;
 *   createFromForm()   POST /d2c-transfers;
 *   editDraft()        PATCH /d2c-transfers/:id with the edit token, under the row lock; every change logged;
 *   cancelDraft()      POST /:id/cancel (drafts only in this phase; the Uniware cancel comes with the SO phase);
 *   changeExpiry()     POST /:id/expiry (any stage that is not closed / cancelled).
 * Locking rule (plan 1.4): transaction + SELECT ... FOR UPDATE of the header, re-read, apply, log, commit, then
 * flushChanges() so live screens hear about it.
 */

export interface Actor { id: number }

/** datetime columns keep whole seconds. */
export const nowSeconds = () => new Date(Math.floor(Date.now() / 1000) * 1000);

const invalid = (outcome: ValidationOutcome): AppError =>
  appError(ERROR_CODES.D2C_INVALID, outcome.errorCount).withDetails(
    outcome.rows.flatMap((r) => r.errors.map((e) => ({ row: r.row, field: e.field, message: e.message }))),
  );

export type LogRow = {
  uid: string; action: ShipmentLogAction; source?: ShipmentLogSource; field?: string | null; lineId?: string | null;
  oldValue?: unknown; newValue?: unknown; remark?: string | null; uniwareStatus?: string | null;
};
const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : JSON.stringify(v);
};

/** shipment_logs rows of one save (same batch id, same person). */
export const writeLogs = async (m: EntityManager, rows: LogRow[], batchId: string, userId: number | null, source: ShipmentLogSource = SHIPMENT_LOG_SOURCE.SCREEN) => {
  if (!rows.length) return;
  await m.getRepository(ShipmentLog).insert(rows.map((r) => ({
    shipmentUid: r.uid, userId, action: r.action, source: r.source ?? source, fieldName: r.field ?? null, lineId: r.lineId ?? null, batchId,
    oldValue: text(r.oldValue), newValue: text(r.newValue), remark: r.remark ?? null, uniwareStatus: r.uniwareStatus ?? null,
  })));
};

export interface CreatedTransfer { uid: string; transferCode: string; reference: string; group: string | null; rows: number[] }

/** Inserts valid proposed transfers as drafts, in order (serials follow that order). Runs in the caller's transaction. */
export const insertTransfers = async (
  m: EntityManager,
  transfers: ProposedTransfer[],
  o: { source: ShipmentLogSource; batchId: string; userId: number | null; fileUrl: string | null; today: string },
): Promise<CreatedTransfer[]> => {
  const settings = await readSettings(m);
  const now = nowSeconds();
  const codes = await takeTransferCodes(m, o.today, transfers.length);
  const refs = await RefSerials.open(m, settings, o.today);
  const out: CreatedTransfer[] = [];
  const headers = m.getRepository(MasterPurchaseOrder);
  const details = m.getRepository(DetailsPurchaseOrder);
  for (const [i, t] of transfers.entries()) {
    if (!t.valid) throw new Error(`insertTransfers: transfer ${t.key} is not valid`);
    const reference = d2cReferenceId(t.prefix as string, t.poDate as string, t.type as string, await refs.take(t.poDate as string));
    const res = await headers.insert({
      poNumber: reference,
      channel: t.channel,
      facility: t.senderCode,
      facilityId: t.senderId,
      location: t.location,
      locationId: t.locationId,
      customerCode: t.route?.customerCode ?? null,
      transferRouteId: t.route?.id ?? null,
      channelType: t.channelCategory,
      entryDate: o.today,
      poDate: t.poDate,
      labelsLink: t.expiry,
      totalUnits: t.totalUnits,
      brandName: t.lines.map((l) => l.brand).find((b) => b !== null) ?? null,
      specialRemarksCOPT: t.remarks,
      statusActive: NEW_PO_STATUS.ACTIVE,
      ...statusTextsOf(D2C_STAGE.DRAFT),
      transferCode: codes[i],
      transferType: t.type,
      transferPriority: t.priority,
      transferStage: D2C_STAGE.DRAFT,
      transferStageAt: now,
      transferBatchId: o.batchId,
      transferFileUrl: o.fileUrl,
      createdAt: now,
      updatedAt: now,
    });
    const uid = String(res.identifiers[0].uid);
    await details.insert(t.lines.map((l, n) => ({
      shipmentOrderId: uid, srNo: String(n + 1), skuName: l.skuName, skuCode: l.skuCode, channelSkuCode: l.skuCode, brandName: l.brand,
      qty: l.qty, gmv: l.gmv, poValue: l.poValue, updatedQty: l.qty, updatedGmv: l.gmv, updatedPoValue: l.poValue,
      dispatchedQty: 0, allocatedQty: 0, poNumber: reference, createdAt: now, updatedAt: now,
    })));
    await writeLogs(m, [{ uid, action: SHIPMENT_LOG_ACTION.CREATED, newValue: reference, remark: createdRemark(codes[i], t.group) }], o.batchId, o.userId, o.source);
    out.push({ uid, transferCode: codes[i], reference, group: t.group, rows: t.rows });
  }
  await refs.save();
  return out;
};

// ---- the form ----------------------------------------------------------------------------------------------------

type Body = Record<string, unknown>;
const obj = (v: unknown): Body => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {});
const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const bad = (field: string, message: string) => appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field, code: ERROR_CODES.FIELD_BAD_FORMAT, message }]);

/** The form's lines: [{ skuCode, qty }]. */
const linesOf = (v: unknown): { skuCode: string; qty: string }[] => {
  if (!Array.isArray(v)) throw bad('lines', 'lines must be a list of { skuCode, qty }');
  if (!v.length) throw bad('lines', 'add at least one SKU line');
  if (v.length > D2C_LIMITS.UPLOAD_MAX_ROWS) throw bad('lines', `at most ${D2C_LIMITS.UPLOAD_MAX_ROWS} lines`);
  return v.map((l) => ({ skuCode: str(obj(l).skuCode), qty: str(obj(l).qty) }));
};

/** Form header + lines -> the same rows an upload gives (one transfer). */
const formRows = (h: Body, lines: { skuCode: string; qty: string }[]): RawRow[] => {
  const senderId = h.senderId === undefined || h.senderId === null || h.senderId === '' ? undefined : Number(h.senderId);
  const locationId = h.locationId === undefined || h.locationId === null || h.locationId === '' ? undefined : str(h.locationId);
  // the route's Uniware channel (needed when the sender + location has 2+): a route id from the options, or its code
  const routeId = h.routeId === undefined || h.routeId === null || h.routeId === '' ? undefined : Number(h.routeId);
  return lines.map((l, i) => ({
    row: i + 1, channel: str(h.channel), location: str(h.location), locationId, poDate: str(h.poDate), sender: str(h.sender), senderId,
    routeId, uniwareChannel: str(h.uniwareChannel),
    priority: str(h.priority), group: '', type: str(h.type), expiry: str(h.expiry), skuCode: l.skuCode, skuName: '', qty: l.qty, remarks: str(h.remarks),
  }));
};

/** Validates rows that must make exactly one transfer (form / edit). */
const oneTransfer = async (rows: RawRow[], excludeUid?: string) => {
  const today = todayIst();
  const settings = await readSettings();
  const masters = await loadMasters(rows.map((r) => r.skuCode), settings, today, excludeUid);
  const outcome = validateRows(rows, masters);
  if (outcome.errorCount || outcome.transfers.length !== 1 || !outcome.transfers[0].valid) throw invalid(outcome);
  return { transfer: outcome.transfers[0], outcome, today };
};

/**
 * POST /d2c-transfers { senderId | sender, channel, locationId | location, routeId? | uniwareChannel? (needed when the
 * route has 2+ Uniware channels), poDate? (today), priority?, type?, expiry?, remarks?, lines: [{ skuCode, qty }] }
 * -> the new draft (source screen) + the warnings.
 */
export const createFromForm = async (body: unknown, by: Actor) => {
  const h = obj(body);
  if (!str(h.poDate).trim()) h.poDate = todayIst();
  const { transfer, outcome, today } = await oneTransfer(formRows(h, linesOf(h.lines)));
  const batchId = randomUUID();
  const [created] = await AppDataSource.transaction((m) =>
    insertTransfers(m, [transfer], { source: SHIPMENT_LOG_SOURCE.SCREEN, batchId, userId: by.id, fileUrl: null, today }));
  void flushChanges();
  return { ...created, warnings: outcome.rows.flatMap((r) => r.warnings.map((w) => ({ row: r.row, ...w }))) };
};

// ---- locked writes -----------------------------------------------------------------------------------------------

const ID = /^[1-9]\d{0,18}$/;
export const checkId = (id: string): string => {
  if (!ID.test(id)) throw appError(ERROR_CODES.D2C_NOT_FOUND, id);
  return id;
};

/** The transfer's header, locked for this transaction (404 for a channel PO or no row). */
export const lockTransfer = async (m: EntityManager, uid: string): Promise<MasterPurchaseOrder> => {
  const po = await m.getRepository(MasterPurchaseOrder).findOne({ where: { uid }, lock: { mode: 'pessimistic_write' } });
  if (!po || !po.transferCode) throw appError(ERROR_CODES.D2C_NOT_FOUND, uid);
  return po;
};

export const linesOfTransfer = (m: EntityManager, uid: string) => m.getRepository(DetailsPurchaseOrder).find({ where: { shipmentOrderId: uid }, order: { id: 'ASC' } });

/** The editable state of a draft (its token is checked under the lock). */
export const editableState = (po: MasterPurchaseOrder, lines: DetailsPurchaseOrder[]): EditableState => ({
  facilityId: po.facilityId, channel: po.channel, locationId: po.locationId, poDate: po.poDate, priority: po.transferPriority, type: po.transferType,
  expiry: po.labelsLink, remarks: po.specialRemarksCOPT, routeId: po.transferRouteId ?? null, lines: lines.map((l) => ({ id: l.id, skuCode: l.skuCode, qty: l.qty, updatedQty: l.updatedQty })),
});

/** Why a draft cannot be edited / cancelled here, or null. */
export const draftBlock = (po: Pick<MasterPurchaseOrder, 'transferStage' | 'soState'>): string | null => {
  if (po.transferStage !== D2C_STAGE.DRAFT) return `only a draft can be changed here (it is ${po.transferStage})`;
  if (po.soState && po.soState !== D2C_REQUEST_STATE.FAILED) return `its sale order request is ${po.soState}: wait until it is resolved`;
  return null;
};

const active = (l: DetailsPurchaseOrder) => (l.updatedQty ?? l.qty ?? 0) > 0;

/**
 * PATCH /d2c-transfers/:id { token, header?: { senderId|sender, channel, locationId|location, routeId|uniwareChannel,
 * poDate, priority, type, expiry, remarks }, lines?: [{ skuCode, qty }] (the full new list) } -> { changed, reference }.
 * The route kept unless the sender / location / route changes (then it is picked again, see validate.ts pickRoute).
 * Draft only, sale order not requested (soState NULL / failed). A new reference ID is taken when the location, PO
 * date or type changes (they are part of it); the old one is logged and never reused. A removed line is kept with
 * updatedQty 0 (its history stays).
 */
export const editDraft = async (rawId: string, body: unknown, by: Actor) => {
  const uid = checkId(rawId);
  const b = obj(body);
  const token = str(b.token);
  if (!token) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'token', code: ERROR_CODES.FIELD_REQUIRED, message: 'token is required (from GET /d2c-transfers/:id)' }]);
  const h = obj(b.header);

  // the check runs on the state the token names; the lock below makes sure nothing changed since
  const cur = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid });
  if (!cur || !cur.transferCode) throw appError(ERROR_CODES.D2C_NOT_FOUND, uid);
  const block = draftBlock(cur);
  if (block) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, cur.transferCode, block);
  await assertTestTransfer(AppDataSource.manager, await readSettings(), cur);
  const curLines = await linesOfTransfer(AppDataSource.manager, uid);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(h, k);
  const merged: Body = {
    channel: has('channel') ? h.channel : cur.channel,
    poDate: has('poDate') ? h.poDate : cur.poDate,
    priority: has('priority') ? h.priority : cur.transferPriority,
    type: has('type') ? h.type : cur.transferType,
    expiry: has('expiry') ? h.expiry : cur.labelsLink,
    remarks: has('remarks') ? h.remarks : cur.specialRemarksCOPT,
  };
  if (has('senderId') || has('sender')) Object.assign(merged, { senderId: h.senderId, sender: h.sender });
  else merged.senderId = cur.facilityId;
  if (has('locationId') || has('location')) Object.assign(merged, { locationId: h.locationId, location: h.location });
  else merged.locationId = cur.locationId;
  // same sender + location (as ids) = the chosen route stays unless another one is named
  const lane = has('sender') || has('location') || (has('senderId') && Number(h.senderId) !== cur.facilityId)
    || (has('locationId') && str(h.locationId) !== String(cur.locationId ?? ''));
  if (has('routeId') || has('uniwareChannel')) Object.assign(merged, { routeId: h.routeId, uniwareChannel: h.uniwareChannel });
  else if (!lane && cur.transferRouteId !== null) merged.routeId = cur.transferRouteId;
  const lines = b.lines === undefined
    ? curLines.filter(active).map((l) => ({ skuCode: l.skuCode ?? '', qty: String(l.updatedQty ?? l.qty ?? 0) }))
    : linesOf(b.lines);
  const { transfer: t, today } = await oneTransfer(formRows(merged, lines), uid);

  const batchId = randomUUID();
  const result = await AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    const blocked = draftBlock(po);
    if (blocked) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode as string, blocked);
    const lineRows = await linesOfTransfer(m, uid);
    if (editToken(editableState(po, lineRows)) !== token) throw appError(ERROR_CODES.D2C_STALE, po.transferCode as string);

    const logs: LogRow[] = [];
    const now = nowSeconds();
    const header: Partial<MasterPurchaseOrder> = {};
    const set = <K extends keyof MasterPurchaseOrder>(k: K, v: MasterPurchaseOrder[K], logged = true) => {
      const old = po[k];
      const same = old === v || (old !== null && v !== null && text(old) === text(v));
      if (same) return;
      header[k] = v;
      if (logged) logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, field: k, oldValue: old, newValue: v });
    };
    set('facility', t.senderCode);
    set('facilityId', t.senderId, false);
    set('channel', t.channel);
    set('location', t.location);
    set('locationId', t.locationId, false);
    set('customerCode', t.route?.customerCode ?? null);
    const routeId = t.route?.id ?? null;
    if ((po.transferRouteId ?? null) !== routeId) {
      header.transferRouteId = routeId;
      logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, field: 'transferRouteId', oldValue: po.transferRouteId, newValue: routeId, remark: `Uniware channel ${t.route?.uniwareChannelCode ?? '-'}` });
    }
    set('channelType', t.channelCategory, false);
    set('poDate', t.poDate);
    set('transferPriority', t.priority);
    set('transferType', t.type);
    set('labelsLink', t.expiry);
    set('specialRemarksCOPT', t.remarks);

    let reference = po.poNumber as string;
    const retake = String(po.locationId) !== String(t.locationId) || po.poDate !== t.poDate || po.transferType !== t.type;
    if (retake) {
      const refs = await RefSerials.open(m, await readSettings(m), today);
      reference = d2cReferenceId(t.prefix as string, t.poDate as string, t.type as string, await refs.take(t.poDate as string));
      await refs.save();
      header.poNumber = reference;
      logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, field: 'poNumber', oldValue: po.poNumber, newValue: reference, remark: 'reference re-taken (location, PO date or type changed); the old one is not reused' });
    }

    // lines by SKU
    const repo = m.getRepository(DetailsPurchaseOrder);
    const bySku = new Map(lineRows.map((l) => [(l.skuCode ?? '').toLowerCase(), l]));
    let srNo = lineRows.reduce((n, l) => Math.max(n, Number(l.srNo) || 0), 0);
    const keep = new Set<string>();
    for (const l of t.lines) {
      const k = l.skuCode.toLowerCase();
      keep.add(k);
      const row = bySku.get(k);
      if (!row) {
        srNo += 1;
        const ins = await repo.insert({
          shipmentOrderId: uid, srNo: String(srNo), skuName: l.skuName, skuCode: l.skuCode, channelSkuCode: l.skuCode, brandName: l.brand,
          qty: l.qty, gmv: l.gmv, poValue: l.poValue, updatedQty: l.qty, updatedGmv: l.gmv, updatedPoValue: l.poValue, dispatchedQty: 0, allocatedQty: 0,
          poNumber: reference, createdAt: now, updatedAt: now,
        });
        logs.push({ uid, action: SHIPMENT_LOG_ACTION.LINE_ADDED, lineId: String(ins.identifiers[0].id), field: 'qty', newValue: l.qty, remark: l.skuCode });
        continue;
      }
      const was = active(row) ? (row.updatedQty ?? row.qty ?? 0) : 0;
      if (was === l.qty && row.poNumber === reference) continue;
      // unit prices frozen at the first save; a line that never had a qty takes today's master MRP
      const unitGmv = row.qty ? Number(row.gmv ?? 0) / row.qty : l.mrp;
      const unitPo = row.qty ? Number(row.poValue ?? 0) / row.qty : l.poValue / l.qty;
      const gmv = round2(unitGmv * l.qty);
      const poValue = round2(unitPo * l.qty);
      await repo.update({ id: row.id }, { qty: l.qty, gmv, poValue, updatedQty: l.qty, updatedGmv: gmv, updatedPoValue: poValue, poNumber: reference, updatedAt: now });
      if (was === 0) logs.push({ uid, action: SHIPMENT_LOG_ACTION.LINE_ADDED, lineId: row.id, field: 'qty', newValue: l.qty, remark: l.skuCode });
      else if (was !== l.qty) logs.push({ uid, action: SHIPMENT_LOG_ACTION.FIELD_CHANGED, lineId: row.id, field: 'qty', oldValue: was, newValue: l.qty, remark: l.skuCode });
    }
    for (const row of lineRows) {
      const k = (row.skuCode ?? '').toLowerCase();
      if (keep.has(k)) continue;
      if (active(row)) {
        await repo.update({ id: row.id }, { updatedQty: 0, updatedGmv: 0, updatedPoValue: 0, poNumber: reference, updatedAt: now });
        logs.push({ uid, action: SHIPMENT_LOG_ACTION.LINE_REMOVED, lineId: row.id, field: 'qty', oldValue: row.updatedQty ?? row.qty, newValue: 0, remark: row.skuCode });
      } else if (row.poNumber !== reference) await repo.update({ id: row.id }, { poNumber: reference });
    }
    const totalUnits = t.totalUnits;
    if (po.totalUnits !== totalUnits) header.totalUnits = totalUnits;
    const brand = t.lines.map((l) => l.brand).find((x) => x !== null) ?? null;
    if (po.brandName !== brand) header.brandName = brand;
    if (!logs.length) return { changed: [] as string[], reference };
    await m.getRepository(MasterPurchaseOrder).update({ uid }, { ...header, updatedAt: now } as QueryDeepPartialEntity<MasterPurchaseOrder>);
    await writeLogs(m, logs, batchId, by.id);
    return { changed: [...new Set(logs.map((l) => (l.lineId ? `line:${l.remark ?? l.lineId}` : (l.field as string))))], reference };
  });
  if (result.changed.length) void flushChanges();
  return result;
};

/** The reason of a cancel / close short: required, at most REASON_MAX characters. */
export const reasonOf = (body: unknown): string => {
  const reason = str(obj(body).reason).trim();
  if (!reason) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'reason', code: ERROR_CODES.FIELD_REQUIRED, message: 'reason is required' }]);
  if (reason.length > D2C_LIMITS.REASON_MAX) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'reason', code: ERROR_CODES.FIELD_TOO_LONG, message: `reason must be at most ${D2C_LIMITS.REASON_MAX} characters` }]);
  return reason;
};

/** POST /d2c-transfers/:id/cancel { reason } for a draft whose sale order was never created (so.service.ts cancelTransfer decides). */
export const cancelDraft = async (rawId: string, body: unknown, by: Actor) => {
  const uid = checkId(rawId);
  const reason = reasonOf(body);
  await AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    const blocked = draftBlock(po);
    if (blocked) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode as string, blocked);
    await assertTestTransfer(m, await readSettings(m), po);
    const now = nowSeconds();
    await m.getRepository(MasterPurchaseOrder).update({ uid }, {
      transferStage: D2C_STAGE.CANCELLED, transferStageAt: now, ...statusTextsOf(D2C_STAGE.CANCELLED), updatedAt: now,
    });
    // nothing will ship: the whole requested qty is cancelled (cancelled = qty - updatedQty)
    await m.getRepository(DetailsPurchaseOrder).update({ shipmentOrderId: uid }, { updatedQty: 0, updatedGmv: 0, updatedPoValue: 0, updatedAt: now });
    await writeLogs(m, [{ uid, action: SHIPMENT_LOG_ACTION.CANCELLED, field: 'transferStage', oldValue: po.transferStage, newValue: D2C_STAGE.CANCELLED, remark: reason }], randomUUID(), by.id);
  });
  void flushChanges();
  return { uid, stage: D2C_STAGE.CANCELLED };
};

/** POST /d2c-transfers/:id/expiry { date, remark? }: the PO expiry date, until the transfer is closed / cancelled. */
export const changeExpiry = async (rawId: string, body: unknown, by: Actor) => {
  const uid = checkId(rawId);
  const b = obj(body);
  const date = parseDay(b.date);
  if (!date) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'date', code: ERROR_CODES.FIELD_NOT_DAY, message: 'date must be a date (YYYY-MM-DD or DD-MM-YYYY)' }]);
  const remark = str(b.remark).trim() || null;
  if (remark && remark.length > D2C_LIMITS.REASON_MAX) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'remark', code: ERROR_CODES.FIELD_TOO_LONG, message: `remark must be at most ${D2C_LIMITS.REASON_MAX} characters` }]);
  const changed = await AppDataSource.transaction(async (m) => {
    const po = await lockTransfer(m, uid);
    if (D2C_FINAL_STAGES.includes(po.transferStage ?? '')) throw appError(ERROR_CODES.D2C_NOT_EDITABLE, po.transferCode as string, `it is ${po.transferStage}`);
    await assertTestTransfer(m, await readSettings(m), po);
    if (po.poDate && date < po.poDate) {
      throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'date', code: ERROR_CODES.FIELD_BAD_FORMAT, message: `the expiry must not be before the PO date ${po.poDate}` }]);
    }
    if (po.labelsLink === date) return false;
    await m.getRepository(MasterPurchaseOrder).update({ uid }, { labelsLink: date, updatedAt: nowSeconds() });
    await writeLogs(m, [{ uid, action: SHIPMENT_LOG_ACTION.EXPIRY_CHANGED, field: 'labelsLink', oldValue: po.labelsLink, newValue: date, remark }], randomUUID(), by.id);
    return true;
  });
  if (changed) void flushChanges();
  return { uid, expiry: date, changed };
};
