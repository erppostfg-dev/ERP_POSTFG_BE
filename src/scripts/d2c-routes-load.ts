/*
 * Loads the D2C internal transfer routes from the user's sheet (2026-11-03; plan d2c-internal-transfers, "Route codes
 * from the user's sheet" + "Updated route sheet"): sheet "Vendor Code" (Sending Facility, Vendor Code, Location (earlier
 * Facility) = receiving) and sheet "Updated Channel Code" (else "Channel Code"; Channel Type = Uniware channel code,
 * Customer Code, Customer Name, Channel, Location, Facility = SENDING). The sheet is the truth: no manual fixes.
 * Writes:
 *   - details_channels: one transfer location per (channel, location name) of the approved mapping
 *     (D2C_LOCATION_FACILITY) with transfer_facility_id = receiving facility and transfer_po_prefix = PEPIMS's prefix
 *     (most used in PO_Format over the last 90 days; else the receiving facility code); an existing row with the same
 *     channel + location code is reused and only its EMPTY fields are filled;
 *   - d2c_transfer_routes: UPSERT by (sender, location, Uniware channel) (planRouteUpserts): new routes inserted,
 *     changed fields of existing ones updated (each logged with old / new), routes in the DB but not in the sheet only
 *     REPORTED (not deleted, not switched off);
 *   - master_facilities.allow_internal_transfer = 1 for every sender / receiver of a loaded route.
 * Every write has its master_change_logs row (source script). Problems (unknown codes, conflicting duplicates) are
 * reported and those rows are NOT loaded.
 * DRY RUN by default (summary + a change-log workbook, nothing written to the DB); --apply writes in ONE transaction
 * and needs migration D2cRouteChannels1794000000000 (the old unique key allows one Uniware channel per route).
 *
 *   npm run d2c:routes-load -- --file "<xlsx>" [--po-format <PO_Format.csv>] [--out <dir>] [--apply] [--by <email>]
 */
import 'reflect-metadata';
import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import {
  D2C_LOCATION_FACILITY, D2C_PO_PREFIX_DAYS, D2C_ROUTE_SHEET, IST_OFFSET_MS, INTRANSIT_FOLDERS, MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE, TABLES,
} from '../constants';
import { ActivityLog, User } from '../entities';
import { eachCsvRow, decodeText } from '../modules/intransit/io';
import { readXlsxSheet, textXlsx } from '../modules/intransit/sources/files';
import {
  buildRoutes, Channel, ChannelSheetRow, ExistingLocation, ExistingRoute, Facility, facilitiesInRoutes, facilityMatcher, findChannel, LocationPlan,
  multiChannelRoutes, PoFormatRow, planLocations, planRouteUpserts, prefixesByLocation, VendorSheetRow,
} from '../modules/masters/d2c-routes-load';
import { xlsxSheetNames } from '../modules/intransit/sources/files';
import { addedWith, logMasterChanges, MasterLogEntry } from '../modules/masters/master-log';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const USAGE = 'usage: npm run d2c:routes-load -- --file "<xlsx>" [--po-format <PO_Format.csv>] [--out <dir>] [--apply] [--by <email>]';

const aliasesOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? (JSON.parse(v) as string[]) : []);

/**
 * A sheet as records by column: the first sheet of `names` that exists; each column by the first of its names found
 * in the header row (= first row having one name of every column). `get(key)` reads the column of that key.
 */
const records = <K extends string>(
  raw: Uint8Array, names: readonly string[], cols: Record<K, readonly string[]>,
): { sheet: string; rows: { row: number; get: (c: K) => string }[] } => {
  const sheet = names.find((n) => readXlsxSheet(raw, n));
  if (!sheet) throw new Error(`no sheet named ${names.map((n) => `"${n}"`).join(' or ')} (sheets: ${xlsxSheetNames(raw).join(', ')})`);
  const rows = readXlsxSheet(raw, sheet)!;
  const keys = Object.keys(cols) as K[];
  const at = (r: string[], k: K) => {
    for (const n of cols[k]) {
      const i = r.findIndex((x) => x.trim().toLowerCase() === n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const h = rows.findIndex((r) => keys.every((k) => at(r, k) >= 0));
  if (h < 0) throw new Error(`sheet "${sheet}": no header row with ${keys.map((k) => cols[k].join(' / ')).join(', ')}`);
  const idx = new Map(keys.map((k) => [k, at(rows[h], k)]));
  return {
    sheet,
    rows: rows.slice(h + 1)
      .map((r, i) => ({ row: h + i + 2, get: (c: K) => String(r[idx.get(c)!] ?? '').trim() }))
      .filter((r) => keys.some((k) => r.get(k))),
  };
};

/** The newest inputs/daily/<date>/PO_Format.csv. */
const latestPoFormat = (): string | null => {
  const daily = path.join(env.intransit.dir, INTRANSIT_FOLDERS.INPUTS, INTRANSIT_FOLDERS.DAILY);
  if (!fs.existsSync(daily)) return null;
  const days = fs.readdirSync(daily).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of days) {
    const f = path.join(daily, d, 'PO_Format.csv');
    if (fs.existsSync(f)) return f;
  }
  return null;
};

const readPoFormat = (file: string): PoFormatRow[] => {
  const out: PoFormatRow[] = [];
  let head: string[] | null = null;
  let ix = { channel: -1, location: -1, po: -1, date: -1 };
  eachCsvRow(decodeText(new Uint8Array(fs.readFileSync(file))), ',', (r) => {
    if (!head) {
      head = r.map((x) => x.trim());
      ix = { channel: head.indexOf('Channel'), location: head.indexOf('Location'), po: head.indexOf('PO Number'), date: head.indexOf('PO Date') };
      if (ix.channel < 0 || ix.location < 0 || ix.po < 0) throw new Error(`${file}: needs columns Channel, Location, PO Number`);
      return;
    }
    out.push({ channel: r[ix.channel] ?? '', location: r[ix.location] ?? '', poNumber: (r[ix.po] ?? '').trim(), poDate: ix.date < 0 ? '' : r[ix.date] ?? '' });
  });
  return out;
};

const exists = async (table: string, column?: string): Promise<boolean> => {
  const [r] = await AppDataSource.query<{ n: string }[]>(
    `SELECT COUNT(*) n FROM information_schema.${column ? 'COLUMNS' : 'TABLES'} WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?${column ? ' AND COLUMN_NAME = ?' : ''}`,
    column ? [table, column] : [table],
  );
  return Number(r.n) > 0;
};

const indexExists = async (table: string, index: string): Promise<boolean> => {
  const [r] = await AppDataSource.query<{ n: string }[]>(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, index],
  );
  return Number(r.n) > 0;
};

const main = async (): Promise<void> => {
  const file = arg('file');
  if (!file) throw new Error(USAGE);
  const xlsx = new Uint8Array(fs.readFileSync(file));
  await AppDataSource.initialize(); // guarded: only the allowed databases
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : `DRY RUN on ${AppDataSource.options.database}: nothing is written to the DB (add --apply)`);
  try {
    const migrated = (await exists(TABLES.D2C_TRANSFER_ROUTES)) && (await exists(TABLES.DETAILS_CHANNELS, 'transfer_po_prefix'));
    if (!migrated) console.log('NOTE: migration D2cTransferRoutes1793900000000 has not run on this DB yet (no d2c_transfer_routes / transfer_po_prefix): existing routes and prefixes are taken as none; --apply refuses.');
    if (APPLY && !migrated) throw new Error('run the D2cTransferRoutes migration first');
    // a route may have 2+ Uniware channels only after D2cRouteChannels (the old unique key is one row per sender + location)
    const channelKeyed = migrated && (await indexExists(TABLES.D2C_TRANSFER_ROUTES, 'uq_d2c_transfer_routes_route_channel'))
      && (await exists(TABLES.MASTER_PURCHASE_ORDERS, 'transferRouteId'));
    if (migrated && !channelKeyed) console.log('NOTE: migration D2cRouteChannels1794000000000 has not run on this DB yet (unique key is still sender + location): dry run only, --apply refuses.');
    if (APPLY && !channelKeyed) {
      throw new Error('--apply refused: run migration D2cRouteChannels1794000000000 first (npm run migration:run). Until then d2c_transfer_routes allows one Uniware channel per sender + location and the new routes cannot be written.');
    }

    // ---- masters
    const facilities: Facility[] = (await AppDataSource.query<{ id: number; code: string; aliases: unknown; allow_internal_transfer: number }[]>(
      `SELECT id, code, aliases, allow_internal_transfer FROM ${TABLES.MASTER_FACILITIES} WHERE is_active = 1`,
    )).map((f) => ({ id: Number(f.id), code: f.code, aliases: aliasesOf(f.aliases), allowInternalTransfer: !!Number(f.allow_internal_transfer) }));
    const channels: Channel[] = (await AppDataSource.query<{ id: number; display_name: string; slug: string; db_aliases: unknown }[]>(
      `SELECT id, display_name, slug, db_aliases FROM ${TABLES.MASTER_CHANNELS}`,
    )).map((c) => ({ id: Number(c.id), displayName: c.display_name, slug: c.slug, aliases: aliasesOf(c.db_aliases) }));
    const match = facilityMatcher(facilities);

    // ---- PEPIMS prefixes
    const poFile = arg('po-format') ?? latestPoFormat();
    const poRows = poFile ? readPoFormat(poFile) : [];
    console.log(`PO_Format: ${poFile ?? '(none found: every prefix = receiving facility code)'} (${poRows.length} rows, last ${D2C_PO_PREFIX_DAYS} days used)`);
    const prefixes = prefixesByLocation(poRows, D2C_PO_PREFIX_DAYS);

    // ---- existing transfer locations of the transfer channels
    const channelIds = Object.keys(D2C_LOCATION_FACILITY).map((n) => findChannel(n, channels)?.id).filter((x): x is number => !!x);
    const existing: ExistingLocation[] = channelIds.length ? (await AppDataSource.query<{ id: string; channel_id: number; channel_location_code: string | null; transfer_facility_id: number | null; transfer_po_prefix?: string | null; is_active: number }[]>(
      `SELECT id, channel_id, channel_location_code, transfer_facility_id${migrated ? ', transfer_po_prefix' : ''}, is_active FROM ${TABLES.DETAILS_CHANNELS}
        WHERE channel_id IN (${channelIds.map(() => '?').join(', ')})`, channelIds,
    )).map((r) => ({
      id: String(r.id), channelId: Number(r.channel_id), locationCode: r.channel_location_code,
      transferFacilityId: r.transfer_facility_id === null ? null : Number(r.transfer_facility_id), transferPoPrefix: r.transfer_po_prefix ?? null, isActive: !!Number(r.is_active),
    })) : [];
    const locations = planLocations(channels, match.match, existing, prefixes);

    // ---- the sheet
    const V = D2C_ROUTE_SHEET.VENDOR, C = D2C_ROUTE_SHEET.CHANNEL;
    const vSheet = records(xlsx, V.names, { sender: V.sender, vendor: V.vendor, receiver: V.receiver });
    const vendorRows: VendorSheetRow[] = vSheet.rows.map((r) => ({ row: r.row, sender: r.get('sender'), vendor: r.get('vendor'), receiver: r.get('receiver') }));
    const cSheet = records(xlsx, C.names, {
      uniwareChannel: C.uniwareChannel, customerCode: C.customerCode, customerName: C.customerName, channel: C.channel, location: C.location, sender: C.sender,
    });
    const channelRows: ChannelSheetRow[] = cSheet.rows.map((r) => ({
      row: r.row, uniwareChannel: r.get('uniwareChannel'), customerCode: r.get('customerCode'), customerName: r.get('customerName'),
      channel: r.get('channel'), location: r.get('location'), sender: r.get('sender'),
    }));
    const { routes, issues } = buildRoutes(channelRows, vendorRows, locations, match.match);

    // ---- existing routes: upsert by (sender, location, Uniware channel)
    const oldRoutes: ExistingRoute[] = migrated
      ? (await AppDataSource.query<{ id: number; dispatch_facility_id: number; location_id: string | number; uniware_channel_code: string | null; customer_code: string | null; customer_name: string | null; vendor_code: string | null; is_active: number }[]>(
        `SELECT id, dispatch_facility_id, location_id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active FROM ${TABLES.D2C_TRANSFER_ROUTES}`,
      )).map((o) => ({
        id: Number(o.id), senderId: Number(o.dispatch_facility_id), locationId: String(o.location_id), uniwareChannelCode: o.uniware_channel_code,
        customerCode: o.customer_code, customerName: o.customer_name, vendorCode: o.vendor_code, isActive: !!Number(o.is_active),
      }))
      : [];
    const { work: routeWork, notInSheet } = planRouteUpserts(routes, oldRoutes);
    const multi = multiChannelRoutes(routes);
    const enable = [...facilitiesInRoutes(routes).entries()].map(([id, v]) => ({ id, ...v, already: !!facilities.find((f) => f.id === id)?.allowInternalTransfer }))
      .sort((a, b) => (a.code < b.code ? -1 : 1));
    const facilityCode = new Map(facilities.map((f) => [f.id, f.code]));
    const locationName = new Map(existing.map((l) => [l.id, `${channels.find((c) => c.id === l.channelId)?.displayName ?? l.channelId}/${l.locationCode ?? ''}`]));
    const routeName = (o: ExistingRoute) => `${facilityCode.get(o.senderId) ?? o.senderId} -> ${locationName.get(o.locationId) ?? o.locationId} [${o.uniwareChannelCode ?? '-'}]`;

    // ---- report
    const codes = match.report();
    const fixed = codes.filter((c) => c.how === 'alias' || c.how === 'case');
    const unmatched = codes.filter((c) => !c.id);
    const nLoc = (a: LocationPlan['action']) => locations.filter((l) => l.action === a).length;
    const missingVendor = routes.filter((r) => !r.vendorCode);
    const caseVendor = routes.filter((r) => r.vendorNote.startsWith('CASE FALLBACK'));
    const conflicts = issues.filter((i) => /CONFLICT|conflict/.test(i.kind));
    const updates = routeWork.filter((w) => w.action === 'update');
    console.log(`\nSheet: "${vSheet.sheet}" ${vendorRows.length} vendor rows, "${cSheet.sheet}" ${channelRows.length} channel rows`);
    console.log(`Transfer locations: ${locations.length} (new ${nLoc('new')}, reused ${nLoc('reuse')}, skipped ${nLoc('skip')})`);
    for (const l of locations) {
      console.log(`  ${l.action.padEnd(5)} ${`${l.channelName} / ${l.locationCode}`.padEnd(40)} -> ${String(l.receivingCode ?? '?').padEnd(24)} prefix ${String(l.prefix ?? '-').padEnd(22)} [${l.prefixSource}${l.prefixSource === 'pepims' ? `: ${l.prefixNote}` : ''}]${l.problem ? `  !! ${l.problem}` : ''}${l.fills.length ? `  fill ${l.fills.map((f) => f[0]).join(', ')}` : ''}`);
    }
    console.log(`Routes in the sheet: ${routes.length} (new ${routeWork.filter((w) => w.action === 'new').length}, update ${updates.length}, unchanged ${routeWork.filter((w) => w.action === 'same').length}); in the DB: ${oldRoutes.length}`);
    console.log(`  updated fields: ${countBy(updates.flatMap((w) => w.changes.map((c) => c.field))).map(([f, n]) => `${f} ${n}`).join(', ') || 'none'}`);
    for (const w of updates) {
      console.log(`    ${w.r.senderCode} -> ${w.r.channelName}/${w.r.locationCode} (id ${w.id}${w.matchedBy === 'pair' ? ', same sender + location, Uniware channel changed' : ''}): ${w.changes.map((c) => `${c.field} ${c.old ?? '(empty)'} -> ${c.value ?? '(empty)'}`).join('; ')}`);
    }
    console.log(`  in the DB, not in the sheet (reported only, not deleted / switched off): ${notInSheet.length}`);
    for (const o of notInSheet) console.log(`    id ${o.id} ${routeName(o)}${o.isActive ? '' : ' (off)'}`);
    console.log(`  routes with 2+ Uniware channels (Ops pick one per transfer): ${multi.length}`);
    for (const x of multi) console.log(`    ${x.senderCode} -> ${x.channelName}/${x.locationCode}: ${x.channels.join(', ')}`);
    const off = routeWork.filter((w) => w.inactive);
    if (off.length) console.log(`  in the sheet but switched off in the DB (left off): ${off.map((w) => `id ${w.id}`).join(', ')}`);
    console.log(`  missing vendor ${missingVendor.length}, missing customer ${routes.filter((r) => !r.customerCode).length}, missing Uniware channel ${routes.filter((r) => !r.uniwareChannelCode).length}`);
    console.log(`  vendor by CASE FALLBACK (sender / receiver spelled with another case in the vendor sheet): ${caseVendor.length}`);
    for (const [pair, n] of countBy(caseVendor.map((r) => `${r.senderCode} -> ${r.receivingCode}  ${r.vendorCode}  (${r.vendorNote.replace('CASE FALLBACK: ', '')})`))) console.log(`    ${n} x ${pair}`);
    console.log(`  missing vendor by sender -> receiver:`);
    for (const [pair, n] of countBy(missingVendor.map((r) => `${r.senderCode} -> ${r.receivingCode}`))) console.log(`    ${n} x ${pair}`);
    console.log(`Facility codes matched by alias / case: ${fixed.length}`);
    for (const c of fixed) console.log(`  '${c.raw}' -> ${c.code} (${c.how}; ${c.where.split(', ').length} place(s))`);
    console.log(`Facility codes NOT matched: ${unmatched.length}`);
    for (const c of unmatched) console.log(`  '${c.raw}' ${c.how}${'candidates' in c && c.candidates.length ? ` (${c.candidates.join(' / ')})` : ''} in ${c.where.split(', ').slice(0, 4).join(', ')}${c.where.split(', ').length > 4 ? ' ...' : ''}`);
    console.log(`Issues (rows not loaded unless said): ${issues.length} (conflicts ${conflicts.length})`);
    for (const [k, n] of countBy(issues.map((i) => i.kind))) console.log(`  ${n} x ${k}`);
    for (const i of issues) console.log(`    rows ${i.rows.join(', ')}: ${i.kind}: ${i.detail}`);
    const kept = routeWork.flatMap((w) => w.kept.map((k) => `${w.r.senderCode} -> ${w.r.channelName}/${w.r.locationCode}: ${k}`));
    if (kept.length) { console.log(`Existing route values kept (sheet cell empty): ${kept.length}`); for (const k of kept) console.log(`  ${k}`); }
    console.log(`Facilities to allow internal transfers: ${enable.filter((e) => !e.already).length} to switch on, ${enable.filter((e) => e.already).length} already on`);
    console.log(`  to switch on: ${enable.filter((e) => !e.already).map((e) => `${e.code} [s${e.sends}/r${e.receives}]`).join(', ') || 'none'}`);

    // ---- change-log workbook
    const outDir = arg('out') ?? path.join('storage', 'd2c');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const outFile = path.join(outDir, `routes-load-${APPLY ? 'apply' : 'dry'}-${stamp}.xlsx`);
    fs.writeFileSync(outFile, textXlsx([
      { name: 'Locations', rows: [['Action', 'Channel', 'Location', 'Receiving facility', 'Matched by', 'PO prefix', 'Prefix from', 'Prefix note', 'Existing id', 'Fills', 'Problem'],
        ...locations.map((l) => [l.action, l.channelName, l.locationCode, l.receivingCode ?? '', l.receivingHow, l.prefix ?? '', l.prefixSource, l.prefixNote, l.existingId ?? '', l.fills.map((f) => `${f[0]}=${String(f[2])}`).join('; '), l.problem ?? ''])] },
      { name: 'Routes', rows: [['Action', 'Route id', 'Matched by', 'Sender', 'Channel', 'Location', 'Receiving', 'Uniware channel', 'Customer code', 'Customer name', 'Vendor code', 'Vendor note', 'Changes', 'Kept', 'Sheet rows'],
        ...routeWork.map((w) => [w.action, w.id === null ? '' : String(w.id), w.matchedBy ?? '', w.r.senderCode, w.r.channelName, w.r.locationCode, w.r.receivingCode, w.r.uniwareChannelCode ?? '', w.r.customerCode ?? '', w.r.customerName ?? '', w.r.vendorCode ?? '', w.r.vendorNote,
          w.changes.map((c) => `${c.field}: ${c.old ?? ''} -> ${c.value ?? ''}`).join('; '), w.kept.join('; '), w.r.rows.join(', ')])] },
      { name: 'Not in sheet', rows: [['Route id', 'Route', 'Customer code', 'Vendor code', 'Active'], ...notInSheet.map((o) => [String(o.id), routeName(o), o.customerCode ?? '', o.vendorCode ?? '', o.isActive ? 'Yes' : 'No'])] },
      { name: 'Issues', rows: [['Kind', 'Sheet rows', 'Detail'], ...issues.map((i) => [i.kind, i.rows.join(', '), i.detail])] },
      { name: 'Facility codes', rows: [['As written', 'Facility', 'Matched by', 'Where'], ...codes.map((c) => [c.raw, c.code ?? '', c.how, c.where])] },
      { name: 'Facilities', rows: [['Facility', 'Routes sent', 'Routes received', 'Allow internal transfer now', 'After'],
        ...enable.map((e) => [e.code, String(e.sends), String(e.receives), e.already ? 'Yes' : 'No', 'Yes'])] },
    ]));
    console.log(`\nChange log: ${path.resolve(outFile)}`);
    if (!APPLY) return;

    // ---- apply: ONE transaction
    const by = arg('by');
    const user = by ? await AppDataSource.getRepository(User).findOneBy({ email: by }) : null;
    if (by && !user) throw new Error(`--by ${by}: no such user`);
    const actor = { id: user?.id ?? null };
    await AppDataSource.transaction(async (m) => {
      const now = new Date();
      const logs: MasterLogEntry[] = [];
      const locId = new Map<LocationPlan, string>();
      for (const l of locations) {
        if (l.action === 'skip') continue;
        const key = `${l.channelName} | ${l.locationCode}`;
        if (l.action === 'new') {
          const r = await m.query(
            `INSERT INTO ${TABLES.DETAILS_CHANNELS} (channel_id, channel_name, channel_location_code, transfer_facility_id, transfer_po_prefix, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, [l.channelId, l.channelName, l.locationCode, l.receivingId, l.prefix, now, now]);
          const id = String((r as { insertId: number }).insertId);
          locId.set(l, id);
          logs.push({ type: MASTER_LOG_TYPE.LOCATION, recordId: id, rowKey: key, action: MASTER_LOG_ACTION.CREATED,
            newValue: addedWith({ channel: l.channelName, locationCode: l.locationCode, transferFacility: l.receivingCode, transferPoPrefix: l.prefix, isActive: true }) });
          continue;
        }
        locId.set(l, l.existingId!);
        for (const [col, , value] of l.fills) {
          await m.query(`UPDATE ${TABLES.DETAILS_CHANNELS} SET \`${col}\` = ?, updated_at = ? WHERE id = ? AND \`${col}\` IS NULL`, [value, now, l.existingId]);
          logs.push({ type: MASTER_LOG_TYPE.LOCATION, recordId: l.existingId, rowKey: key, action: MASTER_LOG_ACTION.FIELD_CHANGED,
            field: col === 'transfer_facility_id' ? 'transferFacilityId' : 'transferPoPrefix', oldValue: null, newValue: value });
        }
      }
      // updates before inserts: a route whose Uniware channel changes frees its old key first
      for (const w of routeWork.filter((x) => x.action === 'update')) {
        const r = w.r;
        const key = `${r.senderCode} -> ${r.channelName} | ${r.locationCode}`;
        for (const c of w.changes) {
          await m.query(`UPDATE ${TABLES.D2C_TRANSFER_ROUTES} SET \`${c.col}\` = ?, updated_at = ? WHERE id = ?`, [c.value, now, w.id]);
          logs.push({ type: MASTER_LOG_TYPE.TRANSFER_ROUTE, recordId: w.id, rowKey: key, action: MASTER_LOG_ACTION.FIELD_CHANGED, field: c.field, oldValue: c.old, newValue: c.value });
        }
      }
      for (const w of routeWork.filter((x) => x.action === 'new')) {
        const r = w.r;
        const key = `${r.senderCode} -> ${r.channelName} | ${r.locationCode}`;
        const res = await m.query(
          `INSERT INTO ${TABLES.D2C_TRANSFER_ROUTES} (dispatch_facility_id, location_id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, [r.senderId, locId.get(r.location), r.uniwareChannelCode, r.customerCode, r.customerName, r.vendorCode, now, now]);
        logs.push({ type: MASTER_LOG_TYPE.TRANSFER_ROUTE, recordId: (res as { insertId: number }).insertId, rowKey: key, action: MASTER_LOG_ACTION.CREATED,
          newValue: addedWith({ uniwareChannelCode: r.uniwareChannelCode, customerCode: r.customerCode, customerName: r.customerName, vendorCode: r.vendorCode, isActive: true }) });
      }
      for (const e of enable.filter((x) => !x.already)) {
        await m.query(`UPDATE ${TABLES.MASTER_FACILITIES} SET allow_internal_transfer = 1 WHERE id = ? AND allow_internal_transfer = 0`, [e.id]);
        logs.push({ type: MASTER_LOG_TYPE.FACILITY, recordId: e.id, rowKey: e.code, action: MASTER_LOG_ACTION.FIELD_CHANGED, field: 'allowInternalTransfer', oldValue: 'No', newValue: 'Yes' });
      }
      await logMasterChanges(m, logs, actor, MASTER_LOG_SOURCE.SCRIPT, `d2c:routes-load ${path.basename(file)}`);
      await m.getRepository(ActivityLog).insert({
        userId: actor.id, method: 'AUDIT', status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS),
        path: `d2c:routes-load ${path.basename(file)}: ${locId.size} locations, ${routeWork.filter((w) => w.action !== 'same').length} routes, ${enable.filter((x) => !x.already).length} facilities`.slice(0, 255),
      });
      console.log(`Written: ${logs.length} change log rows.`);
    });
    console.log('Applied.');
  } finally {
    await AppDataSource.destroy();
  }
};

const countBy = (xs: string[]): [string, number][] => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
