import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, MASTER_ADD, MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE, MasterLogType, REVIEW_RECHECK, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { appError } from '../../utils/AppError';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { recheckInReview } from '../po-review/recheck.service';
import { Actor, checker } from './master-add.service';
import { isMasterLogType } from './master-history.service';
import { logMasterChanges } from './master-log';
import { forgetPoIssues } from '../po-issues/po-issues.cache';

/*
 * Edit and switch on / off on the Masters pages (user, 2026-10-28; step 3 of the masters change log):
 *   - admin / developer only (the route checks the role);
 *   - KEYS ARE LOCKED (PEP code, channel + channel SKU code, channel name / slug, channel + location code, facility
 *     code): changing one would silently change which POs match; a wrong key = switch the row off + add a new one;
 *   - only the fields sent in `changes` are checked (same rules as the Add forms: required, format, range, what they
 *     point to exists) and every problem comes back at once (400 VALIDATION_FAILED);
 *   - conflict check: `original` = the values the person saw; a field changed by someone else meanwhile -> 409
 *     MASTER_EDIT_CONFLICT with { field, now } per field, nothing saved;
 *   - one transaction: the UPDATE + one master_change_logs row per changed field (optional remark); nothing is ever
 *     deleted (switch off instead);
 *   - afterwards the POs in review are re-checked in the background (that channel, or all for a PEP SKU / warehouse).
 * Switched-off rows are skipped by the PO checks (master-data.ts / validate-po.ts).
 */

type Value = string | number | null;
type Checker = ReturnType<typeof checker>;
type Row = Record<string, unknown>;

interface FieldSpec {
  /** The DB column. */
  col: string;
  /** Checks the sent value (null = a problem was recorded). */
  check: (c: Checker, key: string) => unknown;
  /** DB value -> the form's value (default: as stored). */
  read?: (v: unknown) => Value;
  /** Checked value -> DB value (default: as checked). */
  write?: (v: unknown) => unknown;
}

interface MasterSpec {
  table: string;
  /** Columns that identify the row (locked) and are read for its key / channel. */
  keyCols: string[];
  /** Form keys that are keys: refused with FIELD_LOCKED. */
  locked: string[];
  fields: Record<string, FieldSpec>;
  hasUpdatedAt: boolean;
  /** What the row is to people (master_change_logs.row_key). */
  rowKey: (r: Row) => string;
}

const text = (max?: number): FieldSpec['check'] => (c, k) => c.text(k, max);
const num: FieldSpec['check'] = (c, k) => c.number(k);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const aliasesOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? (JSON.parse(v) as string[]) : []);

const col = (c: string, check: FieldSpec['check'], more: Partial<FieldSpec> = {}): FieldSpec => ({ col: c, check, ...more });

const SPECS: Record<MasterLogType, MasterSpec> = {
  [MASTER_LOG_TYPE.PEP_SKU]: {
    table: TABLES.MASTER_SKUS, keyCols: ['pep_code'], locked: ['pepCode'], hasUpdatedAt: true, rowKey: (r) => String(r.pep_code),
    fields: {
      productName: col('product_name', text()), brand: col('brand_name', text()), productType: col('product_type', text()),
      mrp: col('mrp', num), gstTaxType: col('gst_tax_type', (c, k) => c.oneOf(k, MASTER_ADD.GST_RATES)),
      eanCode: col('ean_code', (c, k) => c.format(k, MASTER_ADD.EAN)), hsnCode: col('hsn_code', (c, k) => c.format(k, MASTER_ADD.HSN)),
      lengthMm: col('length_mm', num), widthMm: col('width_mm', num), heightMm: col('height_mm', num), weightG: col('weight_g', num),
      shelfLife: col('shelf_life', (c, k) => c.number(k, { min: 1, max: 3650, int: true })),
    },
  },
  [MASTER_LOG_TYPE.CHANNEL_SKU]: {
    table: TABLES.MASTER_CHANNEL_SKUS, keyCols: ['channel_id', 'channel_name', 'channel_code'], locked: ['channelId', 'channelCode'], hasUpdatedAt: false,
    rowKey: (r) => `${r.channel_name ?? ''} | ${r.channel_code ?? ''}`,
    fields: {
      pepCode: col('pep_code', text()), productName: col('product_name', text()), brand: col('brand_name', text()), mrp: col('mrp', num),
      // stored as a fraction of MRP (0.27), edited as a percent (27)
      marginPercent: col('margin', (c, k) => c.number(k, { min: 0, max: 100 }), {
        read: (v) => (v === null || v === undefined ? null : round(Number(v) * 100, 2)), write: (v) => round(Number(v) / 100, 4),
      }),
      rateAfterMargin: col('rate_after_margin', num), eanCode: col('ean_code', (c, k) => c.format(k, MASTER_ADD.EAN)),
    },
  },
  [MASTER_LOG_TYPE.CHANNEL]: {
    table: TABLES.MASTER_CHANNELS, keyCols: ['display_name', 'slug'], locked: ['displayName', 'slug'], hasUpdatedAt: false, rowKey: (r) => String(r.display_name),
    fields: {
      aliases: col('db_aliases', (c, k) => c.list(k), { read: (v) => aliasesOf(v).join(', '), write: (v) => JSON.stringify(v) }),
      channelType: col('channel_type', (c, k) => c.oneOf(k, MASTER_ADD.CHANNEL_TYPES)),
      expiryDaysMin: col('expiry_days_min', (c, k) => c.number(k, { ...MASTER_ADD.EXPIRY_DAYS, int: true })),
      expiryDaysMax: col('expiry_days_max', (c, k) => c.number(k, { ...MASTER_ADD.EXPIRY_DAYS, int: true })),
    },
  },
  [MASTER_LOG_TYPE.LOCATION]: {
    table: TABLES.DETAILS_CHANNELS, keyCols: ['channel_id', 'channel_name', 'channel_location_code'], locked: ['channelId', 'locationCode'], hasUpdatedAt: true,
    rowKey: (r) => `${r.channel_name ?? ''} | ${r.channel_location_code ?? ''}`,
    fields: {
      uniwareCustomerCode: col('uniware_customer_code', text()), uniwareChannelCode: col('channel_code', text()), facilityCode: col('facility_code', text()),
      consigneeName: col('consignee_name', text()), consigneeGstNumber: col('consignee_gst_number', (c, k) => c.format(k, MASTER_ADD.GSTIN, true)),
      consigneeState: col('consignee_state', (c, k) => c.oneOf(k, MASTER_ADD.STATES)), consigneePinCode: col('consignee_pin_code', (c, k) => c.format(k, MASTER_ADD.PIN)),
      shippingAddress: col('final_shipping_address', text(MASTER_ADD.ADDRESS_MAX)), billingAddress: col('final_billing_address', text(MASTER_ADD.ADDRESS_MAX)),
      buyerType: col('buyer_type', (c, k) => c.oneOf(k, MASTER_ADD.BUYER_TYPES)), buyerGstNumber: col('buyer_gst_number', (c, k) => c.format(k, MASTER_ADD.GSTIN, true)),
      buyerState: col('buyer_state', (c, k) => c.oneOf(k, MASTER_ADD.STATES)), buyerPinCode: col('buyer_pin_code', (c, k) => c.format(k, MASTER_ADD.PIN)),
      tallyLedgerName: col('tally_ledger_name', text()), appointmentChannel: col('appointment_channel', (c, k) => c.oneOf(k, MASTER_ADD.APPOINTMENT)),
      city: col('city', text()),
    },
  },
  [MASTER_LOG_TYPE.FACILITY]: {
    table: TABLES.MASTER_FACILITIES, keyCols: ['code'], locked: ['code', 'facilityCode'], hasUpdatedAt: true, rowKey: (r) => String(r.code),
    fields: {
      name: col('name', text()), entity: col('entity', text()), pickupLocation: col('pickup_location', text()), state: col('state', text()),
      facilityType: col('facility_type', text()), billToGstin: col('bill_to_gstin', (c, k) => c.format(k, MASTER_ADD.GSTIN, true)),
      shipToGstin: col('ship_to_gstin', (c, k) => c.format(k, MASTER_ADD.GSTIN, true)), remarks: col('remarks', text(MASTER_ADD.REMARK_MAX)),
    },
  },
};

const typeOf = (t: unknown): MasterLogType => {
  if (!isMasterLogType(t)) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'type', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `type must be one of ${Object.values(MASTER_LOG_TYPE).join(', ')}` }]);
  return t;
};
const idOf = (raw: unknown): string => {
  const id = String(raw ?? '');
  if (!/^[1-9]\d{0,18}$/.test(id)) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'id', code: ERROR_CODES.FIELD_NOT_NUMBER, message: 'id must be a row id' }]);
  return id;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Two values the same as the form shows them (numbers by value, text trimmed, empty = empty). */
const same = (a: unknown, b: unknown): boolean => {
  const s = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v).trim());
  if (s(a) === '' || s(b) === '') return s(a) === s(b);
  const na = Number(String(a).replace(/,/g, '')), nb = Number(String(b).replace(/,/g, ''));
  return Number.isFinite(na) && Number.isFinite(nb) ? Math.abs(na - nb) < 1e-9 : s(a) === s(b);
};

/** The row FOR UPDATE (locked until the transaction ends), only the columns needed. */
const lockRow = async (m: EntityManager, spec: MasterSpec, type: MasterLogType, id: string): Promise<Row> => {
  const cols = [...new Set(['id', 'is_active', ...spec.keyCols, ...Object.values(spec.fields).map((f) => f.col)])];
  const [row] = (await m.query(`SELECT ${cols.map((c) => `\`${c}\``).join(', ')} FROM \`${spec.table}\` WHERE id = ? FOR UPDATE`, [id])) as Row[];
  if (!row) throw appError(ERROR_CODES.MASTER_ROW_NOT_FOUND, type, id);
  return row;
};

/** The channel(s) whose POs in review are re-checked after a change; null = every channel. */
const channelsToRecheck = async (m: EntityManager, type: MasterLogType, row: Row): Promise<string[] | null> => {
  if (type === MASTER_LOG_TYPE.PEP_SKU || type === MASTER_LOG_TYPE.FACILITY) return null;
  if (type === MASTER_LOG_TYPE.CHANNEL) return [String(row.display_name)];
  const [c] = (await m.query(`SELECT display_name FROM ${TABLES.MASTER_CHANNELS} WHERE id = ?`, [row.channel_id])) as { display_name: string }[];
  return [c?.display_name ?? String(row.channel_name ?? '')].filter(Boolean);
};
const recheck = (channels: string[] | null) =>
  void runJob('recheck', () => recheckInReview({ ...(channels ? { channels } : {}), trigger: REVIEW_RECHECK.TRIGGER.MASTER_EDIT }), { channels: channels?.join(', ') ?? 'all' })
    .catch(() => undefined);

/** Extra checks that need the row or other rows (problems added to `c`). */
const crossChecks = async (m: EntityManager, type: MasterLogType, row: Row, next: Record<string, unknown>, c: Checker, set: Record<string, unknown>) => {
  const after = (k: string, colName: string) => (k in next ? next[k] : row[colName]);
  if (type === MASTER_LOG_TYPE.CHANNEL_SKU) {
    if ('pepCode' in next && next.pepCode) {
      const [sku] = (await m.query(`SELECT id, pep_code FROM ${TABLES.MASTER_SKUS} WHERE LOWER(pep_code) = LOWER(?) LIMIT 1`, [next.pepCode])) as { id: number; pep_code: string }[];
      if (!sku) c.bad('pepCode', 'FIELD_NOT_FOUND', 'pepCode', String(next.pepCode));
      else Object.assign(set, { pep_code: sku.pep_code, pep_sku_id: Number(sku.id) });
    }
    const mrp = Number(after('mrp', 'mrp')), rate = Number(after('rateAfterMargin', 'rate_after_margin'));
    if (('mrp' in next || 'rateAfterMargin' in next) && Number.isFinite(mrp) && Number.isFinite(rate) && rate > mrp) c.bad('rateAfterMargin', 'FIELD_OUT_OF_RANGE', 'rateAfterMargin', 0, mrp);
  }
  if (type === MASTER_LOG_TYPE.CHANNEL) {
    const min = after('expiryDaysMin', 'expiry_days_min'), max = after('expiryDaysMax', 'expiry_days_max');
    if (('expiryDaysMin' in next || 'expiryDaysMax' in next) && min !== null && max !== null && Number(min) > Number(max)) c.bad('expiryDaysMin', 'FIELD_RANGE_REVERSED', 'expiryDaysMin', 'expiryDaysMax');
    if (Array.isArray(next.aliases)) {
      // another channel's name / alias would make PO intake pick the wrong channel
      const others = (await m.query(`SELECT display_name, slug, db_aliases FROM ${TABLES.MASTER_CHANNELS} WHERE id <> ?`, [row.id])) as Row[];
      const taken = new Map<string, string>();
      for (const o of others) for (const n of [o.display_name, o.slug, ...aliasesOf(o.db_aliases)]) taken.set(String(n).trim().toLowerCase(), String(o.display_name));
      const clash = (next.aliases as string[]).find((a) => taken.has(a.trim().toLowerCase()));
      if (clash) c.bad('aliases', 'FIELD_ALREADY_EXISTS', 'aliases', `${clash} (used by ${taken.get(clash.trim().toLowerCase())})`);
    }
  }
  if (type === MASTER_LOG_TYPE.LOCATION && 'facilityCode' in next && next.facilityCode) {
    // exact code (upper / lower case = main / child warehouse), active only
    const [f] = (await m.query(`SELECT id, code FROM ${TABLES.MASTER_FACILITIES} WHERE code = ? AND is_active = 1`, [next.facilityCode])) as { id: number; code: string }[];
    if (!f) c.bad('facilityCode', 'FIELD_NOT_FOUND', 'facilityCode', String(next.facilityCode));
    else Object.assign(set, { facility_code: f.code, facility_id: f.id });
  }
};

/**
 * PATCH /masters/edit/:type/:id { changes: { field: value }, original: { field: value seen }, remark? }
 * -> { changed: string[] } (form keys actually changed; [] = nothing was different).
 */
export const editRow = async (rawType: unknown, rawId: unknown, body: unknown, by: Actor) => {
  const type = typeOf(rawType);
  const id = idOf(rawId);
  const spec = SPECS[type];
  const b = obj(body);
  const changes = obj(b.changes);
  const original = obj(b.original);
  const c = checker({ ...changes, remark: b.remark });
  const remark = c.remark();

  const keys = Object.keys(changes);
  if (!keys.length) c.bad('changes', 'FIELD_REQUIRED', 'changes');
  for (const k of keys) {
    if (spec.locked.includes(k)) c.bad(k, 'FIELD_LOCKED', k);
    else if (!spec.fields[k]) c.bad(k, 'FIELD_NOT_EDITABLE', k);
  }
  // the same rules as the Add forms, for the fields sent only
  const next: Record<string, unknown> = {};
  for (const k of keys.filter((k) => spec.fields[k])) next[k] = spec.fields[k].check(c, k);

  const result = await AppDataSource.transaction(async (m) => {
    const row = await lockRow(m, spec, type, id);
    const set: Record<string, unknown> = {};
    await crossChecks(m, type, row, next, c, set);
    c.done();

    const shown = (k: string) => (spec.fields[k].read ?? ((v: unknown) => v as Value))(row[spec.fields[k].col]);
    // someone else changed a field this person is changing -> refuse, tell what it is now
    const conflicts = keys.filter((k) => k in original && !same(original[k], shown(k))).map((k) => ({ field: k, now: shown(k) }));
    if (conflicts.length) throw appError(ERROR_CODES.MASTER_EDIT_CONFLICT).withDetails(conflicts);

    const changed = keys.filter((k) => !same(next[k], shown(k)));
    if (!changed.length) return { changed: [] as string[], channels: null as string[] | null };
    for (const k of changed) {
      const f = spec.fields[k];
      if (!(f.col in set)) set[f.col] = (f.write ?? ((v: unknown) => v))(next[k]);
    }
    if (spec.hasUpdatedAt) set.updated_at = new Date();
    const cols = Object.keys(set);
    await m.query(`UPDATE \`${spec.table}\` SET ${cols.map((x) => `\`${x}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((x) => set[x]), id]);
    await logMasterChanges(m, changed.map((k) => ({
      type, recordId: id, rowKey: spec.rowKey(row), action: MASTER_LOG_ACTION.FIELD_CHANGED, field: k, oldValue: shown(k), newValue: next[k],
    })), by, MASTER_LOG_SOURCE.SCREEN, remark);
    log.info(LOG_SOURCE.APP, `[masters] ${by.email} edited ${type} ${spec.rowKey(row)}: ${changed.join(', ')}`);
    return { changed, channels: await channelsToRecheck(m, type, row) };
  });
  if (result.changed.length) {
    forgetPoIssues(); // "still a problem?" may change at once (2026-10-29)
    recheck(result.channels);
  }
  return { changed: result.changed };
};

/** POST /masters/active/:type/:id { active: boolean, remark? } -> { active, changed } (false = it already was). */
export const setActive = async (rawType: unknown, rawId: unknown, body: unknown, by: Actor) => {
  const type = typeOf(rawType);
  const id = idOf(rawId);
  const spec = SPECS[type];
  const b = obj(body);
  const c = checker(b);
  const active = c.bool('active');
  const remark = c.remark();
  c.done();

  const result = await AppDataSource.transaction(async (m) => {
    const row = await lockRow(m, spec, type, id);
    // master_skus.is_active NULL counts as active (as the lists show it)
    const was = row.is_active === null || row.is_active === undefined ? true : !!Number(row.is_active);
    if (was === active) return { changed: false, channels: null as string[] | null };
    await m.query(`UPDATE \`${spec.table}\` SET is_active = ?${spec.hasUpdatedAt ? ', updated_at = ?' : ''} WHERE id = ?`, [active, ...(spec.hasUpdatedAt ? [new Date()] : []), id]);
    await logMasterChanges(m, [{
      type, recordId: id, rowKey: spec.rowKey(row), action: active ? MASTER_LOG_ACTION.ACTIVATED : MASTER_LOG_ACTION.DEACTIVATED,
      field: 'is_active', oldValue: was ? 'Active' : 'Inactive', newValue: active ? 'Active' : 'Inactive',
    }], by, MASTER_LOG_SOURCE.SCREEN, remark);
    log.info(LOG_SOURCE.APP, `[masters] ${by.email} switched ${type} ${spec.rowKey(row)} ${active ? 'ON' : 'OFF'}`);
    return { changed: true, channels: await channelsToRecheck(m, type, row) };
  });
  if (result.changed) forgetPoIssues();
  // switched on: POs waiting on this row may pass now (switching off only affects new POs)
  if (result.changed && active) recheck(result.channels);
  return { active, changed: result.changed };
};

/** Editable form keys per master (the frontend's Edit form uses the same keys as the Add form). */
export const editableFields = (): Record<MasterLogType, { locked: string[]; fields: string[] }> =>
  Object.fromEntries(Object.entries(SPECS).map(([t, s]) => [t, { locked: s.locked, fields: Object.keys(s.fields) }])) as Record<MasterLogType, { locked: string[]; fields: string[] }>;

