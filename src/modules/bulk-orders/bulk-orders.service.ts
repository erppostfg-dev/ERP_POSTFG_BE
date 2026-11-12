import { EntityManager, In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCESS_LEVEL,
  AccessLevel,
  BULK_BODY as F,
  BULK_DELIVERY_MODES,
  BULK_EVENT,
  BulkEventAction,
  BULK_ORDER_STATUS,
  BULK_ORDER_STATUSES,
  BULK_ORDER_TYPE,
  BULK_ORDER_TYPES,
  BULK_ORDERS,
  BULK_PAGE,
  BULK_PAYMENT_STATUS,
  BULK_PO_PREFIX,
  BULK_PRIORITIES,
  BULK_TYPE_PAGE,
  BulkOrderType,
  ERROR_CODES,
  errorMessage,
  IST_OFFSET_MS,
  TABLES,
} from '../../constants';
import { BulkLocation, BulkOrder, BulkOrderDocument, BulkOrderEvent, BulkOrderLine, BulkTypeSetting, MasterSku, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { LOG_SOURCE } from '../../constants/logging';
import { accessFrom, allows, loadAccess } from '../auth/access.service';
import { cachedPepSkus } from '../masters/masters.cache';

/*
 * Bulk Orders portal step 1 (2026-11-11, constants/bulk-orders.ts): create an order, list / open orders, SKU search
 * with MRP, saved locations. Access = page access per type (BULK_TYPE_PAGE), read ONCE per request (loadAccess, cached).
 * Prices are worked out HERE from the PEP SKU master (the request sends only pep code, qty, discount %).
 * DB load: create = 1 SKU read + 1 counter upsert + 3 inserts in one transaction; list = 1 count + 1 page (no lines);
 * one order = 3 reads.
 */

export interface BulkActor { id: number; roles: string[] }

/** What a person may do per type + approve: worked out from one access load. */
export interface BulkRights {
  types: Record<BulkOrderType, AccessLevel>;
  approve: AccessLevel;
}

export const bulkRights = async (actor: BulkActor): Promise<BulkRights> => {
  const rows = await loadAccess(actor.id, actor.roles);
  return {
    types: Object.fromEntries(BULK_ORDER_TYPES.map((t) => [t, accessFrom(rows, BULK_TYPE_PAGE[t])])) as Record<BulkOrderType, AccessLevel>,
    approve: accessFrom(rows, BULK_PAGE.APPROVE),
  };
};

const viewable = (r: BulkRights): BulkOrderType[] => BULK_ORDER_TYPES.filter((t) => allows(r.types[t], ACCESS_LEVEL.VIEWER));

/** 403 unless the person has `level` on the type's page. */
const needType = (r: BulkRights, type: BulkOrderType, level: AccessLevel): void => {
  if (!allows(r.types[type], level)) throw appError(ERROR_CODES.BULK_TYPE_NOT_ALLOWED, type, level === ACCESS_LEVEL.EDITOR ? 'create' : 'see');
};

/** 403 for someone with no Bulk Orders page at all (e.g. a POST_FG-only person calling the portal API). */
export const needAnyBulk = async (actor: BulkActor): Promise<BulkRights> => {
  const r = await bulkRights(actor);
  if (!viewable(r).length && !allows(r.approve, ACCESS_LEVEL.VIEWER)) throw appError(ERROR_CODES.BULK_NO_ORDER_ACCESS);
  return r;
};

// ---- request checks ----------------------------------------------------------------------------------------------

interface Issue { field: string; code: string; message: string }

export class Checker {
  issues: Issue[] = [];
  add(field: string, message: string): void {
    this.issues.push({ field, code: ERROR_CODES.VALIDATION_FAILED, message });
  }
  /** Required text, trimmed, at most `max`; '' when missing / wrong (issue recorded). */
  text(v: unknown, field: string, max: number, required = true): string {
    if (v === undefined || v === null || v === '') {
      if (required) this.add(field, errorMessage(ERROR_CODES.FIELD_REQUIRED, field));
      return '';
    }
    if (typeof v !== 'string') return this.add(field, errorMessage(ERROR_CODES.FIELD_NOT_TEXT, field)), '';
    const s = v.trim().replace(/\s+/g, ' ');
    if (!s && required) return this.add(field, errorMessage(ERROR_CODES.FIELD_REQUIRED, field)), '';
    if (s.length > max) return this.add(field, errorMessage(ERROR_CODES.FIELD_TOO_LONG, field, max)), '';
    return s;
  }
  oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T | null {
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    if (v === undefined || v === null || v === '') this.add(field, errorMessage(ERROR_CODES.FIELD_REQUIRED, field));
    else this.add(field, errorMessage(ERROR_CODES.FIELD_NOT_ONE_OF, field, allowed.join(', ')));
    return null;
  }
  fail(): void {
    if (this.issues.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(this.issues);
  }
}

/** "+91 98765-43210" / "098765 43210" -> "9876543210"; null when not 10 digits. */
const normalPhone = (v: string): string | null => {
  let d = v.replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return BULK_ORDERS.PHONE_RE.test(d) ? d : null;
};

const todayIst = (): string => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istYear = (): number => new Date(Date.now() + IST_OFFSET_MS).getUTCFullYear();
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Money to 2 decimals (half up). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
/** MRP less discount %, in whole paise (half up): MRP 100, 30% -> 70; 349, 12.5% -> 305.38. mrp x (100 - d) = paise. */
const priceAfterDiscount = (mrp: number, discountPct: number): number => Math.round(Number((mrp * (100 - discountPct)).toFixed(6))) / 100;

interface AddressIn { line: string; city: string; state: string; pincode: string }

const checkAddress = (c: Checker, v: unknown): AddressIn => {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (!v || typeof v !== 'object') c.add(F.ADDRESS, errorMessage(ERROR_CODES.FIELD_REQUIRED, F.ADDRESS));
  const out = {
    line: c.text(a[F.LINE], `${F.ADDRESS}.${F.LINE}`, BULK_ORDERS.ADDRESS_MAX),
    city: c.text(a[F.CITY], `${F.ADDRESS}.${F.CITY}`, BULK_ORDERS.CITY_MAX),
    state: c.text(a[F.STATE], `${F.ADDRESS}.${F.STATE}`, BULK_ORDERS.CITY_MAX),
    pincode: c.text(a[F.PINCODE], `${F.ADDRESS}.${F.PINCODE}`, 10),
  };
  if (out.pincode && !BULK_ORDERS.PINCODE_RE.test(out.pincode)) c.add(`${F.ADDRESS}.${F.PINCODE}`, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, `${F.ADDRESS}.${F.PINCODE}`, '6 digits (not starting with 0)'));
  return out;
};

export const isId = (v: unknown): v is string | number => (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,18}$/.test(v));

// ---- SKUs ----------------------------------------------------------------------------------------------------------

export interface BulkSku { pepCode: string; name: string | null; mrp: number; ean: string | null }

/**
 * Active SKUs with an MRP whose code starts with / name contains / EAN equals the text (at most SKU_RESULTS_MAX), code
 * matches first. Matched in memory on the shared cached SKU list (masters.cache cachedPepSkus, 2026-11-11): no DB query
 * per keystroke; a Masters save drops it at once, anything else within CACHE_TTL_SECONDS. Display only: the price of an
 * order is read fresh from the DB on submit.
 */
export const searchBulkSkus = async (q: unknown): Promise<BulkSku[]> => {
  const text = typeof q === 'string' ? q.trim().toLowerCase() : '';
  if (text.length < BULK_ORDERS.SKU_QUERY_MIN) return [];
  const hits: { s: MasterSku; codeFirst: boolean }[] = [];
  for (const s of await cachedPepSkus()) {
    if (s.isActive === false || !(Number(s.mrp) > 0)) continue;
    const code = s.pepCode.toLowerCase();
    const codeFirst = code.startsWith(text);
    if (codeFirst || (s.productName ?? '').toLowerCase().includes(text) || (s.eanCode ?? '').toLowerCase() === text) hits.push({ s, codeFirst });
  }
  hits.sort((a, b) => Number(b.codeFirst) - Number(a.codeFirst) || a.s.pepCode.localeCompare(b.s.pepCode));
  return hits.slice(0, BULK_ORDERS.SKU_RESULTS_MAX).map(({ s }) => ({ pepCode: s.pepCode, name: s.productName, mrp: Number(s.mrp), ean: s.eanCode }));
};

// ---- locations -----------------------------------------------------------------------------------------------------

const locationOut = (l: BulkLocation) => ({
  id: String(l.id), type: l.orderType, label: l.label,
  address: { line: l.addressLine, city: l.city, state: l.state, pincode: l.pincode },
  createdAt: l.createdAt,
});

const typeParam = (c: Checker, v: unknown): BulkOrderType | null => c.oneOf(v, F.TYPE, BULK_ORDER_TYPES);

export const listBulkLocations = async (actor: BulkActor, type: unknown) => {
  const c = new Checker();
  const t = typeParam(c, type);
  c.fail();
  needType(await bulkRights(actor), t!, ACCESS_LEVEL.VIEWER);
  const found = await AppDataSource.getRepository(BulkLocation).find({ where: { orderType: t! }, order: { label: 'ASC' }, take: BULK_ORDERS.LOCATIONS_MAX });
  return found.map(locationOut);
};

const labelTaken = async (m: EntityManager, type: BulkOrderType, label: string): Promise<boolean> =>
  (await m.getRepository(BulkLocation).count({ where: { orderType: type, label } })) > 0;

const insertLocation = async (m: EntityManager, type: BulkOrderType, label: string, a: AddressIn, userId: number): Promise<BulkLocation> => {
  if (await labelTaken(m, type, label)) throw appError(ERROR_CODES.BULK_LOCATION_LABEL_TAKEN, label);
  const repo = m.getRepository(BulkLocation);
  const res = await repo.insert({ orderType: type, label, addressLine: a.line, city: a.city, state: a.state, pincode: a.pincode, createdBy: userId });
  return repo.findOneByOrFail({ id: String(res.identifiers[0].id) });
};

/** Saves a location for later orders of the type (editor on the type). */
export const addBulkLocation = async (actor: BulkActor, body: Record<string, unknown>) => {
  const c = new Checker();
  const t = typeParam(c, body[F.TYPE]);
  const label = c.text(body[F.LABEL], F.LABEL, BULK_ORDERS.LABEL_MAX);
  const address = checkAddress(c, body[F.ADDRESS]);
  c.fail();
  needType(await bulkRights(actor), t!, ACCESS_LEVEL.EDITOR);
  const saved = await AppDataSource.transaction((m) => insertLocation(m, t!, label, address, actor.id));
  log.info(LOG_SOURCE.API, `[bulk-orders] location "${label}" saved (${t}) by user ${actor.id}`);
  return locationOut(saved);
};

// ---- orders --------------------------------------------------------------------------------------------------------

interface LineIn { pepCode: string; qty: number; discountPct: number }

const checkLines = (c: Checker, v: unknown): LineIn[] => {
  if (!Array.isArray(v) || !v.length) {
    c.add(F.LINES, errorMessage(ERROR_CODES.FIELD_REQUIRED, F.LINES));
    return [];
  }
  if (v.length > BULK_ORDERS.LINES_MAX) {
    c.add(F.LINES, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.LINES, `at most ${BULK_ORDERS.LINES_MAX} SKUs`));
    return [];
  }
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const at = (f: string) => `${F.LINES}[${i}].${f}`;
    const pepCode = c.text(l[F.PEP_CODE], at(F.PEP_CODE), 100);
    const qty = l[F.QTY];
    const d = l[F.DISCOUNT] ?? 0;
    if (!(typeof qty === 'number' && Number.isInteger(qty) && qty >= 1 && qty <= BULK_ORDERS.QTY_MAX)) {
      c.add(at(F.QTY), errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, at(F.QTY), 1, BULK_ORDERS.QTY_MAX));
    }
    if (!(typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= BULK_ORDERS.DISCOUNT_MAX && round2(d) === d)) {
      c.add(at(F.DISCOUNT), errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, at(F.DISCOUNT), `a % from 0 to ${BULK_ORDERS.DISCOUNT_MAX} with at most 2 decimals`));
    }
    const key = pepCode.toUpperCase();
    if (pepCode && seen.has(key)) c.add(at(F.PEP_CODE), errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, at(F.PEP_CODE), 'a SKU not already on another line (change that line\'s quantity)'));
    seen.add(key);
    return { pepCode, qty: qty as number, discountPct: d as number };
  });
};

/**
 * MySQL may answer a deadlock when two FIRST orders of a type + year insert the counter row at the same moment: the
 * whole transaction is rolled back, so it is simply run again (nothing was written).
 */
const withDeadlockRetry = async <T>(run: () => Promise<T>, tries = 3): Promise<T> => {
  for (let i = 1; ; i += 1) {
    try {
      return await run();
    } catch (err) {
      const code = (err as { code?: string; driverError?: { code?: string } }).driverError?.code ?? (err as { code?: string }).code;
      if (code !== 'ER_LOCK_DEADLOCK' || i >= tries) throw err;
      log.warn(LOG_SOURCE.DB, `[bulk-orders] deadlock on a new order, trying again (${i} of ${tries - 1})`);
    }
  }
};

/** Takes the next PO number of a type in THIS transaction: one atomic upsert (row locked until commit). */
const takeBulkPoNumber = async (m: EntityManager, type: BulkOrderType, year = istYear()): Promise<string> => {
  await m.query(
    `INSERT INTO ${TABLES.BULK_ORDER_COUNTERS} (order_type, order_year, last_serial) VALUES (?, ?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_serial = LAST_INSERT_ID(last_serial + 1)`,
    [type, year],
  );
  const [{ n }] = await m.query<{ n: string | number }[]>('SELECT LAST_INSERT_ID() AS n');
  return `${BULK_PO_PREFIX[type]}-${year}-${String(n).padStart(BULK_ORDERS.SERIAL_DIGITS, '0')}`;
};

/** An order's fields as checked from a create / edit request (before the SKUs are priced). */
interface OrderIn {
  type: BulkOrderType;
  orderedBy: string;
  receiverName: string;
  phone: string;
  neededBy: string;
  priority: string;
  mode: string | null;
  note: string | null;
  locationId: string | null;
  address: AddressIn | null;
  saveAs: string;
  lines: LineIn[];
}

/** Checks a create / edit body; `fixedType` = an edit (the type never changes). Throws 400 with every wrong field. */
const parseOrder = (body: Record<string, unknown>, fixedType?: BulkOrderType): OrderIn => {
  const c = new Checker();
  const type = fixedType ?? typeParam(c, body[F.TYPE]);
  const orderedBy = c.text(body[F.ORDERED_BY], F.ORDERED_BY, BULK_ORDERS.NAME_MAX);
  const receiverName = c.text(body[F.RECEIVER_NAME], F.RECEIVER_NAME, BULK_ORDERS.NAME_MAX);
  const phoneText = c.text(body[F.RECEIVER_PHONE], F.RECEIVER_PHONE, 20);
  const phone = phoneText ? normalPhone(phoneText) : null;
  if (phoneText && !phone) c.add(F.RECEIVER_PHONE, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.RECEIVER_PHONE, 'a 10-digit phone number'));
  const neededBy = c.text(body[F.NEEDED_BY], F.NEEDED_BY, 10);
  if (neededBy && !isDay(neededBy)) c.add(F.NEEDED_BY, errorMessage(ERROR_CODES.FIELD_NOT_DAY, F.NEEDED_BY));
  else if (neededBy && neededBy < todayIst()) c.add(F.NEEDED_BY, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.NEEDED_BY, 'today or later'));
  const priority = c.oneOf(body[F.PRIORITY] ?? BULK_PRIORITIES[0], F.PRIORITY, BULK_PRIORITIES);
  // delivery mode: Marketing only (the design shows it only there)
  const mode = type === BULK_ORDER_TYPE.MARKETING ? c.oneOf(body[F.MODE], F.MODE, BULK_DELIVERY_MODES) : null;
  const note = c.text(body[F.NOTE], F.NOTE, BULK_ORDERS.NOTE_MAX, false) || null;
  // where: a saved location (its id) or an address typed now (+ optional name to save it under)
  const rawLocation = body[F.LOCATION_ID];
  let locationId: string | null = null;
  let address: AddressIn | null = null;
  let saveAs = '';
  if (rawLocation !== undefined && rawLocation !== null && rawLocation !== '') {
    if (!isId(rawLocation)) c.add(F.LOCATION_ID, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.LOCATION_ID, 'a saved location id'));
    else locationId = String(rawLocation);
  } else {
    address = checkAddress(c, body[F.ADDRESS]);
    saveAs = c.text(body[F.SAVE_LOCATION_AS], F.SAVE_LOCATION_AS, BULK_ORDERS.LABEL_MAX, false);
  }
  const lines = checkLines(c, body[F.LINES]);
  c.fail();
  return { type: type!, orderedBy, receiverName, phone: phone!, neededBy, priority: priority!, mode, note, locationId, address, saveAs, lines };
};

/** Today's MRP / name / active of SKUs from OUR master (one read; never the cache, never the request). */
const skusNow = async (codes: string[]): Promise<Map<string, MasterSku>> => {
  if (!codes.length) return new Map();
  const skus = await AppDataSource.getRepository(MasterSku).find({
    select: { pepCode: true, productName: true, mrp: true, isActive: true },
    where: { pepCode: In(codes) },
  });
  return new Map(skus.map((s) => [s.pepCode.toUpperCase(), s]));
};

/** Why a SKU cannot be priced today ('' = it can). */
const notSellable = (code: string, s: MasterSku | undefined): string =>
  !s || s.isActive === false ? `${code} is not an active SKU in the PEP SKU master`
    : !s.mrp || Number(s.mrp) <= 0 ? `${code} has no MRP in the PEP SKU master: ask the masters team` : '';

interface PricedLine {
  lineNo: number; pepCode: string; productName: string | null; mrp: number; requestedQty: number; requestedDiscountPct: number;
  qty: number; discountPct: number; unitPrice: number; lineTotal: number;
}

/** The lines priced on today's MRP (requested = what is asked now); 400 naming each SKU that cannot be sold. */
const priceLines = async (lines: LineIn[]): Promise<PricedLine[]> => {
  const byCode = await skusNow(lines.map((l) => l.pepCode));
  const c = new Checker();
  lines.forEach((l, i) => {
    const why = notSellable(l.pepCode, byCode.get(l.pepCode.toUpperCase()));
    if (why) c.add(`${F.LINES}[${i}].${F.PEP_CODE}`, why);
  });
  c.fail();
  return lines.map((l, i) => {
    const s = byCode.get(l.pepCode.toUpperCase())!;
    const mrp = Number(s.mrp);
    const unitPrice = priceAfterDiscount(mrp, l.discountPct);
    return {
      lineNo: i + 1, pepCode: s.pepCode, productName: s.productName, mrp,
      requestedQty: l.qty, requestedDiscountPct: l.discountPct, qty: l.qty, discountPct: l.discountPct,
      unitPrice, lineTotal: round2(unitPrice * l.qty),
    };
  });
};

/** Units / MRP / value of priced lines (kept on the order so lists need no line query). */
const totalsOf = (lines: { qty: number; mrp: number; lineTotal: number }[]) => ({
  lineCount: lines.length,
  totalUnits: lines.reduce((s, l) => s + l.qty, 0),
  totalMrp: round2(lines.reduce((s, l) => s + l.mrp * l.qty, 0)),
  totalValue: round2(lines.reduce((s, l) => s + l.lineTotal, 0)),
});

/** The delivery address of an order: a saved location of the type, or the typed one (saved under a name if asked). */
const whereTo = async (m: EntityManager, o: OrderIn, userId: number) => {
  if (o.address) {
    const saved = o.saveAs ? await insertLocation(m, o.type, o.saveAs, o.address, userId) : null;
    return { locationId: saved ? String(saved.id) : null, locationLabel: saved?.label ?? null, addressLine: o.address.line, city: o.address.city, state: o.address.state, pincode: o.address.pincode };
  }
  const loc = await m.getRepository(BulkLocation).findOneBy({ id: o.locationId!, orderType: o.type });
  if (!loc) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: F.LOCATION_ID, code: ERROR_CODES.VALIDATION_FAILED, message: `No saved ${o.type} location ${o.locationId}` }]);
  return { locationId: String(loc.id), locationLabel: loc.label, addressLine: loc.addressLine, city: loc.city, state: loc.state, pincode: loc.pincode };
};

/** One timeline row (bulk_order_events), in the same transaction as the change. */
export const addEvent = (m: EntityManager, orderId: string, action: BulkEventAction, by: number, note: string | null, changes: unknown = null) =>
  m.getRepository(BulkOrderEvent).insert({ orderId, action, byUserId: by, note, changes: changes as object | null });

/** Creates a bulk order (editor on its type): prices from the PEP SKU master, a new PO number, pending approval. */
export const createBulkOrder = async (actor: BulkActor, body: Record<string, unknown>) => {
  const o = parseOrder(body);
  needType(await bulkRights(actor), o.type, ACCESS_LEVEL.EDITOR);
  const priced = await priceLines(o.lines);
  const paymentCheck = (await AppDataSource.getRepository(BulkTypeSetting).findOneBy({ orderType: o.type }))?.paymentCheck === true;

  const id = await withDeadlockRetry(() => AppDataSource.transaction(async (m) => {
    const where = await whereTo(m, o, actor.id);
    const poNumber = await takeBulkPoNumber(m, o.type);
    const res = await m.getRepository(BulkOrder).insert({
      poNumber, orderType: o.type, status: BULK_ORDER_STATUS.PENDING_APPROVAL, orderedBy: o.orderedBy, receiverName: o.receiverName,
      receiverPhone: o.phone, ...where, neededBy: o.neededBy, deliveryMode: o.mode, priority: o.priority, note: o.note,
      ...totalsOf(priced), createdBy: actor.id, paymentStatus: paymentCheck ? BULK_PAYMENT_STATUS.AWAITING_PROOF : null,
    });
    const orderId = String(res.identifiers[0].id);
    await m.getRepository(BulkOrderLine).insert(priced.map((l) => ({ ...l, orderId })));
    await addEvent(m, orderId, BULK_EVENT.CREATED, actor.id, o.note);
    log.info(LOG_SOURCE.API, `[bulk-orders] ${poNumber} created (${o.type}, ${priced.length} SKUs) by user ${actor.id}`);
    return orderId;
  }));
  return getBulkOrder(actor, id);
};

/**
 * The order locked for a change (SELECT ... FOR UPDATE: an edit, a cancel and a decision never cross); 404 when it does not
 * exist, 409 BULK_ORDER_NOT_PENDING when it is no longer waiting for approval.
 */
const lockPending = async (m: EntityManager, id: string): Promise<BulkOrder> => {
  const o = await m.getRepository(BulkOrder).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!o) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, id);
  if (o.status !== BULK_ORDER_STATUS.PENDING_APPROVAL) throw appError(ERROR_CODES.BULK_ORDER_NOT_PENDING, o.poNumber, o.status);
  return o;
};

/** The order's type for a check before the transaction (404 when missing or not visible to the person). */
export const typeOfOrder = async (r: BulkRights, id: string): Promise<BulkOrderType> => {
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  const o = await AppDataSource.getRepository(BulkOrder).findOne({ select: { id: true, orderType: true }, where: { id } });
  const t = o?.orderType as BulkOrderType | undefined;
  if (!t || !allows(r.types[t] ?? ACCESS_LEVEL.NONE, ACCESS_LEVEL.VIEWER)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, id);
  return t;
};

const lineSummary = (ls: { pepCode: string; qty: number; discountPct: number }[]) => ls.map((l) => `${l.pepCode} x${l.qty} @${l.discountPct}%`);

/**
 * Edits an order still waiting for approval (user 2026-11-11: "it can get cancelled and editable"; editor on its type):
 * the same body as create (type cannot change), lines priced again on today's MRP, same PO number, still pending.
 */
export const updateBulkOrder = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  const r = await needAnyBulk(actor);
  const t = await typeOfOrder(r, id);
  needType(r, t, ACCESS_LEVEL.EDITOR);
  const o = parseOrder(body, t);
  const priced = await priceLines(o.lines);
  await AppDataSource.transaction(async (m) => {
    const cur = await lockPending(m, id);
    const before = await m.getRepository(BulkOrderLine).find({ where: { orderId: id }, order: { lineNo: 'ASC' } });
    const where = await whereTo(m, o, actor.id);
    const next = {
      orderedBy: o.orderedBy, receiverName: o.receiverName, receiverPhone: o.phone, ...where, neededBy: o.neededBy,
      deliveryMode: o.mode, priority: o.priority, note: o.note,
    };
    const fields = (Object.keys(next) as (keyof typeof next)[]).filter((k) => String(cur[k] ?? '') !== String(next[k] ?? ''));
    await m.getRepository(BulkOrderLine).delete({ orderId: id });
    await m.getRepository(BulkOrderLine).insert(priced.map((l) => ({ ...l, orderId: id })));
    await m.getRepository(BulkOrder).update({ id }, { ...next, ...totalsOf(priced), updatedAt: new Date() });
    await addEvent(m, id, BULK_EVENT.EDITED, actor.id, null, { fields, linesBefore: lineSummary(before), linesAfter: lineSummary(priced) });
    log.info(LOG_SOURCE.API, `[bulk-orders] ${cur.poNumber} edited by user ${actor.id}`);
  });
  return getBulkOrder(actor, id);
};

/** Cancels an order still waiting for approval (editor on its type); `reason` optional. */
export const cancelBulkOrder = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  const r = await needAnyBulk(actor);
  needType(r, await typeOfOrder(r, id), ACCESS_LEVEL.EDITOR);
  const c = new Checker();
  const reason = c.text(body[F.REASON], F.REASON, BULK_ORDERS.NOTE_MAX, false) || null;
  c.fail();
  await AppDataSource.transaction(async (m) => {
    const cur = await lockPending(m, id);
    await m.getRepository(BulkOrder).update({ id }, { status: BULK_ORDER_STATUS.CANCELLED, updatedAt: new Date() });
    await addEvent(m, id, BULK_EVENT.CANCELLED, actor.id, reason);
    log.info(LOG_SOURCE.API, `[bulk-orders] ${cur.poNumber} cancelled by user ${actor.id}`);
  });
  return getBulkOrder(actor, id);
};

/** 403 unless the person approves bulk orders (editor on BULK_PAGE.APPROVE). Admin / developer may approve their own. */
export const needApprover = (r: BulkRights): void => {
  if (!allows(r.approve, ACCESS_LEVEL.EDITOR)) throw appError(ERROR_CODES.BULK_NOT_APPROVER);
};

interface LineChangeIn { lineNo: number; qty?: number; discountPct?: number }

/** Checks an approve body: line changes (existing line numbers), lines to remove, note. */
const parseDecision = (body: Record<string, unknown>, lineNos: Set<number>) => {
  const c = new Checker();
  const changes: LineChangeIn[] = [];
  const raw = body[F.LINES];
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) c.add(F.LINES, errorMessage(ERROR_CODES.FIELD_NOT_LIST, F.LINES));
    else raw.forEach((x, i) => {
      const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const at = (f: string) => `${F.LINES}[${i}].${f}`;
      const no = l[F.LINE_NO];
      if (!(typeof no === 'number' && lineNos.has(no))) c.add(at(F.LINE_NO), errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, at(F.LINE_NO), 'a line number of this order'));
      const out: LineChangeIn = { lineNo: no as number };
      if (l[F.QTY] !== undefined) {
        const q = l[F.QTY];
        if (!(typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= BULK_ORDERS.QTY_MAX)) c.add(at(F.QTY), errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, at(F.QTY), 1, BULK_ORDERS.QTY_MAX));
        else out.qty = q;
      }
      if (l[F.DISCOUNT] !== undefined) {
        const d = l[F.DISCOUNT];
        if (!(typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= BULK_ORDERS.DISCOUNT_MAX && round2(d) === d)) {
          c.add(at(F.DISCOUNT), errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, at(F.DISCOUNT), `a % from 0 to ${BULK_ORDERS.DISCOUNT_MAX} with at most 2 decimals`));
        } else out.discountPct = d;
      }
      changes.push(out);
    });
  }
  const rawRemove = body[F.REMOVE_LINES] ?? [];
  const remove = new Set<number>();
  if (!Array.isArray(rawRemove) || rawRemove.some((n) => !(typeof n === 'number' && lineNos.has(n)))) {
    c.add(F.REMOVE_LINES, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.REMOVE_LINES, 'a list of line numbers of this order'));
  } else rawRemove.forEach((n) => remove.add(n as number));
  if (lineNos.size && [...lineNos].every((n) => remove.has(n))) c.add(F.REMOVE_LINES, 'At least one line must stay: reject the order instead');
  const note = c.text(body[F.NOTE], F.NOTE, BULK_ORDERS.NOTE_MAX, false) || null;
  c.fail();
  return { changes, remove, note };
};

/**
 * Approves an order (editor on Approve bulk orders): the approver may change qty / discount per line or remove lines;
 * every line is priced again on TODAY's MRP (user 2026-11-11); the requester's values stay in requested_*; each change
 * (old -> new) is on the timeline. 409 when it is no longer pending (e.g. a second approver at the same moment).
 */
export const approveBulkOrder = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  const r = await needAnyBulk(actor);
  needApprover(r);
  await typeOfOrder(r, id);
  await AppDataSource.transaction(async (m) => {
    const cur = await lockPending(m, id);
    const lines = await m.getRepository(BulkOrderLine).find({ where: { orderId: id }, order: { lineNo: 'ASC' } });
    const d = parseDecision(body, new Set(lines.map((l) => l.lineNo)));
    const byNo = new Map(d.changes.map((x) => [x.lineNo, x]));
    const kept = lines.filter((l) => !d.remove.has(l.lineNo));
    const today = await skusNow(kept.map((l) => l.pepCode));
    const c = new Checker();
    kept.forEach((l) => {
      const why = notSellable(l.pepCode, today.get(l.pepCode.toUpperCase()));
      if (why) c.add(`line ${l.lineNo}`, `${why}: remove the line or reject the order`);
    });
    c.fail();
    const changed: Record<string, unknown>[] = [];
    const next = kept.map((l) => {
      const x = byNo.get(l.lineNo);
      const qty = x?.qty ?? l.qty;
      const discountPct = x?.discountPct ?? l.discountPct;
      const mrp = Number(today.get(l.pepCode.toUpperCase())!.mrp);
      const unitPrice = priceAfterDiscount(mrp, discountPct);
      const diff: Record<string, unknown> = {};
      if (qty !== l.qty) diff.qty = [l.qty, qty];
      if (discountPct !== l.discountPct) diff.discountPct = [l.discountPct, discountPct];
      if (mrp !== l.mrp) diff.mrp = [l.mrp, mrp];
      if (Object.keys(diff).length) changed.push({ lineNo: l.lineNo, pepCode: l.pepCode, ...diff });
      return { line: l, qty, discountPct, mrp, unitPrice, lineTotal: round2(unitPrice * qty) };
    });
    for (const l of lines.filter((x) => d.remove.has(x.lineNo))) changed.push({ lineNo: l.lineNo, pepCode: l.pepCode, removed: true });
    if (d.remove.size) await m.getRepository(BulkOrderLine).delete({ orderId: id, lineNo: In([...d.remove]) });
    for (const n of next) {
      await m.getRepository(BulkOrderLine).update({ id: n.line.id }, { qty: n.qty, discountPct: n.discountPct, mrp: n.mrp, unitPrice: n.unitPrice, lineTotal: n.lineTotal });
    }
    const now = new Date();
    await m.getRepository(BulkOrder).update({ id }, {
      status: BULK_ORDER_STATUS.APPROVED, decidedBy: actor.id, decidedAt: now, decisionNote: d.note, updatedAt: now,
      ...totalsOf(next.map((n) => ({ qty: n.qty, mrp: n.mrp, lineTotal: n.lineTotal }))),
    });
    await addEvent(m, id, BULK_EVENT.APPROVED, actor.id, d.note, changed.length ? { lines: changed } : null);
    log.info(LOG_SOURCE.API, `[bulk-orders] ${cur.poNumber} approved by user ${actor.id} (${changed.length} line changes)`);
  });
  return getBulkOrder(actor, id);
};

/** Rejects an order (editor on Approve bulk orders); `reason` required. */
export const rejectBulkOrder = async (actor: BulkActor, id: string, body: Record<string, unknown>) => {
  const r = await needAnyBulk(actor);
  needApprover(r);
  await typeOfOrder(r, id);
  const c = new Checker();
  const reason = c.text(body[F.REASON], F.REASON, BULK_ORDERS.NOTE_MAX);
  c.fail();
  await AppDataSource.transaction(async (m) => {
    const cur = await lockPending(m, id);
    const now = new Date();
    await m.getRepository(BulkOrder).update({ id }, { status: BULK_ORDER_STATUS.REJECTED, decidedBy: actor.id, decidedAt: now, decisionNote: reason, updatedAt: now });
    await addEvent(m, id, BULK_EVENT.REJECTED, actor.id, reason);
    log.info(LOG_SOURCE.API, `[bulk-orders] ${cur.poNumber} rejected by user ${actor.id}`);
  });
  return getBulkOrder(actor, id);
};

const orderOut = (o: BulkOrder, names: Map<number, string>) => ({
  id: String(o.id), poNumber: o.poNumber, type: o.orderType, status: o.status,
  orderedBy: o.orderedBy, receiverName: o.receiverName, receiverPhone: o.receiverPhone,
  location: { id: o.locationId ? String(o.locationId) : null, label: o.locationLabel, address: { line: o.addressLine, city: o.city, state: o.state, pincode: o.pincode } },
  neededBy: o.neededBy, mode: o.deliveryMode, priority: o.priority, note: o.note,
  lineCount: o.lineCount, totalUnits: o.totalUnits, totalMrp: o.totalMrp, totalValue: o.totalValue,
  createdBy: { id: o.createdBy, name: names.get(o.createdBy) ?? null }, createdAt: o.createdAt,
  decidedBy: o.decidedBy ? { id: o.decidedBy, name: names.get(o.decidedBy) ?? null } : null, decidedAt: o.decidedAt, decisionNote: o.decisionNote,
  // null = no payment check on this order (off for its type when it was created)
  payment: o.paymentStatus ? {
    status: o.paymentStatus, by: o.paymentBy ? { id: o.paymentBy, name: names.get(o.paymentBy) ?? null } : null, at: o.paymentAt, note: o.paymentNote,
  } : null,
});

export const userNames = async (ids: number[]): Promise<Map<number, string>> => {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const us = await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { id: In(uniq) } });
  return new Map(us.map((u) => [u.id, u.name || u.email]));
};

interface ListQuery { type: BulkOrderType | null; status: string | null; page: number; size: number; search: string }

/** Checks a list query (type, status, q, page, pageSize); 400 with every wrong one. */
const parseListQuery = (q: Record<string, unknown>): ListQuery => {
  const c = new Checker();
  const type = q.type === undefined || q.type === '' ? null : typeParam(c, q.type);
  const status = q.status === undefined || q.status === '' ? null : c.oneOf(q.status, 'status', BULK_ORDER_STATUSES);
  const page = q.page === undefined ? 1 : Number(q.page);
  const size = q.pageSize === undefined ? BULK_ORDERS.PAGE_SIZE : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1) c.add('page', errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, 'page', 1, 1_000_000));
  if (!Number.isInteger(size) || size < 1 || size > BULK_ORDERS.PAGE_SIZE_MAX) c.add('pageSize', errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, 'pageSize', 1, BULK_ORDERS.PAGE_SIZE_MAX));
  const search = c.text(q.q, 'q', 100, false);
  c.fail();
  return { type, status, page, size, search };
};

/** One page of orders of these types (newest first) + the total: 1 count + 1 page query, no lines. */
const pageOfOrders = async (types: BulkOrderType[], l: ListQuery) => {
  if (!types.length) return { items: [], meta: { total: 0, page: l.page, pageSize: l.size } };
  const qb = AppDataSource.getRepository(BulkOrder).createQueryBuilder('o').where('o.orderType IN (:...types)', { types });
  if (l.status) qb.andWhere('o.status = :status', { status: l.status });
  if (l.search) {
    const like = `%${l.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    qb.andWhere('(o.poNumber LIKE :like OR o.orderedBy LIKE :like OR o.receiverName LIKE :like OR o.city LIKE :like OR o.locationLabel LIKE :like)', { like });
  }
  const [found, total] = await qb.orderBy('o.createdAt', 'DESC').addOrderBy('o.id', 'DESC').skip((l.page - 1) * l.size).take(l.size).getManyAndCount();
  const names = await userNames(found.flatMap((o) => [o.createdBy, o.decidedBy ?? 0, o.paymentBy ?? 0]));
  return { items: found.map((o) => orderOut(o, names)), meta: { total, page: l.page, pageSize: l.size } };
};

/** Orders of the types the person may see (portal), newest first; filters type / status / search (PO number, ordered by, receiver, city). */
export const listBulkOrders = async (actor: BulkActor, q: Record<string, unknown>) => {
  const l = parseListQuery(q);
  const r = await needAnyBulk(actor);
  if (l.type) needType(r, l.type, ACCESS_LEVEL.VIEWER);
  return pageOfOrders(l.type ? [l.type] : viewable(r), l);
};

/** One order with lines + timeline (no access check: the callers check). */
export const orderFull = async (o: BulkOrder) => {
  const id = String(o.id);
  const [lines, events, docs] = await Promise.all([
    AppDataSource.getRepository(BulkOrderLine).find({ where: { orderId: id }, order: { lineNo: 'ASC' } }),
    AppDataSource.getRepository(BulkOrderEvent).find({ where: { orderId: id }, order: { id: 'ASC' } }),
    AppDataSource.getRepository(BulkOrderDocument).find({ where: { orderId: id }, order: { id: 'DESC' } }),
  ]);
  const names = await userNames([o.createdBy, o.decidedBy ?? 0, o.paymentBy ?? 0, ...events.map((e) => e.byUserId), ...docs.map((d) => d.uploadedBy)]);
  return {
    ...orderOut(o, names),
    // newest first; replaced ones kept (replacedAt set)
    documents: docs.map((d) => ({
      id: String(d.id), kind: d.kind, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes,
      by: { id: d.uploadedBy, name: names.get(d.uploadedBy) ?? null }, at: d.createdAt, replacedAt: d.replacedAt,
    })),
    events: events.map((e) => ({ action: e.action, by: { id: e.byUserId, name: names.get(e.byUserId) ?? null }, at: e.createdAt, note: e.note, changes: e.changes })),
    lines: lines.map((l) => ({
      lineNo: l.lineNo, pepCode: l.pepCode, name: l.productName, mrp: l.mrp, qty: l.qty, discountPct: l.discountPct,
      unitPrice: l.unitPrice, lineTotal: l.lineTotal, requestedQty: l.requestedQty, requestedDiscountPct: l.requestedDiscountPct,
    })),
  };
};

/** One order with its lines (portal); 404 when missing or of a type the person may not see. */
export const getBulkOrder = async (actor: BulkActor, id: string) => {
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  const o = await AppDataSource.getRepository(BulkOrder).findOneBy({ id });
  const r = await needAnyBulk(actor);
  if (!o || !allows(r.types[o.orderType as BulkOrderType] ?? ACCESS_LEVEL.NONE, ACCESS_LEVEL.VIEWER)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, id);
  return orderFull(o);
};

// ---- our team: PO Processing & Review > Bulk Orders (step 3a, read only; the route checks PO review access) ----------

/** Every type's orders for our team + per type how many approved ones wait (the tab's count): 1 extra GROUP BY. */
export const teamBulkOrders = async (q: Record<string, unknown>) => {
  const l = parseListQuery(q);
  const [found, counts] = await Promise.all([
    pageOfOrders(l.type ? [l.type] : BULK_ORDER_TYPES, l),
    AppDataSource.getRepository(BulkOrder).createQueryBuilder('o').select('o.orderType', 'type').addSelect('COUNT(*)', 'n')
      .where('o.status = :s', { s: BULK_ORDER_STATUS.APPROVED }).groupBy('o.orderType').getRawMany<{ type: string; n: string }>(),
  ]);
  const waiting = Object.fromEntries(BULK_ORDER_TYPES.map((t) => [t, Number(counts.find((c) => c.type === t)?.n ?? 0)])) as Record<BulkOrderType, number>;
  return { items: found.items, meta: { ...found.meta, waiting } };
};

/** One order for our team (any type); 404 when missing. */
export const teamBulkOrder = async (id: string) => {
  const o = isId(id) ? await AppDataSource.getRepository(BulkOrder).findOneBy({ id }) : null;
  if (!o) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  return orderFull(o);
};
