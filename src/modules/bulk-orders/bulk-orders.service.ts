import { EntityManager, In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ACCESS_LEVEL,
  AccessLevel,
  BULK_BODY as F,
  BULK_DELIVERY_MODES,
  BULK_ORDER_STATUS,
  BULK_ORDER_STATUSES,
  BULK_ORDER_TYPE,
  BULK_ORDER_TYPES,
  BULK_ORDERS,
  BULK_PAGE,
  BULK_PO_PREFIX,
  BULK_PRIORITIES,
  BULK_TYPE_PAGE,
  BulkOrderType,
  ERROR_CODES,
  errorMessage,
  IST_OFFSET_MS,
  TABLES,
} from '../../constants';
import { BulkLocation, BulkOrder, BulkOrderLine, MasterSku, User } from '../../entities';
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

const bulkRights = async (actor: BulkActor): Promise<BulkRights> => {
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

class Checker {
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

const isId = (v: unknown): v is string | number => (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,18}$/.test(v));

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

/** Creates a bulk order (editor on its type): prices from the PEP SKU master, a new PO number, pending approval. */
export const createBulkOrder = async (actor: BulkActor, body: Record<string, unknown>) => {
  const c = new Checker();
  const type = typeParam(c, body[F.TYPE]);
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
  let mode: string | null = null;
  if (type === BULK_ORDER_TYPE.MARKETING) mode = c.oneOf(body[F.MODE], F.MODE, BULK_DELIVERY_MODES);
  const note = c.text(body[F.NOTE], F.NOTE, BULK_ORDERS.NOTE_MAX, false) || null;
  // where: a saved location (its id) or an address typed now (+ optional name to save it under)
  const locationId = body[F.LOCATION_ID];
  let address: AddressIn | null = null;
  let saveAs = '';
  if (locationId !== undefined && locationId !== null && locationId !== '') {
    if (!isId(locationId)) c.add(F.LOCATION_ID, errorMessage(ERROR_CODES.FIELD_BAD_FORMAT, F.LOCATION_ID, 'a saved location id'));
  } else {
    address = checkAddress(c, body[F.ADDRESS]);
    saveAs = c.text(body[F.SAVE_LOCATION_AS], F.SAVE_LOCATION_AS, BULK_ORDERS.LABEL_MAX, false);
  }
  const lines = checkLines(c, body[F.LINES]);
  c.fail();
  const t = type!;
  needType(await bulkRights(actor), t, ACCESS_LEVEL.EDITOR);

  // prices from OUR master (never from the request): one read for every line
  const skus = await AppDataSource.getRepository(MasterSku).find({
    select: { pepCode: true, productName: true, mrp: true, isActive: true },
    where: { pepCode: In(lines.map((l) => l.pepCode)) },
  });
  const byCode = new Map(skus.map((s) => [s.pepCode.toUpperCase(), s]));
  lines.forEach((l, i) => {
    const s = byCode.get(l.pepCode.toUpperCase());
    const at = `${F.LINES}[${i}].${F.PEP_CODE}`;
    if (!s || s.isActive === false) c.add(at, `${l.pepCode} is not an active SKU in the PEP SKU master`);
    else if (!s.mrp || Number(s.mrp) <= 0) c.add(at, `${l.pepCode} has no MRP in the PEP SKU master: ask the masters team`);
  });
  c.fail();

  const priced = lines.map((l, i) => {
    const s = byCode.get(l.pepCode.toUpperCase())!;
    const mrp = Number(s.mrp);
    const unitPrice = priceAfterDiscount(mrp, l.discountPct);
    return {
      lineNo: i + 1, pepCode: s.pepCode, productName: s.productName, mrp,
      requestedQty: l.qty, requestedDiscountPct: l.discountPct, qty: l.qty, discountPct: l.discountPct,
      unitPrice, lineTotal: round2(unitPrice * l.qty),
    };
  });

  const id = await withDeadlockRetry(() => AppDataSource.transaction(async (m) => {
    let where: { id: string | null; label: string | null; a: AddressIn };
    if (address) {
      const saved = saveAs ? await insertLocation(m, t, saveAs, address, actor.id) : null;
      where = { id: saved ? String(saved.id) : null, label: saved?.label ?? null, a: address };
    } else {
      const loc = await m.getRepository(BulkLocation).findOneBy({ id: String(locationId), orderType: t });
      if (!loc) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: F.LOCATION_ID, code: ERROR_CODES.VALIDATION_FAILED, message: `No saved ${t} location ${String(locationId)}` }]);
      where = { id: String(loc.id), label: loc.label, a: { line: loc.addressLine, city: loc.city, state: loc.state, pincode: loc.pincode } };
    }
    const poNumber = await takeBulkPoNumber(m, t);
    const res = await m.getRepository(BulkOrder).insert({
      poNumber, orderType: t, status: BULK_ORDER_STATUS.PENDING_APPROVAL, orderedBy, receiverName, receiverPhone: phone!,
      locationId: where.id, locationLabel: where.label, addressLine: where.a.line, city: where.a.city, state: where.a.state, pincode: where.a.pincode,
      neededBy, deliveryMode: mode, priority: priority!, note,
      lineCount: priced.length, totalUnits: priced.reduce((s, l) => s + l.qty, 0),
      totalMrp: round2(priced.reduce((s, l) => s + l.mrp * l.qty, 0)), totalValue: round2(priced.reduce((s, l) => s + l.lineTotal, 0)),
      createdBy: actor.id,
    });
    const orderId = String(res.identifiers[0].id);
    await m.getRepository(BulkOrderLine).insert(priced.map((l) => ({ ...l, orderId })));
    log.info(LOG_SOURCE.API, `[bulk-orders] ${poNumber} created (${t}, ${priced.length} SKUs) by user ${actor.id}`);
    return orderId;
  }));
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
});

const userNames = async (ids: number[]): Promise<Map<number, string>> => {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const us = await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { id: In(uniq) } });
  return new Map(us.map((u) => [u.id, u.name || u.email]));
};

/** Orders of the types the person may see, newest first; filters type / status / search (PO number, ordered by, receiver, city). */
export const listBulkOrders = async (actor: BulkActor, q: Record<string, unknown>) => {
  const c = new Checker();
  const type = q.type === undefined || q.type === '' ? null : typeParam(c, q.type);
  const status = q.status === undefined || q.status === '' ? null : c.oneOf(q.status, 'status', BULK_ORDER_STATUSES);
  const page = q.page === undefined ? 1 : Number(q.page);
  const size = q.pageSize === undefined ? BULK_ORDERS.PAGE_SIZE : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1) c.add('page', errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, 'page', 1, 1_000_000));
  if (!Number.isInteger(size) || size < 1 || size > BULK_ORDERS.PAGE_SIZE_MAX) c.add('pageSize', errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, 'pageSize', 1, BULK_ORDERS.PAGE_SIZE_MAX));
  const search = c.text(q.q, 'q', 100, false);
  c.fail();
  const r = await needAnyBulk(actor);
  if (type) needType(r, type, ACCESS_LEVEL.VIEWER);
  const types = type ? [type] : viewable(r);
  if (!types.length) return { items: [], meta: { total: 0, page, pageSize: size } };

  const qb = AppDataSource.getRepository(BulkOrder).createQueryBuilder('o').where('o.orderType IN (:...types)', { types });
  if (status) qb.andWhere('o.status = :status', { status });
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    qb.andWhere('(o.poNumber LIKE :like OR o.orderedBy LIKE :like OR o.receiverName LIKE :like OR o.city LIKE :like OR o.locationLabel LIKE :like)', { like });
  }
  const [found, total] = await qb.orderBy('o.createdAt', 'DESC').addOrderBy('o.id', 'DESC').skip((page - 1) * size).take(size).getManyAndCount();
  const names = await userNames(found.flatMap((o) => [o.createdBy, o.decidedBy ?? 0]));
  return { items: found.map((o) => orderOut(o, names)), meta: { total, page, pageSize: size } };
};

/** One order with its lines; 404 when missing or of a type the person may not see. */
export const getBulkOrder = async (actor: BulkActor, id: string) => {
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  const o = await AppDataSource.getRepository(BulkOrder).findOneBy({ id });
  const r = await needAnyBulk(actor);
  if (!o || !allows(r.types[o.orderType as BulkOrderType] ?? ACCESS_LEVEL.NONE, ACCESS_LEVEL.VIEWER)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, id);
  const lines = await AppDataSource.getRepository(BulkOrderLine).find({ where: { orderId: id }, order: { lineNo: 'ASC' } });
  const names = await userNames([o.createdBy, o.decidedBy ?? 0]);
  return {
    ...orderOut(o, names),
    lines: lines.map((l) => ({
      lineNo: l.lineNo, pepCode: l.pepCode, name: l.productName, mrp: l.mrp, qty: l.qty, discountPct: l.discountPct,
      unitPrice: l.unitPrice, lineTotal: l.lineTotal, requestedQty: l.requestedQty, requestedDiscountPct: l.requestedDiscountPct,
    })),
  };
};
