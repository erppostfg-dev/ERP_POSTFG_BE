import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, errorMessage, IST_OFFSET_MS, MASTER_ADD, REVIEW_RECHECK, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { ActivityLog, DetailsChannel, MasterChannel, MasterChannelSku, MasterSku } from '../../entities';
import { appError } from '../../utils/AppError';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { recheckInReview } from '../po-review/recheck.service';

/*
 * The Add forms of the Masters pages (user, 2026-10-27): PEP SKU, channel SKU, channel, channel location.
 *   - admin / developer only (the route checks the role);
 *   - EVERY field of the form is required and checked (format, range, the row not already there, what it points to
 *     exists); every problem is returned at once as VALIDATION_FAILED details { field, code, message }, nothing saved;
 *   - one transaction per add, with an activity_log AUDIT row (who added what);
 *   - after a channel SKU or a location is added, that channel's POs in review are re-checked in the background
 *     (a mapping that was missing closes their issues at once).
 * Add only: no edit or delete here.
 */

export type Problem = { field: string; code: string; message: string };
export interface Actor { id: number; email: string }
type Body = Record<string, unknown>;

/** Field checks: every problem collected, so the form shows them all at once. */
const checker = (body: unknown) => {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Body;
  const problems: Problem[] = [];
  const bad = (field: string, code: keyof typeof ERROR_CODES, ...args: unknown[]) =>
    problems.push({ field, code, message: (errorMessage as (c: string, ...a: unknown[]) => string)(ERROR_CODES[code], ...args) });
  const has = (field: string) => problems.some((p) => p.field === field);
  /** Required text, trimmed; null when missing or bad. */
  const text = (field: string, max: number = MASTER_ADD.TEXT_MAX): string | null => {
    const v = b[field];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return bad(field, 'FIELD_REQUIRED', field), null;
    if (typeof v !== 'string' && typeof v !== 'number') return bad(field, 'FIELD_NOT_TEXT', field), null;
    const s = String(v).trim();
    if (s.length > max) return bad(field, 'FIELD_TOO_LONG', field, max), null;
    return s;
  };
  const format = (field: string, f: { re: RegExp; rule: string }, upper = false): string | null => {
    const s = text(field);
    if (s === null) return null;
    const v = upper ? s.toUpperCase() : s;
    return f.re.test(v) ? v : (bad(field, 'FIELD_BAD_FORMAT', field, f.rule), null);
  };
  /** Required number above 0 (or within min..max). */
  const number = (field: string, range?: { min: number; max: number; int?: boolean }): number | null => {
    const v = b[field];
    if (v === undefined || v === null || v === '') return bad(field, 'FIELD_REQUIRED', field), null;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '').trim()) : NaN;
    if (!Number.isFinite(n)) return bad(field, 'FIELD_NOT_NUMBER', field), null;
    if (range ? n < range.min || n > range.max : n <= 0) return range ? bad(field, 'FIELD_OUT_OF_RANGE', field, range.min, range.max) : bad(field, 'FIELD_NOT_POSITIVE', field), null;
    if (range?.int && !Number.isInteger(n)) return bad(field, 'FIELD_NOT_INT_RANGE', field, range.min, range.max), null;
    return n;
  };
  const oneOf = (field: string, allowed: readonly string[]): string | null => {
    const s = text(field);
    if (s === null) return null;
    const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
    return hit ?? (bad(field, 'FIELD_NOT_ONE_OF', field, allowed.join(', ')), null);
  };
  const bool = (field: string): boolean | null => {
    const v = b[field];
    if (typeof v === 'boolean') return v;
    return bad(field, 'FIELD_REQUIRED', field), null;
  };
  /** Required list of texts (at least one). */
  const list = (field: string): string[] | null => {
    const v = b[field];
    const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
    if (!items) return bad(field, 'FIELD_REQUIRED', field), null;
    const out = [...new Set(items.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!out.length) return bad(field, 'FIELD_REQUIRED', field), null;
    if (out.some((x) => x.length > MASTER_ADD.TEXT_MAX)) return bad(field, 'FIELD_TOO_LONG', field, MASTER_ADD.TEXT_MAX), null;
    return out;
  };
  const done = () => {
    if (problems.length) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails(problems);
  };
  return { bad, has, text, format, number, oneOf, bool, list, done };
};

const audit = (m: EntityManager, by: Actor, what: string) =>
  m.getRepository(ActivityLog).insert({ userId: by.id, method: 'AUDIT', path: what.slice(0, 255), status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS) });

/** Re-check the channel's POs in review after a mapping was added (background; failures only logged). */
const recheckChannel = (channel: string) =>
  void runJob('recheck', () => recheckInReview({ channels: [channel], trigger: REVIEW_RECHECK.TRIGGER.MASTER_ADD }), { channel }).catch(() => undefined);

const one = async <T>(m: EntityManager, sql: string, p: unknown[]): Promise<T | undefined> => ((await m.query(sql, p)) as T[])[0];

// ---- dropdowns -----------------------------------------------------------------------------------------------------

/** What the four forms pick from: channels, active facilities, PEP SKUs (for the channel SKU form), fixed lists. */
export const formOptions = async () => {
  const [channels, facilities, skus, types] = await Promise.all([
    AppDataSource.query(`SELECT id, display_name name, is_active active FROM ${TABLES.MASTER_CHANNELS} ORDER BY display_name`) as Promise<{ id: number; name: string; active: number }[]>,
    AppDataSource.query(`SELECT code, name FROM ${TABLES.MASTER_FACILITIES} WHERE is_active = 1 ORDER BY code`) as Promise<{ code: string; name: string | null }[]>,
    AppDataSource.query(`SELECT pep_code code, product_name name, brand_name brand, mrp, ean_code ean FROM ${TABLES.MASTER_SKUS} ORDER BY pep_code`) as Promise<{ code: string; name: string | null; brand: string | null; mrp: string | null; ean: string | null }[]>,
    AppDataSource.query(`SELECT DISTINCT product_type v FROM ${TABLES.MASTER_SKUS} WHERE product_type IS NOT NULL AND product_type <> '' ORDER BY 1`) as Promise<{ v: string }[]>,
  ]);
  return {
    channels: channels.map((c) => ({ id: Number(c.id), name: c.name, active: !!Number(c.active) })),
    facilities,
    pepSkus: skus.map((s) => ({ ...s, mrp: s.mrp === null ? null : Number(s.mrp) })),
    productTypes: types.map((t) => t.v),
    gstRates: MASTER_ADD.GST_RATES,
    appointment: MASTER_ADD.APPOINTMENT,
    buyerTypes: MASTER_ADD.BUYER_TYPES,
    states: MASTER_ADD.STATES,
  };
};

// ---- PEP SKU (master_skus) -----------------------------------------------------------------------------------------

export const addPepSku = async (body: unknown, by: Actor) => {
  const c = checker(body);
  const v = {
    pepCode: c.text('pepCode'), productName: c.text('productName'), brand: c.text('brand'), productType: c.text('productType'),
    mrp: c.number('mrp'), gstTaxType: c.oneOf('gstTaxType', MASTER_ADD.GST_RATES), eanCode: c.format('eanCode', MASTER_ADD.EAN),
    hsnCode: c.format('hsnCode', MASTER_ADD.HSN), lengthMm: c.number('lengthMm'), widthMm: c.number('widthMm'), heightMm: c.number('heightMm'),
    weightG: c.number('weightG'), shelfLife: c.number('shelfLife', { min: 1, max: 3650, int: true }), isActive: c.bool('isActive'),
  };
  return AppDataSource.transaction(async (m) => {
    if (v.pepCode && (await one(m, `SELECT id FROM ${TABLES.MASTER_SKUS} WHERE LOWER(pep_code) = LOWER(?) LIMIT 1`, [v.pepCode]))) c.bad('pepCode', 'FIELD_ALREADY_EXISTS', 'pepCode', v.pepCode);
    c.done();
    const now = new Date();
    const r = await m.getRepository(MasterSku).insert({
      pepCode: v.pepCode!, productName: v.productName, brandName: v.brand, productType: v.productType, mrp: v.mrp, gstTaxType: v.gstTaxType,
      eanCode: v.eanCode, hsnCode: v.hsnCode, lengthMm: v.lengthMm, widthMm: v.widthMm, heightMm: v.heightMm,
      weightG: v.weightG, shelfLife: v.shelfLife, isActive: v.isActive, createdAt: now, updatedAt: now,
    });
    await audit(m, by, `masters: added PEP SKU ${v.pepCode}`);
    log.info(LOG_SOURCE.APP, `[masters] ${by.email} added PEP SKU ${v.pepCode}`);
    return { id: String(r.identifiers[0]?.id ?? ''), pepCode: v.pepCode };
  });
};

// ---- Channel SKU (master_channel_skus) -----------------------------------------------------------------------------

export const addChannelSku = async (body: unknown, by: Actor) => {
  const c = checker(body);
  const v = {
    channelId: c.number('channelId', { min: 1, max: 2_147_483_647, int: true }), channelCode: c.text('channelCode'), pepCode: c.text('pepCode'),
    productName: c.text('productName'), brand: c.text('brand'), mrp: c.number('mrp'), marginPercent: c.number('marginPercent', { min: 0, max: 100 }),
    rateAfterMargin: c.number('rateAfterMargin'), eanCode: c.format('eanCode', MASTER_ADD.EAN),
  };
  if (v.mrp !== null && v.rateAfterMargin !== null && v.rateAfterMargin > v.mrp) c.bad('rateAfterMargin', 'FIELD_OUT_OF_RANGE', 'rateAfterMargin', 0, v.mrp);
  const result = await AppDataSource.transaction(async (m) => {
    const channel = v.channelId ? await one<{ id: number; display_name: string }>(m, `SELECT id, display_name FROM ${TABLES.MASTER_CHANNELS} WHERE id = ?`, [v.channelId]) : undefined;
    if (v.channelId && !channel) c.bad('channelId', 'FIELD_NOT_FOUND', 'channelId', String(v.channelId));
    const sku = v.pepCode ? await one<{ id: number; pep_code: string }>(m, `SELECT id, pep_code FROM ${TABLES.MASTER_SKUS} WHERE LOWER(pep_code) = LOWER(?) LIMIT 1`, [v.pepCode]) : undefined;
    if (v.pepCode && !sku) c.bad('pepCode', 'FIELD_NOT_FOUND', 'pepCode', v.pepCode);
    if (channel && v.channelCode && (await one(m, `SELECT id FROM ${TABLES.MASTER_CHANNEL_SKUS} WHERE channel_id = ? AND LOWER(TRIM(channel_code)) = LOWER(?) LIMIT 1`, [channel.id, v.channelCode]))) {
      c.bad('channelCode', 'FIELD_ALREADY_EXISTS', 'channelCode', `${channel.display_name} ${v.channelCode}`);
    }
    c.done();
    const r = await m.getRepository(MasterChannelSku).insert({
      pepCode: sku!.pep_code, pepSkuId: Number(sku!.id), channelId: channel!.id, channelName: channel!.display_name, channelCode: v.channelCode,
      productName: v.productName, brandName: v.brand, mrp: v.mrp, margin: Math.round((v.marginPercent! / 100) * 10000) / 10000,
      rateAfterMargin: v.rateAfterMargin, eanCode: v.eanCode,
    });
    await audit(m, by, `masters: added channel SKU ${channel!.display_name} ${v.channelCode} -> ${sku!.pep_code}`);
    log.info(LOG_SOURCE.APP, `[masters] ${by.email} mapped ${channel!.display_name} ${v.channelCode} -> ${sku!.pep_code}`);
    return { id: String(r.identifiers[0]?.id ?? ''), channel: channel!.display_name };
  });
  recheckChannel(result.channel);
  return result;
};

// ---- Channel (master_channels) -------------------------------------------------------------------------------------

export const addChannel = async (body: unknown, by: Actor) => {
  const c = checker(body);
  const v = { displayName: c.text('displayName'), slug: c.format('slug', MASTER_ADD.SLUG), aliases: c.list('aliases'), isActive: c.bool('isActive') };
  return AppDataSource.transaction(async (m) => {
    const all = (await m.query(`SELECT id, slug, display_name, db_aliases FROM ${TABLES.MASTER_CHANNELS}`)) as { id: number; slug: string; display_name: string; db_aliases: string[] | string | null }[];
    const lc = (s: string) => s.trim().toLowerCase();
    const taken = new Map<string, string>();
    for (const ch of all) {
      const aliases = Array.isArray(ch.db_aliases) ? ch.db_aliases : ch.db_aliases ? (JSON.parse(ch.db_aliases) as string[]) : [];
      for (const n of [ch.display_name, ch.slug, ...aliases]) taken.set(lc(n), ch.display_name);
    }
    if (v.displayName && all.some((ch) => lc(ch.display_name) === lc(v.displayName!))) c.bad('displayName', 'FIELD_ALREADY_EXISTS', 'displayName', v.displayName);
    if (v.slug && all.some((ch) => lc(ch.slug) === lc(v.slug!))) c.bad('slug', 'FIELD_ALREADY_EXISTS', 'slug', v.slug);
    // another channel's name / alias would make PO intake pick the wrong channel
    const clash = (v.aliases ?? []).find((a) => taken.has(lc(a)));
    if (clash) c.bad('aliases', 'FIELD_ALREADY_EXISTS', 'aliases', `${clash} (used by ${taken.get(lc(clash))})`);
    c.done();
    const r = await m.getRepository(MasterChannel).insert({ displayName: v.displayName!, slug: v.slug!, dbAliases: v.aliases!, hasProcessor: false, isActive: v.isActive! });
    await audit(m, by, `masters: added channel ${v.displayName} (${v.slug})`);
    log.info(LOG_SOURCE.APP, `[masters] ${by.email} added channel ${v.displayName}`);
    return { id: Number(r.identifiers[0]?.id ?? 0), displayName: v.displayName };
  });
};

// ---- Channel location (details_channels) ---------------------------------------------------------------------------

export const addChannelLocation = async (body: unknown, by: Actor) => {
  const c = checker(body);
  const v = {
    channelId: c.number('channelId', { min: 1, max: 2_147_483_647, int: true }), locationCode: c.text('locationCode'),
    uniwareCustomerCode: c.text('uniwareCustomerCode'), uniwareChannelCode: c.text('uniwareChannelCode'), facilityCode: c.text('facilityCode'),
    consigneeName: c.text('consigneeName'), consigneeGstNumber: c.format('consigneeGstNumber', MASTER_ADD.GSTIN, true),
    consigneeState: c.oneOf('consigneeState', MASTER_ADD.STATES), consigneePinCode: c.format('consigneePinCode', MASTER_ADD.PIN),
    shippingAddress: c.text('shippingAddress', MASTER_ADD.ADDRESS_MAX), billingAddress: c.text('billingAddress', MASTER_ADD.ADDRESS_MAX),
    buyerType: c.oneOf('buyerType', MASTER_ADD.BUYER_TYPES), buyerGstNumber: c.format('buyerGstNumber', MASTER_ADD.GSTIN, true), buyerState: c.oneOf('buyerState', MASTER_ADD.STATES),
    buyerPinCode: c.format('buyerPinCode', MASTER_ADD.PIN), tallyLedgerName: c.text('tallyLedgerName'), appointmentChannel: c.oneOf('appointmentChannel', MASTER_ADD.APPOINTMENT),
  };
  const result = await AppDataSource.transaction(async (m) => {
    const channel = v.channelId ? await one<{ id: number; display_name: string }>(m, `SELECT id, display_name FROM ${TABLES.MASTER_CHANNELS} WHERE id = ?`, [v.channelId]) : undefined;
    if (v.channelId && !channel) c.bad('channelId', 'FIELD_NOT_FOUND', 'channelId', String(v.channelId));
    // facility codes are exact (upper / lower case = main / child warehouse)
    const facility = v.facilityCode ? await one<{ id: number; code: string }>(m, `SELECT id, code FROM ${TABLES.MASTER_FACILITIES} WHERE code = ? AND is_active = 1`, [v.facilityCode]) : undefined;
    if (v.facilityCode && !facility) c.bad('facilityCode', 'FIELD_NOT_FOUND', 'facilityCode', v.facilityCode);
    if (channel && v.locationCode && (await one(m, `SELECT id FROM ${TABLES.DETAILS_CHANNELS} WHERE channel_id = ? AND LOWER(TRIM(channel_location_code)) = LOWER(?) LIMIT 1`, [channel.id, v.locationCode]))) {
      c.bad('locationCode', 'FIELD_ALREADY_EXISTS', 'locationCode', `${channel.display_name} ${v.locationCode}`);
    }
    c.done();
    const now = new Date();
    const r = await m.getRepository(DetailsChannel).insert({
      channelId: channel!.id, channelName: channel!.display_name, channelLocationCode: v.locationCode, uniwareCustomerCode: v.uniwareCustomerCode,
      channelCode: v.uniwareChannelCode, facilityCode: facility!.code, facilityId: facility!.id, consigneeName: v.consigneeName,
      consigneeGstNumber: v.consigneeGstNumber, consigneeState: v.consigneeState, consigneePinCode: v.consigneePinCode,
      finalShippingAddress: v.shippingAddress, finalBillingAddress: v.billingAddress, buyerType: v.buyerType, buyerGstNumber: v.buyerGstNumber,
      buyerState: v.buyerState, buyerPinCode: v.buyerPinCode, tallyLedgerName: v.tallyLedgerName, appointmentChannel: v.appointmentChannel,
      isActive: true, createdAt: now, updatedAt: now,
    });
    await audit(m, by, `masters: added location ${channel!.display_name} ${v.locationCode} (${facility!.code})`);
    log.info(LOG_SOURCE.APP, `[masters] ${by.email} added location ${channel!.display_name} ${v.locationCode}`);
    return { id: String(r.identifiers[0]?.id ?? ''), channel: channel!.display_name };
  });
  recheckChannel(result.channel);
  return result;
};
