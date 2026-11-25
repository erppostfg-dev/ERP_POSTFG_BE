import { randomUUID } from 'crypto';
import { EntityManager, IsNull } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCESS_LEVEL,
  BULK_BODY as F,
  CAPABILITY,
  BULK_DOC_KIND,
  BULK_DOC_KINDS,
  BULK_DOCS,
  BULK_EVENT,
  BULK_ORDER_STATUS,
  BULK_APPROVAL,
  BULK_ORDER_TYPES,
  BULK_ORDERS,
  BULK_PAGE,
  BULK_PAYMENT_ACTION,
  BULK_PAYMENT_ACTIONS,
  BULK_PAYMENT_STATUS,
  BulkOrderType,
  BulkPaymentStatus,
  ERROR_CODES,
  errorMessage,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { AppState, BulkOrder, BulkOrderDocument, BulkTypeSetting } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { accessFrom, allows, hasCapability, loadAccess } from '../auth/access.service';
import { openS3File, s3UrlOfKey, writeS3File } from '../email-intake/s3-mirror.service';
import {
  addEvent, BulkActor, Checker, checkAddress, getBulkOrder, HeadOffice, isId, needAnyBulk, normalPhone, readHeadOffice, teamBulkOrder, typeOfOrder, userNames,
} from './bulk-orders.service';
import { notifyBulk } from './bulk-notify.service';

/*
 * Bulk Orders: documents + payment check + per-type settings (2026-11-12, user; constants/bulk-orders.ts).
 *   - Documents (proforma / invoice / proof of payment): PDF / PNG / JPG up to BULK_DOCS.MAX_BYTES, type from the
 *     file's first bytes. Portal: the order type's editors and approvers; our team: PO review editors. Any time except
 *     on a rejected / cancelled order. The file goes to S3 BEFORE the rows (a failed save leaves only an unused file).
 *     Never deleted: a newer file of the same kind marks the older ones replaced.
 *   - Payment (only orders with a payment status = check ON for their type at creation): a proof upload ->
 *     proof_uploaded; the APPROVER verifies / refuses (reason) it or marks the payment not needed. Never blocks approval
 *     or processing (user: "it doesn't stop the processing of the PO").
 *   - Settings: payment check ON / OFF per type (editor on BULK_PAGE.ROOT = admin / developer); new orders only.
 * Every change is a timeline row (bulk_order_events) in the same transaction, the order row locked (FOR UPDATE).
 */

export interface DocFile { originalname: string; buffer: Buffer }

/** PDF / PNG / JPEG from the first bytes, or null. */
const fileKind = (b: Buffer): { ext: string; contentType: string } | null => {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: '.pdf', contentType: 'application/pdf' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', contentType: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', contentType: 'image/jpeg' };
  return null;
};

/** The order locked for a change; 404 when missing, 409 BULK_ORDER_CLOSED when rejected / cancelled. */
const lockOpen = async (m: EntityManager, id: string): Promise<BulkOrder> => {
  const o = await m.getRepository(BulkOrder).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!o) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, id);
  if (o.status === BULK_ORDER_STATUS.REJECTED || o.status === BULK_ORDER_STATUS.CANCELLED) throw appError(ERROR_CODES.BULK_ORDER_CLOSED, o.poNumber, o.status);
  return o;
};

/** Checks kind + file (400 with every problem). */
const checkUpload = (body: Record<string, unknown>, file: DocFile | undefined) => {
  const c = new Checker();
  const kind = c.oneOf(body[F.KIND], F.KIND, BULK_DOC_KINDS);
  const k = file ? fileKind(file.buffer) : null;
  if (!file || !file.buffer.length) c.add(BULK_DOCS.FIELD_FILE, errorMessage(ERROR_CODES.FIELD_REQUIRED, BULK_DOCS.FIELD_FILE));
  else if (!k) c.add(BULK_DOCS.FIELD_FILE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, BULK_DOCS.FIELD_FILE, 'a PDF, PNG or JPG file'));
  c.fail();
  return { kind: kind!, file: file!, ext: k!.ext, contentType: k!.contentType };
};

/** Stores the file in S3, then (one transaction) the row, older ones of the kind replaced, payment status, timeline. */
const addDocument = async (orderId: string, byUserId: number, body: Record<string, unknown>, file: DocFile | undefined): Promise<void> => {
  const u = checkUpload(body, file);
  const found = await AppDataSource.getRepository(BulkOrder).findOne({ select: { id: true, poNumber: true, paymentStatus: true }, where: { id: orderId } });
  if (!found) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, orderId);
  const po = found.poNumber;
  // no payment check on the order (Marketing, user 2026-11-13: "don't show the payment upload to marketing"): no proof
  if (u.kind === BULK_DOC_KIND.PAYMENT_PROOF && !found.paymentStatus) {
    const c = new Checker();
    c.add(F.KIND, `${po} has no payment check: upload a proforma or an invoice instead`);
    c.fail();
  }
  const s3Url = s3UrlOfKey(`${BULK_DOCS.S3_FOLDER}/${po}/${randomUUID()}${u.ext}`);
  await writeS3File(s3Url, u.file.buffer);
  const fileName = (u.file.originalname || `${u.kind}${u.ext}`).slice(0, 255);
  await AppDataSource.transaction(async (m) => {
    const o = await lockOpen(m, orderId);
    const docs = m.getRepository(BulkOrderDocument);
    const current = await docs.find({ select: { id: true, fileName: true }, where: { orderId, kind: u.kind, replacedAt: IsNull() } });
    const now = new Date();
    // 2026-11-24 (user: 'put 3'): proofs are KEPT together (screenshots), up to PAYMENT_PROOFS_MAX; other kinds: a new one replaces the old
    const isProof = u.kind === BULK_DOC_KIND.PAYMENT_PROOF;
    if (isProof && current.length >= BULK_ORDERS.PAYMENT_PROOFS_MAX) {
      const c = new Checker();
      c.add(F.KIND, `${o.poNumber} already has ${BULK_ORDERS.PAYMENT_PROOFS_MAX} proof files: wait for them to be checked (a refused proof can be sent again)`);
      c.fail();
    }
    const older = isProof ? [] : current;
    if (older.length) await docs.update(older.map((d) => d.id), { replacedAt: now });
    await docs.insert({ orderId, kind: u.kind, fileName, contentType: u.contentType, sizeBytes: u.file.buffer.length, s3Url, uploadedBy: byUserId });
    await addEvent(m, orderId, BULK_EVENT.DOCUMENT_ADDED, byUserId, null, { kind: u.kind, fileName, ...(older.length ? { replaced: older.map((d) => d.fileName) } : {}) });
    // a new proof (also after paid / refused / not needed) = finance checks the latest one; v2 5b: an invoice on an
    // unbilled order = invoiced
    const next = u.kind === BULK_DOC_KIND.PAYMENT_PROOF && o.paymentStatus && o.paymentStatus !== BULK_PAYMENT_STATUS.PAYMENT_SUBMITTED ? BULK_PAYMENT_STATUS.PAYMENT_SUBMITTED
      : u.kind === BULK_DOC_KIND.INVOICE && o.paymentStatus === BULK_PAYMENT_STATUS.UNBILLED ? BULK_PAYMENT_STATUS.INVOICED : null;
    if (next) {
      await m.getRepository(BulkOrder).update({ id: orderId }, { paymentStatus: next, updatedAt: now });
      await addEvent(m, orderId, BULK_EVENT.PAYMENT, byUserId, null, { status: [o.paymentStatus, next] });
    }
    log.info(LOG_SOURCE.API, `[bulk-orders] ${o.poNumber} ${u.kind} "${fileName}" uploaded by user ${byUserId}${older.length ? ` (replaces ${older.length})` : ''}`);
  });
};

/** Portal upload: editor on the order's type, an approver, or finance (v2 5b: verify payments permission). */
export const uploadBulkDocument = async (actor: BulkActor, id: string, body: Record<string, unknown>, file: DocFile | undefined) => {
  const r = await needAnyBulk(actor);
  const t = await typeOfOrder(r, id);
  const details = await hasCapability(actor.id, actor.roles, CAPABILITY.BULK_PAYMENT_DETAILS);
  if (!allows(r.types[t], ACCESS_LEVEL.EDITOR) && !allows(r.approve, ACCESS_LEVEL.EDITOR) && !details && !(await hasCapability(actor.id, actor.roles, CAPABILITY.BULK_PAYMENT_VERIFY))) throw appError(ERROR_CODES.BULK_TYPE_NOT_ALLOWED, t, 'upload documents to');
  if (body[F.KIND] === BULK_DOC_KIND.PAYMENT_QR && !details) throw appError(ERROR_CODES.BULK_NOT_PAYMENT_DETAILS);
  await addDocument(id, actor.id, body, file);
  if (body[F.KIND] === BULK_DOC_KIND.PAYMENT_QR) await notifyDetails(actor.id, id);
  return getBulkOrder(actor, id);
};

/** Our team's upload (the route checks PO review editor); a QR needs the payment details permission. */
export const teamUploadBulkDocument = async (actor: BulkActor, id: string, body: Record<string, unknown>, file: DocFile | undefined) => {
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  if (body[F.KIND] === BULK_DOC_KIND.PAYMENT_QR && !(await hasCapability(actor.id, actor.roles, CAPABILITY.BULK_PAYMENT_DETAILS))) throw appError(ERROR_CODES.BULK_NOT_PAYMENT_DETAILS);
  await addDocument(id, actor.id, body, file);
  if (body[F.KIND] === BULK_DOC_KIND.PAYMENT_QR) await notifyDetails(actor.id, id);
  return teamBulkOrder(id);
};

/** One document's bytes from S3 (the callers check who may see the order). */
const openDocument = async (orderId: string, docId: string) => {
  const d = /^\d{1,18}$/.test(docId) ? await AppDataSource.getRepository(BulkOrderDocument).findOneBy({ id: docId, orderId }) : null;
  const file = d ? await openS3File(d.s3Url) : undefined;
  if (!d || !file) throw appError(ERROR_CODES.BULK_DOCUMENT_NOT_FOUND, docId);
  return { ...file, contentType: d.contentType, name: d.fileName };
};

export const openBulkDocument = async (actor: BulkActor, id: string, docId: string) => {
  await typeOfOrder(await needAnyBulk(actor), id);
  return openDocument(id, docId);
};

export const teamOpenBulkDocument = async (id: string, docId: string) => {
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  return openDocument(id, docId);
};

const PAYMENT_TO: Partial<Record<string, BulkPaymentStatus>> = {
  [BULK_PAYMENT_ACTION.VERIFY]: BULK_PAYMENT_STATUS.PAID,
  [BULK_PAYMENT_ACTION.NOT_NEEDED]: BULK_PAYMENT_STATUS.NOT_NEEDED,
};

/**
 * 403 unless the person may do the action: payment details (set_details) = CAPABILITY.BULK_PAYMENT_DETAILS, the rest =
 * CAPABILITY.BULK_PAYMENT_VERIFY (admin / developer always, else a role it is switched on for).
 */
const needPaymentVerifier = async (actor: BulkActor, action?: unknown): Promise<void> => {
  if (action === BULK_PAYMENT_ACTION.SET_DETAILS) {
    if (!(await hasCapability(actor.id, actor.roles, CAPABILITY.BULK_PAYMENT_DETAILS))) throw appError(ERROR_CODES.BULK_NOT_PAYMENT_DETAILS);
    return;
  }
  if (!(await hasCapability(actor.id, actor.roles, CAPABILITY.BULK_PAYMENT_VERIFY))) throw appError(ERROR_CODES.BULK_NOT_PAYMENT_VERIFIER);
};

/** The requester hears that payment details are there (bell + email if on). */
const notifyDetails = async (actorId: number, id: string): Promise<void> => {
  const o = await AppDataSource.getRepository(BulkOrder).findOne({ select: { id: true, poNumber: true, createdBy: true, orderType: true, totalUnits: true }, where: { id } });
  if (o) await notifyBulk('payment_details', { id: String(o.id), poNumber: o.poNumber, createdBy: o.createdBy, orderType: o.orderType, totalUnits: o.totalUnits }, actorId);
};

/**
 * The payment check: { action: verify | refuse | not_needed, note? } (refuse needs a note). verify / refuse only while a
 * proof waits (proof_uploaded); not_needed any time. Any order status except rejected / cancelled. Who: the special
 * permission "Bulk Orders: verify payments" (2026-11-13; was the portal approver), in the portal (setBulkPayment: also
 * needs to see the order's type) or in POST_FG (teamSetBulkPayment: PO review access, checked by the route).
 */
const decidePayment = async (actorId: number, id: string, body: Record<string, unknown>): Promise<void> => {
  let told: { event: 'payment_details' | 'payment_paid' | 'payment_refused'; o: BulkOrder; note: string } | null = null;
  const c = new Checker();
  const action = c.oneOf(body[F.ACTION], F.ACTION, BULK_PAYMENT_ACTIONS);
  const note = c.text(body[F.NOTE], F.NOTE, BULK_ORDERS.NOTE_MAX, action === BULK_PAYMENT_ACTION.REFUSE) || null;
  // 2026-11-24: set_details = { link?, bankDetails? } ('' clears one; at least one of them sent)
  const isDetails = action === BULK_PAYMENT_ACTION.SET_DETAILS;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const link = isDetails && has(F.LINK) ? c.text(body[F.LINK], F.LINK, BULK_ORDERS.PAYMENT_LINK_MAX, false) : undefined;
  if (link && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(link)) c.add(F.LINK, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.LINK, 'a payment link starting with https://'));
  const bank = isDetails && has(F.BANK_DETAILS) ? (typeof body[F.BANK_DETAILS] === 'string' ? (body[F.BANK_DETAILS] as string).trim() : null) : undefined;
  if (bank === null) c.add(F.BANK_DETAILS, errorMessage(ERROR_CODES.FIELD_NOT_TEXT, F.BANK_DETAILS));
  else if (bank && bank.length > BULK_ORDERS.BANK_DETAILS_MAX) c.add(F.BANK_DETAILS, errorMessage(ERROR_CODES.FIELD_TOO_LONG, F.BANK_DETAILS, BULK_ORDERS.BANK_DETAILS_MAX));
  if (isDetails && link === undefined && bank === undefined) c.add(F.LINK, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.LINK, `${F.LINK} and / or ${F.BANK_DETAILS}`));
  c.fail();
  await AppDataSource.transaction(async (m) => {
    const o = await lockOpen(m, id);
    if (!o.paymentStatus) throw appError(ERROR_CODES.BULK_PAYMENT_NOT_TRACKED, o.poNumber);
    const now = new Date();
    if (isDetails) {
      const next = { ...(link !== undefined ? { paymentLink: link || null } : {}), ...(bank !== undefined ? { paymentBankDetails: bank || null } : {}) };
      await m.getRepository(BulkOrder).update({ id }, { ...next, paymentLinkBy: actorId, paymentLinkAt: now, updatedAt: now });
      await addEvent(m, id, BULK_EVENT.PAYMENT, actorId, note, {
        ...(link !== undefined ? { link: [o.paymentLink, link || null] } : {}), ...(bank !== undefined ? { bankDetails: [o.paymentBankDetails, bank || null] } : {}),
      });
      log.info(LOG_SOURCE.API, `[bulk-orders] ${o.poNumber} payment details set by user ${actorId}`);
      if (link || bank) told = { event: 'payment_details', o, note: '' };
      return;
    }
    if (action !== BULK_PAYMENT_ACTION.NOT_NEEDED && o.paymentStatus !== BULK_PAYMENT_STATUS.PAYMENT_SUBMITTED) throw appError(ERROR_CODES.BULK_PAYMENT_NO_PROOF, o.poNumber);
    // a refused proof: back to waiting for the payment (invoiced; unbilled when no invoice was uploaded)
    const hasInvoice = action === BULK_PAYMENT_ACTION.REFUSE
      && (await m.getRepository(BulkOrderDocument).count({ where: { orderId: id, kind: BULK_DOC_KIND.INVOICE, replacedAt: IsNull() } })) > 0;
    const to = PAYMENT_TO[action!] ?? (hasInvoice ? BULK_PAYMENT_STATUS.INVOICED : BULK_PAYMENT_STATUS.UNBILLED);
    await m.getRepository(BulkOrder).update({ id }, { paymentStatus: to, paymentBy: actorId, paymentAt: now, paymentNote: note, updatedAt: now });
    await addEvent(m, id, BULK_EVENT.PAYMENT, actorId, note, { status: [o.paymentStatus, to], ...(action === BULK_PAYMENT_ACTION.REFUSE ? { refused: true } : {}) });
    // a refused proof: its files are set aside (kept, replaced) so the buyer can send a new set of up to PAYMENT_PROOFS_MAX
    if (action === BULK_PAYMENT_ACTION.REFUSE) {
      await m.getRepository(BulkOrderDocument).update({ orderId: id, kind: BULK_DOC_KIND.PAYMENT_PROOF, replacedAt: IsNull() }, { replacedAt: now });
    }
    if (action === BULK_PAYMENT_ACTION.VERIFY) told = { event: 'payment_paid', o, note: '' };
    if (action === BULK_PAYMENT_ACTION.REFUSE) told = { event: 'payment_refused', o, note: note ?? '' };
    log.info(LOG_SOURCE.API, `[bulk-orders] ${o.poNumber} payment ${o.paymentStatus} -> ${to} by user ${actorId}`);
  });
  // the requester hears it (bell + email if on); never fails the action
  if (told) {
    const t = told as { event: 'payment_details' | 'payment_paid' | 'payment_refused'; o: BulkOrder; note: string };
    await notifyBulk(t.event, { id: String(t.o.id), poNumber: t.o.poNumber, createdBy: t.o.createdBy, orderType: t.o.orderType, totalUnits: t.o.totalUnits }, actorId, t.note);
  }
};

/** Portal: POST /bulk-orders/:id/payment. */
export const setBulkPayment = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  const r = await needAnyBulk(actor);
  await needPaymentVerifier(actor, body[F.ACTION]);
  await typeOfOrder(r, id);
  await decidePayment(actor.id, id, body);
  return getBulkOrder(actor, id);
};

/** POST_FG: POST /po-review/bulk-orders/:id/payment (any type; the route checks PO review access). */
export const teamSetBulkPayment = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  await needPaymentVerifier(actor, body[F.ACTION]);
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  await decidePayment(actor.id, id, body);
  return teamBulkOrder(id);
};

// ---- settings (admin) ----------------------------------------------------------------------------------------------

export const needSettingsAdmin = async (actor: BulkActor): Promise<void> => {
  const rows = await loadAccess(actor.id, actor.roles);
  if (!allows(accessFrom(rows, BULK_PAGE.ROOT), ACCESS_LEVEL.EDITOR)) throw appError(ERROR_CODES.BULK_NOT_SETTINGS_ADMIN);
};

/** Every type's settings (a type with no row = all off). */
export const listBulkSettings = async (actor: BulkActor) => {
  await needSettingsAdmin(actor);
  const rows = await AppDataSource.getRepository(BulkTypeSetting).find();
  const names = await userNames(rows.map((x) => x.updatedBy ?? 0));
  return BULK_ORDER_TYPES.map((type) => {
    const x = rows.find((y) => y.orderType === type);
    return {
      type, paymentCheck: x?.paymentCheck === true, approvalOverUnits: x?.approvalOverUnits ?? null,
      updatedBy: x?.updatedBy ? { id: x.updatedBy, name: names.get(x.updatedBy) ?? null } : null, updatedAt: x?.updatedAt ?? null,
    };
  });
};

/**
 * { paymentCheck?: boolean, approvalOverUnits?: whole number 0..OVER_UNITS_MAX | null } for one type (at least one);
 * applies to orders created (or edited) after it. v2 1c: approvalOverUnits = an order with MORE units needs approval,
 * null = never by units (BULK_APPROVAL).
 */
export const updateBulkSetting = async (actor: BulkActor, type: string, body: Record<string, unknown>) => {
  await needSettingsAdmin(actor);
  const c = new Checker();
  const t = c.oneOf<BulkOrderType>(type, F.TYPE, BULK_ORDER_TYPES);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const v = body[F.PAYMENT_CHECK];
  if (has(F.PAYMENT_CHECK) && typeof v !== 'boolean') c.add(F.PAYMENT_CHECK, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.PAYMENT_CHECK, 'true or false'));
  const u = body[F.APPROVAL_OVER_UNITS];
  if (has(F.APPROVAL_OVER_UNITS) && u !== null && !(Number.isInteger(u) && (u as number) >= 0 && (u as number) <= BULK_APPROVAL.OVER_UNITS_MAX)) {
    c.add(F.APPROVAL_OVER_UNITS, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.APPROVAL_OVER_UNITS, `a whole number 0 to ${BULK_APPROVAL.OVER_UNITS_MAX}, or null (never)`));
  }
  if (!has(F.PAYMENT_CHECK) && !has(F.APPROVAL_OVER_UNITS)) c.add(F.PAYMENT_CHECK, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.PAYMENT_CHECK, `${F.PAYMENT_CHECK} and / or ${F.APPROVAL_OVER_UNITS}`));
  c.fail();
  const repo = AppDataSource.getRepository(BulkTypeSetting);
  const cur = await repo.findOneBy({ orderType: t! });
  const next = {
    paymentCheck: has(F.PAYMENT_CHECK) ? (v as boolean) : cur?.paymentCheck ?? false,
    approvalOverUnits: has(F.APPROVAL_OVER_UNITS) ? (u as number | null) : cur?.approvalOverUnits ?? null,
  };
  await repo.upsert({ orderType: t!, ...next, updatedBy: actor.id, updatedAt: new Date() }, ['orderType']);
  log.info(LOG_SOURCE.API, `[bulk-orders] setting ${t} paymentCheck=${String(next.paymentCheck)} approvalOverUnits=${String(next.approvalOverUnits)} by user ${actor.id}`);
  return listBulkSettings(actor);
};

// ---- head office address (2026-11-25, user: 'the default is our main Boomerang office in Mumbai') -----------------------

/** The head office address (admin = editor on /bulk-orders); null = not set yet. */
export const getHeadOfficeSetting = async (actor: BulkActor) => {
  await needSettingsAdmin(actor);
  return readHeadOffice();
};

/**
 * { receiverName, receiverPhone, address: { line, city, state, pincode } } -> the head office address used as the default
 * of Head office orders; any other address on one needs approval (bulk-orders.service offHeadOfficeOf).
 */
export const saveHeadOfficeSetting = async (actor: BulkActor, body: Record<string, unknown>) => {
  await needSettingsAdmin(actor);
  const c = new Checker();
  const receiverName = c.text(body[F.RECEIVER_NAME], F.RECEIVER_NAME, BULK_ORDERS.NAME_MAX);
  const phoneText = c.text(body[F.RECEIVER_PHONE], F.RECEIVER_PHONE, 20);
  const receiverPhone = phoneText ? normalPhone(phoneText) : null;
  if (phoneText && !receiverPhone) c.add(F.RECEIVER_PHONE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.RECEIVER_PHONE, 'a 10-digit phone number'));
  const a = checkAddress(c, body[F.ADDRESS]);
  c.fail();
  const value: HeadOffice = { receiverName, receiverPhone: receiverPhone!, line: a.line, city: a.city, state: a.state, pincode: a.pincode };
  await AppDataSource.getRepository(AppState).save({ key: BULK_APPROVAL.HEAD_OFFICE_KEY, value: { ...value, updatedBy: actor.id }, updatedAt: new Date() });
  log.info(LOG_SOURCE.API, `[bulk-orders] head office address set (${a.city} ${a.pincode}) by user ${actor.id}`);
  return readHeadOffice();
};
