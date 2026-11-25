import path from 'path';
import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  D2C_ALLOW, D2C_UNIWARE_CODE_MAX, ERROR_CODES, MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE, ROUTE_UPLOAD, ROUTE_UPLOAD_COLUMN,
  ROUTE_UPLOAD_COLUMNS, ROUTE_UPLOAD_REQUIRED, TABLES,
} from '../../constants';
import { appError } from '../../utils/AppError';
import { csvCell, csvRecords } from '../../utils/csv';
import { log } from '../../utils/logger';
import { LOG_SOURCE } from '../../constants/logging';
import { readSettings } from '../d2c-transfers/settings';
import { isTestLane, laneText, testCodesOf } from '../d2c-transfers/test-mode';
import { Channel, Facility, findChannel, matchFacility } from './d2c-routes-load';
import { Actor } from './master-add.service';
import { editRowIn, setActiveIn } from './master-edit.service';
import { addedWith, logMasterChanges } from './master-log';

/*
 * Masters -> Transfer Routes -> Upload CSV (2026-11-25; was a placeholder window that downloaded every row as the
 * "template" and saved nothing). User's rules:
 *   - a row is one route, found by Sender + Channel + Location + Uniware Channel; else, when the file has ONE row for a
 *     Sender + Location and the DB ONE route left there, that route (its Uniware channel changes; as npm run
 *     d2c:routes-load); else a NEW route;
 *   - an empty cell keeps the current value (clearing a code = Edit on the row); Active Yes / No, empty = keep (new = Yes);
 *   - a new route needs its Channel + Location set up as a transfer location (receiving warehouse) first: refused otherwise;
 *   - a new route's sender / receiving warehouse not allowed internal transfers is switched on (logged as a Warehouses edit).
 * Preview checks every row; import re-checks inside its transaction and saves all or nothing. Every change goes
 * through the masters edit (same checks, test-only rule, History) or, for a new route, is logged as "created".
 */

export interface UploadFile { originalname: string; buffer: Buffer }

export interface RouteUploadRow {
  row: number; sender: string; channel: string; location: string; uniwareChannel: string;
  customerCode: string; customerName: string; vendorCode: string; active: string;
}

type Field = 'uniwareChannelCode' | 'customerCode' | 'customerName' | 'vendorCode';
const FIELDS: [Field, keyof RouteUploadRow, number][] = [
  ['uniwareChannelCode', 'uniwareChannel', D2C_UNIWARE_CODE_MAX], ['customerCode', 'customerCode', D2C_UNIWARE_CODE_MAX],
  ['customerName', 'customerName', ROUTE_UPLOAD.CUSTOMER_NAME_MAX], ['vendorCode', 'vendorCode', D2C_UNIWARE_CODE_MAX],
];

export interface RouteChange { field: Field | 'isActive'; old: string | null; value: string | null }
export interface RoutePlanRow {
  row: number; sender: string; channel: string; location: string; uniwareChannel: string; receiving: string | null;
  action: 'new' | 'update' | 'same' | 'error';
  routeId: number | null;
  changes: RouteChange[];
  errors: string[];
  warnings: string[];
}

/** What the plan needs from the DB. */
export interface UploadMasters {
  facilities: (Facility & { allowInternalTransfer: boolean })[];
  channels: Channel[];
  /** details_channels rows that have a location code. */
  locations: { id: string; channelId: number; channelName: string; locationCode: string; receivingId: number | null; receivingCode: string | null; isActive: boolean }[];
  routes: { id: number; senderId: number; locationId: string; uniwareChannelCode: string | null; customerCode: string | null; customerName: string | null; vendorCode: string | null; isActive: boolean }[];
  /** Local test-only mode: only routes between these facilities (null = off). */
  testFacilities: string[] | null;
}

export interface UploadPlan {
  rows: RoutePlanRow[];
  /** Facilities to switch on for internal transfers (a new / switched-on route sends or receives). */
  enable: { id: number; code: string }[];
  /** Per row: the DB ids the import writes (internal). */
  work: Map<number, { senderId: number; locationId: string; receivingId: number }>;
}

const lc = (s: string) => s.trim().toLowerCase();
const channelKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMN_BY_NORM = new Map(ROUTE_UPLOAD_COLUMNS.map((c) => [norm(c), c]));
const YES = ['yes', 'y', 'active', 'true', '1'];
const NO = ['no', 'n', 'inactive', 'false', '0'];
const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/** The template: the header and, as the example, one real route with its current values (uploading it unchanged = no change). */
export const routesTemplateCsv = async (): Promise<string> => {
  const [r] = await AppDataSource.query<{ sender: string; channel: string; location: string; uw: string | null; cc: string | null; cn: string | null; vc: string | null; active: number }[]>(
    `SELECT f.code sender, d.channel_name channel, d.channel_location_code location, r.uniware_channel_code uw, r.customer_code cc, r.customer_name cn,
            r.vendor_code vc, r.is_active active
       FROM ${TABLES.D2C_TRANSFER_ROUTES} r JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = r.dispatch_facility_id JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = r.location_id
      WHERE r.is_active = 1 AND r.vendor_code IS NOT NULL AND r.customer_code IS NOT NULL ORDER BY r.id LIMIT 1`,
  );
  const lines = [ROUTE_UPLOAD_COLUMNS.map(csvCell).join(',')];
  if (r) lines.push([r.sender, r.channel, r.location, r.uw, r.cc, r.cn, r.vc, Number(r.active) ? 'Yes' : 'No'].map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
};

/** The file's rows (row = line in the file, header = 1). Refuses a non-CSV, an empty / too big file, missing columns. */
export const parseRoutesUpload = (file: UploadFile | undefined): RouteUploadRow[] => {
  if (!file) throw appError(ERROR_CODES.ROUTE_UPLOAD_FILE, 'send the .csv file in the "file" field');
  if (path.extname(file.originalname || '').toLowerCase() !== '.csv') throw appError(ERROR_CODES.ROUTE_UPLOAD_FILE, `${file.originalname || 'the file'} is not a .csv file (save it as CSV)`);
  if (file.buffer.length > ROUTE_UPLOAD.MAX_BYTES) throw appError(ERROR_CODES.ROUTE_UPLOAD_FILE, `the file is over ${ROUTE_UPLOAD.MAX_BYTES / 1024 / 1024} MB`);
  const text = file.buffer.toString('utf8');
  // Excel saves "CSV UTF-8" with a byte-order mark
  const { header, records } = csvRecords(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const columns = new Map<string, string>();
  for (const h of header) {
    const c = COLUMN_BY_NORM.get(norm(h));
    if (c && !columns.has(c)) columns.set(c, h);
  }
  const missing = ROUTE_UPLOAD_REQUIRED.filter((c) => !columns.has(c));
  if (missing.length) throw appError(ERROR_CODES.ROUTE_UPLOAD_FILE, `missing column(s): ${missing.join(', ')} (download the template)`);
  if (!records.length) throw appError(ERROR_CODES.ROUTE_UPLOAD_FILE, 'the file has no rows');
  if (records.length > ROUTE_UPLOAD.MAX_ROWS) throw appError(ERROR_CODES.ROUTE_UPLOAD_FILE, `${records.length} rows: at most ${ROUTE_UPLOAD.MAX_ROWS} per file`);
  const C = ROUTE_UPLOAD_COLUMN;
  const cell = (r: Record<string, string>, c: string) => {
    const h = columns.get(c);
    return h === undefined ? '' : (r[h] ?? '').trim();
  };
  return records.map((r, i) => ({
    row: i + 2, sender: cell(r, C.SENDER), channel: cell(r, C.CHANNEL), location: cell(r, C.LOCATION), uniwareChannel: cell(r, C.UNIWARE_CHANNEL),
    customerCode: cell(r, C.CUSTOMER_CODE), customerName: cell(r, C.CUSTOMER_NAME), vendorCode: cell(r, C.VENDOR_CODE), active: cell(r, C.ACTIVE),
  }));
};

/** Every row checked and matched against the DB routes (pure). */
export const planRoutesUpload = (rows: readonly RouteUploadRow[], m: UploadMasters): UploadPlan => {
  const work = new Map<number, { senderId: number; locationId: string; receivingId: number }>();
  const active = m.facilities;
  const out: RoutePlanRow[] = rows.map((r) => {
    const p: RoutePlanRow = {
      row: r.row, sender: r.sender, channel: r.channel, location: r.location, uniwareChannel: r.uniwareChannel, receiving: null,
      action: 'error', routeId: null, changes: [], errors: [], warnings: [],
    };
    if (!r.sender) p.errors.push('Sender is empty');
    if (!r.channel) p.errors.push('Channel is empty');
    if (!r.location) p.errors.push('Location is empty');
    for (const [field, key, max] of FIELDS) {
      if (String(r[key]).length > max) p.errors.push(`${field} is longer than ${max} characters`);
    }
    if (r.active && !YES.includes(lc(r.active)) && !NO.includes(lc(r.active))) p.errors.push(`Active must be Yes or No (not "${r.active}")`);
    if (p.errors.length) return p;
    const s = matchFacility(r.sender, active);
    if (!s.id) {
      p.errors.push(s.how === 'ambiguous' ? `Sender ${r.sender} matches ${s.candidates.join(' / ')}: write the exact code` : `Sender ${r.sender} is not an active warehouse`);
      return p;
    }
    p.sender = s.code;
    const ch = findChannel(r.channel, m.channels);
    const hits = m.locations.filter((l) => (channelKey(l.channelName) === channelKey(r.channel) || (ch && l.channelId === ch.id)) && lc(l.locationCode) === lc(r.location));
    const transfer = hits.filter((l) => l.receivingId !== null);
    if (!transfer.length) {
      p.errors.push(hits.length
        ? `${r.channel} / ${r.location} is not a transfer location yet: set its receiving warehouse and PO prefix in Channel Locations first`
        : `No location ${r.location} for channel ${r.channel}`);
      return p;
    }
    if (transfer.length > 1) {
      p.errors.push(`${r.channel} / ${r.location} matches ${transfer.length} transfer locations (ids ${transfer.map((l) => l.id).join(', ')}): fix the Channel Locations first`);
      return p;
    }
    const loc = transfer[0];
    p.channel = loc.channelName;
    p.location = loc.locationCode;
    p.receiving = loc.receivingCode;
    if (loc.receivingId === s.id) {
      p.errors.push(`Sender ${s.code} is also the receiving warehouse of ${loc.channelName} / ${loc.locationCode}`);
      return p;
    }
    if (m.testFacilities && !isTestLane({ testFacilities: m.testFacilities }, s.code, loc.receivingCode)) {
      p.errors.push(`Test mode on this server: only routes between test warehouses can change (${laneText(s.code, loc.receivingCode)})`);
      return p;
    }
    if (!loc.isActive) p.warnings.push(`${loc.channelName} / ${loc.locationCode} is switched off in Channel Locations`);
    work.set(r.row, { senderId: s.id, locationId: loc.id, receivingId: loc.receivingId as number });
    return p;
  });

  // the same route twice in the file
  const keyOf = (r: RouteUploadRow) => {
    const w = work.get(r.row);
    return w ? `${w.senderId}|${w.locationId}|${lc(r.uniwareChannel)}` : null;
  };
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r.row);
  }
  const plan = new Map(out.map((p) => [p.row, p]));
  for (const nums of byKey.values()) {
    if (nums.length < 2) continue;
    for (const n of nums) {
      plan.get(n)!.errors.push(`The same route is on rows ${nums.join(', ')}: keep one`);
      work.delete(n);
    }
  }

  // find the DB route: same key, else the only one left of the Sender + Location
  const used = new Set<number>();
  const found = new Map<number, UploadMasters['routes'][number]>();
  for (const r of rows) {
    const w = work.get(r.row);
    if (!w) continue;
    const e = m.routes.find((x) => !used.has(x.id) && x.senderId === w.senderId && x.locationId === w.locationId && lc(x.uniwareChannelCode ?? '') === lc(r.uniwareChannel));
    if (e) { used.add(e.id); found.set(r.row, e); }
  }
  const left = new Map<string, number[]>();
  for (const r of rows) {
    const w = work.get(r.row);
    if (!w || found.has(r.row)) continue;
    const k = `${w.senderId}|${w.locationId}`;
    (left.get(k) ?? left.set(k, []).get(k)!).push(r.row);
  }
  for (const [k, nums] of left) {
    const es = m.routes.filter((x) => !used.has(x.id) && `${x.senderId}|${x.locationId}` === k);
    if (nums.length === 1 && es.length === 1) { used.add(es[0].id); found.set(nums[0], es[0]); }
  }

  const enable = new Map<number, string>();
  const wantEnabled = (id: number) => {
    const f = m.facilities.find((x) => x.id === id);
    if (f && !f.allowInternalTransfer) enable.set(f.id, f.code);
  };
  for (const r of rows) {
    const p = plan.get(r.row)!;
    const w = work.get(r.row);
    if (!w || p.errors.length) continue;
    const e = found.get(r.row);
    const wantActive = r.active ? YES.includes(lc(r.active)) : null;
    if (!e) {
      p.action = 'new';
      for (const [field, key] of FIELDS) {
        const v = orNull(String(r[key]));
        if (v !== null) p.changes.push({ field, old: null, value: v });
      }
      if (wantActive === false) p.changes.push({ field: 'isActive', old: null, value: 'No' });
      if (!r.uniwareChannel) p.warnings.push('No Uniware channel: a sale order cannot be made on this route until it is set');
      if (!r.vendorCode) p.warnings.push('No vendor code: the inward PO cannot be made until it is set');
    } else {
      p.routeId = e.id;
      for (const [field, key] of FIELDS) {
        const v = orNull(String(r[key]));
        if (v === null || v === (e[field] ?? null)) continue; // empty cell keeps the current value
        p.changes.push({ field, old: e[field] ?? null, value: v });
      }
      if (wantActive !== null && wantActive !== e.isActive) p.changes.push({ field: 'isActive', old: e.isActive ? 'Yes' : 'No', value: wantActive ? 'Yes' : 'No' });
      p.action = p.changes.length ? 'update' : 'same';
    }
    const switchedOn = p.action === 'new' ? wantActive !== false : wantActive === true && !e?.isActive;
    if (switchedOn) { wantEnabled(w.senderId); wantEnabled(w.receivingId); }
  }
  for (const p of out) if (p.errors.length) p.action = 'error';
  return { rows: out, enable: [...enable].map(([id, code]) => ({ id, code })).sort((a, b) => (a.code < b.code ? -1 : 1)), work };
};

const aliasesOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? (JSON.parse(v) as string[]) : []);

const loadMasters = async (m: EntityManager): Promise<UploadMasters> => {
  const facilities = (await m.query<{ id: number; code: string; aliases: unknown; allow_internal_transfer: number }[]>(
    `SELECT id, code, aliases, allow_internal_transfer FROM ${TABLES.MASTER_FACILITIES} WHERE is_active = 1`,
  )).map((f) => ({ id: Number(f.id), code: f.code, aliases: aliasesOf(f.aliases), allowInternalTransfer: !!Number(f.allow_internal_transfer) }));
  const channels = (await m.query<{ id: number; display_name: string; slug: string; db_aliases: unknown }[]>(
    `SELECT id, display_name, slug, db_aliases FROM ${TABLES.MASTER_CHANNELS}`,
  )).map((c) => ({ id: Number(c.id), displayName: c.display_name, slug: c.slug, aliases: aliasesOf(c.db_aliases) }));
  const locations = (await m.query<{ id: string | number; channel_id: number; channel_name: string; code: string; receiving_id: number | null; receiving_code: string | null; is_active: number }[]>(
    `SELECT d.id, d.channel_id, d.channel_name, d.channel_location_code code, d.transfer_facility_id receiving_id, rf.code receiving_code, d.is_active
       FROM ${TABLES.DETAILS_CHANNELS} d LEFT JOIN ${TABLES.MASTER_FACILITIES} rf ON rf.id = d.transfer_facility_id
      WHERE d.channel_location_code IS NOT NULL AND d.channel_location_code <> ''`,
  )).map((l) => ({
    id: String(l.id), channelId: Number(l.channel_id), channelName: l.channel_name, locationCode: l.code,
    receivingId: l.receiving_id === null ? null : Number(l.receiving_id), receivingCode: l.receiving_code, isActive: !!Number(l.is_active),
  }));
  const routes = (await m.query<{ id: number; dispatch_facility_id: number; location_id: string | number; uniware_channel_code: string | null; customer_code: string | null; customer_name: string | null; vendor_code: string | null; is_active: number }[]>(
    `SELECT id, dispatch_facility_id, location_id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active FROM ${TABLES.D2C_TRANSFER_ROUTES}`,
  )).map((r) => ({
    id: Number(r.id), senderId: Number(r.dispatch_facility_id), locationId: String(r.location_id), uniwareChannelCode: r.uniware_channel_code,
    customerCode: r.customer_code, customerName: r.customer_name, vendorCode: r.vendor_code, isActive: !!Number(r.is_active),
  }));
  const testFacilities = env.d2c.testOnly ? testCodesOf(await readSettings(m)) : null;
  return { facilities, channels, locations, routes, testFacilities };
};

const summaryOf = (plan: UploadPlan) => {
  const n = (a: RoutePlanRow['action']) => plan.rows.filter((r) => r.action === a).length;
  return { added: n('new'), updated: n('update'), unchanged: n('same'), errors: n('error') };
};
const remarkOf = (body: unknown): string | null => {
  const r = body && typeof body === 'object' ? (body as Record<string, unknown>).remark : undefined;
  return typeof r === 'string' && r.trim() ? r.trim().slice(0, 1000) : null;
};

/** POST /masters/transfer-routes/upload/preview: every row checked, nothing saved. */
export const previewRoutesUpload = async (file: UploadFile | undefined) => {
  const rows = parseRoutesUpload(file);
  const plan = planRoutesUpload(rows, await loadMasters(AppDataSource.manager));
  return { fileName: file?.originalname ?? null, rowCount: rows.length, canImport: !plan.rows.some((r) => r.action === 'error'), ...summaryOf(plan), enable: plan.enable.map((f) => f.code), rows: plan.rows };
};

/** POST /masters/transfer-routes/upload/import: re-checked in one transaction, all or nothing (422 ROUTE_UPLOAD_INVALID). */
export const importRoutesUpload = async (file: UploadFile | undefined, body: unknown, by: Actor) => {
  const rows = parseRoutesUpload(file);
  const remark = remarkOf(body);
  const result = await AppDataSource.transaction(async (m) => {
    const plan = planRoutesUpload(rows, await loadMasters(m));
    const bad = plan.rows.filter((r) => r.action === 'error');
    if (bad.length) {
      throw appError(ERROR_CODES.ROUTE_UPLOAD_INVALID, bad.length).withDetails(bad.flatMap((r) => r.errors.map((e) => ({ row: r.row, field: 'row', message: e }))));
    }
    // 1. the warehouses a new / switched-on route needs
    for (const f of plan.enable) {
      await editRowIn(m, MASTER_LOG_TYPE.FACILITY, String(f.id), { changes: { allowInternalTransfer: D2C_ALLOW.YES }, original: { allowInternalTransfer: D2C_ALLOW.NO }, remark }, by);
    }
    // 2. changed routes: the masters edit (checks, test-only rule, History)
    for (const p of plan.rows.filter((r) => r.action === 'update')) {
      const codes = p.changes.filter((c) => c.field !== 'isActive');
      if (codes.length) {
        await editRowIn(m, MASTER_LOG_TYPE.TRANSFER_ROUTE, String(p.routeId), {
          changes: Object.fromEntries(codes.map((c) => [c.field, c.value])), original: Object.fromEntries(codes.map((c) => [c.field, c.old])), remark,
        }, by);
      }
      const on = p.changes.find((c) => c.field === 'isActive');
      if (on) await setActiveIn(m, MASTER_LOG_TYPE.TRANSFER_ROUTE, String(p.routeId), on.value === 'Yes', remark, by);
    }
    // 3. new routes
    for (const p of plan.rows.filter((r) => r.action === 'new')) {
      const w = plan.work.get(p.row)!;
      const v = Object.fromEntries(p.changes.map((c) => [c.field, c.value])) as Partial<Record<Field | 'isActive', string>>;
      const isActive = v.isActive !== 'No';
      const res = await m.query<{ insertId: number }>(
        `INSERT INTO ${TABLES.D2C_TRANSFER_ROUTES} (dispatch_facility_id, location_id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [w.senderId, w.locationId, v.uniwareChannelCode ?? null, v.customerCode ?? null, v.customerName ?? null, v.vendorCode ?? null, isActive],
      );
      await logMasterChanges(m, [{
        type: MASTER_LOG_TYPE.TRANSFER_ROUTE, recordId: res.insertId, rowKey: `${p.sender} -> ${p.channel} | ${p.location}`, action: MASTER_LOG_ACTION.CREATED,
        newValue: addedWith({ uniwareChannelCode: v.uniwareChannelCode, customerCode: v.customerCode, customerName: v.customerName, vendorCode: v.vendorCode, active: isActive ? 'Yes' : 'No' }),
      }], by, MASTER_LOG_SOURCE.SCREEN, remark);
    }
    return { ...summaryOf(plan), switchedOn: plan.enable.map((f) => f.code) };
  });
  log.info(LOG_SOURCE.APP, `[masters] ${by.email} uploaded transfer routes ${file?.originalname ?? ''}: ${result.added} added, ${result.updated} changed, ${result.unchanged} unchanged`);
  return result;
};
