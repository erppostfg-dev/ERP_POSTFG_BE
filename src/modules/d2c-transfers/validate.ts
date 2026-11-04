import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  BRAND_NAMES, D2C_LIMITS, D2C_PRICE, D2C_PRIORITIES, D2C_UNDISPATCHED_STAGES, NO_BRAND, round2, TABLES,
} from '../../constants';
import { addDays, parseDay } from './reference';
import { D2cSettings } from './settings';
import { isTestFacility } from './test-mode';

/*
 * The checks of a transfer, shared by the upload and the form (plan 5.0 + the PRD validation table + the user's
 * answers of 2026-11-03). validateRows() is pure: it gets the rows and a snapshot of the masters (loadMasters) and
 * returns per-row errors / warnings and the transfers the rows make.
 *   Errors: channel not a transfer channel; dispatch facility unknown / inactive / not allowed for transfers; location
 *     not a transfer location of the channel (by its short name, else by facility code / alias), inactive, without a
 *     PO prefix, receiving facility inactive / not allowed; no active route (sender + location) in d2c_transfer_routes;
 *     a route with 2+ active Uniware channels and no / a wrong Uniware Channel chosen (pickRoute);
 *     dispatch = receiving (allowed for a test facility only); in local test mode (masters.testOnly) a sender or
 *     receiving facility that is not a test facility; SKU unknown / inactive / a combo (transfer its components) / without MRP; qty not a whole
 *     number above 0; bad dates (YYYY-MM-DD or DD-MM-YYYY); priority not P1-P3; type not in the settings; expiry
 *     before the PO date; rows of one Group that disagree on the header.
 *   Warnings: route without vendor code (inward PO blocked until filled) / customer / Uniware channel code (SO
 *     blocked until filled); SKU name differs (master name used); same SKU twice in a transfer (merged, qty summed);
 *     same lane + SKU in another transfer not dispatched yet.
 *   Defaults: priority P2, type Regular, expiry = PO date + settings.defaultExpiryDays.
 * Prices (user, 2026-11-03): GMV = MRP x qty; PO value = 15% of MRP x qty (MRP = master_skus.mrp, else intransit_mrp).
 */

export interface RawRow {
  /** File row (header = 1) or form line number. */
  row: number;
  channel: string;
  location: string;
  /** Form: details_channels.id picked from the options (wins over `location`). */
  locationId?: string;
  poDate: string;
  sender: string;
  /** Form: master_facilities.id picked from the options (wins over `sender`). */
  senderId?: number;
  /** Upload: the "Uniware Channel" column (needed only when the route has 2+ Uniware channels). */
  uniwareChannel?: string;
  /** Form: d2c_transfer_routes.id picked (wins over `uniwareChannel`). */
  routeId?: number;
  priority: string;
  group: string;
  type: string;
  expiry: string;
  skuCode: string;
  skuName: string;
  qty: string;
  remarks?: string;
}

export interface Issue { field: string; message: string }
export interface RowResult { row: number; errors: Issue[]; warnings: Issue[] }

export interface FacilityM { id: number; code: string; name: string | null; isActive: boolean; allowTransfer: boolean; aliases: string[] }
export interface LocationM {
  id: string; channel: string; code: string | null; facilityId: number | null; prefix: string | null; isActive: boolean; channelCategory: string | null;
}
export interface RouteM {
  id: number; senderId: number; locationId: string; isActive: boolean; uniwareChannelCode: string | null; customerCode: string | null; vendorCode: string | null;
}
export interface SkuM { code: string; name: string | null; mrp: number | null; isActive: boolean | null; productType: string | null; brand: string | null }

export interface D2cMasters {
  settings: D2cSettings;
  today: string;
  facilities: FacilityM[];
  locations: LocationM[];
  routes: RouteM[];
  /** By lower-case pep_code. */
  skus: Map<string, SkuM>;
  /** `${senderId}:${receivingId}:${sku lower}` -> transfer codes still open and not dispatched. */
  open: Map<string, string[]>;
  /** Local TEST ONLY mode (env.d2c.testOnly): sender and receiving facility must both be test facilities. */
  testOnly?: boolean;
}

export interface ProposedLine {
  skuCode: string; skuName: string | null; brand: string | null; qty: number; mrp: number; gmv: number; poValue: number; rows: number[];
}
export interface ProposedTransfer {
  key: string;
  group: string | null;
  rows: number[];
  valid: boolean;
  senderId: number | null;
  senderCode: string | null;
  channel: string | null;
  locationId: string | null;
  location: string | null;
  receivingId: number | null;
  receivingCode: string | null;
  prefix: string | null;
  channelCategory: string | null;
  route: { id: number; customerCode: string | null; vendorCode: string | null; uniwareChannelCode: string | null } | null;
  /** Active Uniware channels of the sender + location (2+ = Ops had to pick one). */
  routeChannels: string[];
  poDate: string | null;
  priority: string | null;
  type: string | null;
  expiry: string | null;
  remarks: string | null;
  lines: ProposedLine[];
  totalUnits: number;
}

export interface ValidationOutcome {
  rows: RowResult[];
  transfers: ProposedTransfer[];
  errorCount: number;
  warningCount: number;
  canImport: boolean;
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const squash = (s: string | null | undefined) => lower(s).replace(/\s+/g, ' ');
const COMBO = 'combo';

/** po-save's brand rule: PEPIMS spelling, none for '' / '0'. */
const brandOf = (b: string | null): string | null => {
  const t = (b ?? '').trim();
  return NO_BRAND.includes(t) ? null : (BRAND_NAMES[t.toLowerCase()] ?? t);
};

/** GMV and PO value of a line (user, 2026-11-03). */
export const pricesOf = (mrp: number, qty: number) => ({ gmv: round2(mrp * qty), poValue: round2(mrp * D2C_PRICE.SO_MRP_SHARE * qty) });

/** The MRP a transfer uses: master_skus.mrp, else intransit_mrp; null when neither is above 0. */
export const mrpOf = (mrp: number | null, intransitMrp: number | null): number | null => {
  const v = mrp !== null && mrp > 0 ? mrp : intransitMrp;
  return v !== null && v > 0 ? Number(v) : null;
};

/** A facility by its code (exact), an alias (exact), else a unique case-insensitive code. */
export const findFacility = (facilities: FacilityM[], text: string): { facility?: FacilityM; ambiguous?: string[] } => {
  const t = text.trim();
  const exact = facilities.find((f) => f.code === t) ?? facilities.find((f) => f.aliases.includes(t));
  if (exact) return { facility: exact };
  const ci = facilities.filter((f) => f.code.toLowerCase() === t.toLowerCase());
  if (ci.length === 1) return { facility: ci[0] };
  return ci.length ? { ambiguous: ci.map((f) => f.code) } : {};
};

type Resolved = {
  channel: string | null;
  sender: FacilityM | null;
  location: LocationM | null;
  receiving: FacilityM | null;
  route: RouteM | null;
  routeChannels: string[];
  poDate: string | null;
  priority: string | null;
  type: string | null;
  expiry: string | null;
  sku: SkuM | null;
  mrp: number | null;
  qty: number | null;
  group: string | null;
};

/**
 * The route of a transfer (2026-11-03, "Updated route sheet"): the routes of its sender + location; a pair may have 2+
 * Uniware channels (one row each). One active route: it is used (a Uniware Channel / route id given must be that one).
 * 2+ active: the form's route id or the upload's Uniware Channel (no case) must name one of them.
 */
export const pickRoute = (
  routes: readonly RouteM[], choice: { routeId?: number; uniwareChannel?: string }, lane: string,
): { route: RouteM | null; error: string | null; field: 'location' | 'uniwareChannel'; channels: string[] } => {
  const usable = routes.filter((r) => r.isActive);
  const channels = usable.map((r) => r.uniwareChannelCode ?? '(empty)');
  if (!routes.length) return { route: null, error: `No transfer route ${lane}: add it in Masters`, field: 'location', channels };
  if (!usable.length) return { route: null, error: `Transfer route ${lane} is switched off`, field: 'location', channels };
  const text = (choice.uniwareChannel ?? '').trim();
  const has = choice.routeId !== undefined || !!text;
  const chosen = choice.routeId !== undefined
    ? usable.filter((r) => r.id === Number(choice.routeId))
    : text ? usable.filter((r) => lower(r.uniwareChannelCode) === lower(text)) : usable;
  if (chosen.length === 1) return { route: chosen[0], error: null, field: 'uniwareChannel', channels };
  const what = choice.routeId !== undefined ? `route id ${choice.routeId}` : `Uniware Channel ${text}`;
  if (usable.length === 1) return { route: null, error: `${what} is not the Uniware channel of route ${lane} (${channels[0]})`, field: 'uniwareChannel', channels };
  return {
    route: null, channels, field: 'uniwareChannel',
    error: has
      ? `${what} is not one of the Uniware channels of route ${lane} (${channels.join(', ')})`
      : `Route ${lane} has ${usable.length} Uniware channels (${channels.join(', ')}): fill Uniware Channel`,
  };
};

/** Plan 2.5: the location of a channel by its short name, else by a facility code / alias (receiving facility). */
const resolveLocation = (
  r: RawRow, channel: string, sender: FacilityM | null, m: D2cMasters, err: (f: string, msg: string) => void,
): LocationM | null => {
  const ofChannel = m.locations.filter((l) => lower(l.channel) === lower(channel));
  if (r.locationId) {
    const l = ofChannel.find((x) => x.id === String(r.locationId));
    if (!l) err('location', `Location id ${r.locationId} is not a transfer location of ${channel}`);
    return l ?? null;
  }
  const text = r.location.trim();
  if (!text) {
    err('location', 'Location is required');
    return null;
  }
  let found = ofChannel.filter((l) => lower(l.code) === lower(text));
  if (!found.length) {
    const f = findFacility(m.facilities, text).facility;
    if (f) found = ofChannel.filter((l) => l.facilityId === f.id);
  }
  if (found.length > 1) {
    const routed = found.filter((l) => l.isActive && sender && m.routes.some((x) => x.senderId === sender.id && x.locationId === l.id && x.isActive));
    if (routed.length === 1) return routed[0];
    err('location', `${text} matches several ${channel} locations (${found.map((l) => l.code).join(', ')}): use the location name`);
    return null;
  }
  if (!found.length) {
    err('location', `${text} is not a transfer location of ${channel} (location name or receiving facility code): add it in Masters`);
    return null;
  }
  return found[0];
};

const resolveRow = (r: RawRow, m: D2cMasters, out: RowResult): Resolved => {
  const err = (field: string, message: string) => out.errors.push({ field, message });
  const warn = (field: string, message: string) => out.warnings.push({ field, message });
  const s = m.settings;
  const res: Resolved = {
    channel: null, sender: null, location: null, receiving: null, route: null, routeChannels: [], poDate: null, priority: null, type: null, expiry: null,
    sku: null, mrp: null, qty: null, group: r.group.trim() || null,
  };
  if (res.group && res.group.length > D2C_LIMITS.GROUP_MAX) err('group', `Group must be at most ${D2C_LIMITS.GROUP_MAX} characters`);
  if ((r.remarks ?? '').length > D2C_LIMITS.REMARKS_MAX) err('remarks', `Remarks must be at most ${D2C_LIMITS.REMARKS_MAX} characters`);

  // channel
  if (!r.channel.trim()) err('channel', 'Channel is required');
  else {
    res.channel = s.channels.find((c) => lower(c) === lower(r.channel)) ?? null;
    if (!res.channel) err('channel', `${r.channel.trim()} is not a transfer channel (${s.channels.join(', ')})`);
  }

  // dispatch facility
  if (r.senderId !== undefined) {
    res.sender = m.facilities.find((f) => f.id === Number(r.senderId)) ?? null;
    if (!res.sender) err('sender', `Dispatch facility id ${r.senderId} not found`);
  } else if (!r.sender.trim()) err('sender', 'Dispatch Location is required');
  else {
    const f = findFacility(m.facilities, r.sender);
    if (f.ambiguous) err('sender', `${r.sender.trim()} matches several facilities (${f.ambiguous.join(', ')}): use the exact code`);
    else if (!f.facility) err('sender', `Dispatch facility ${r.sender.trim()} not found`);
    res.sender = f.facility ?? null;
  }
  if (res.sender) {
    if (!res.sender.isActive) err('sender', `Dispatch facility ${res.sender.code} is inactive`);
    else if (!res.sender.allowTransfer) err('sender', `Dispatch facility ${res.sender.code} is not allowed for internal transfers (Masters > Warehouses)`);
  }

  // receiving location + route
  if (res.channel) {
    const l = resolveLocation(r, res.channel, res.sender, m, err);
    res.location = l;
    if (l) {
      if (!l.isActive) err('location', `Transfer location ${l.code ?? l.id} of ${res.channel} is inactive`);
      if (!l.prefix?.trim()) err('location', `Transfer location ${l.code ?? l.id} has no PO number prefix: fill it in Masters`);
      res.receiving = m.facilities.find((f) => f.id === l.facilityId) ?? null;
      if (!res.receiving) err('location', `Transfer location ${l.code ?? l.id} has no receiving facility: fill it in Masters`);
      else if (!res.receiving.isActive) err('location', `Receiving facility ${res.receiving.code} is inactive`);
      else if (!res.receiving.allowTransfer) err('location', `Receiving facility ${res.receiving.code} is not allowed for internal transfers (Masters > Warehouses)`);
    }
  }
  // the same facility on both sides only for a test facility (the TEST_FACILITY -> TEST loop of d2c-test-setup)
  if (res.sender && res.receiving && res.sender.id === res.receiving.id && !isTestFacility(s, res.sender.code)) {
    err('location', `Dispatch and receiving facility are the same (${res.sender.code})`);
  }
  if (m.testOnly) {
    const real = [...new Set([res.sender, res.receiving].filter((f): f is FacilityM => !!f && !isTestFacility(s, f.code)).map((f) => f.code))];
    if (real.length) err(res.sender && real.includes(res.sender.code) ? 'sender' : 'location', `local test mode: only transfers between test facilities (TEST_FACILITY) can be made here; ${real.join(', ')} is a real facility`);
  }
  if (res.sender && res.location) {
    const lane = `${res.sender.code} -> ${res.channel} / ${res.location.code}`;
    const pick = pickRoute(m.routes.filter((x) => x.senderId === res.sender!.id && x.locationId === res.location!.id), { routeId: r.routeId, uniwareChannel: r.uniwareChannel }, lane);
    res.route = pick.route;
    res.routeChannels = pick.channels;
    if (pick.error) err(pick.field, pick.error);
    else if (res.route) {
      if (!res.route.vendorCode?.trim()) warn('location', `Route ${lane} has no vendor code: the inward PO is blocked until it is filled`);
      if (!res.route.customerCode?.trim()) warn('location', `Route ${lane} has no customer code: the sale order is blocked until it is filled`);
      if (!res.route.uniwareChannelCode?.trim()) warn('location', `Route ${lane} has no Uniware channel code: the sale order is blocked until it is filled`);
    }
  }

  // dates, priority, type
  if (!r.poDate.trim()) err('poDate', 'PO Date is required');
  else {
    res.poDate = parseDay(r.poDate);
    if (!res.poDate) err('poDate', `PO Date ${r.poDate.trim()} is not a date (YYYY-MM-DD or DD-MM-YYYY)`);
  }
  if (!r.priority.trim()) res.priority = 'P2';
  else {
    res.priority = D2C_PRIORITIES.find((p) => p === r.priority.trim().toUpperCase()) ?? null;
    if (!res.priority) err('priority', `Priority ${r.priority.trim()} must be P1, P2 or P3`);
  }
  if (!r.type.trim()) res.type = s.types[0];
  else {
    res.type = s.types.find((t) => lower(t) === lower(r.type)) ?? null;
    if (!res.type) err('type', `Type ${r.type.trim()} must be one of ${s.types.join(', ')}`);
  }
  if (!r.expiry.trim()) res.expiry = res.poDate ? addDays(res.poDate, s.defaultExpiryDays) : null;
  else {
    res.expiry = parseDay(r.expiry);
    if (!res.expiry) err('expiry', `PO Expiry Date ${r.expiry.trim()} is not a date (YYYY-MM-DD or DD-MM-YYYY)`);
    else if (res.poDate && res.expiry < res.poDate) err('expiry', `PO Expiry Date ${res.expiry} is before the PO date ${res.poDate}`);
  }

  // SKU + qty
  if (!r.skuCode.trim()) err('skuCode', 'SKU Code is required');
  else {
    const sku = m.skus.get(lower(r.skuCode));
    if (!sku) err('skuCode', `SKU ${r.skuCode.trim()} is not in the SKU master`);
    else {
      res.sku = sku;
      res.mrp = sku.mrp;
      if (sku.isActive !== true) err('skuCode', `SKU ${sku.code} is inactive`);
      if (lower(sku.productType) === COMBO) err('skuCode', `SKU ${sku.code} is a combo: transfer its components`);
      if (sku.mrp === null) err('skuCode', `SKU ${sku.code} has no MRP in the SKU master (GMV and PO value need it)`);
      if (r.skuName.trim() && squash(r.skuName) !== squash(sku.name)) warn('skuName', `SKU name differs from the master: "${sku.name ?? ''}" is used`);
    }
  }
  const qtyText = r.qty.trim();
  const qty = Number(qtyText);
  if (!qtyText) err('qty', 'Qty is required');
  else if (!Number.isInteger(qty) || qty <= 0) err('qty', `Qty ${qtyText} must be a whole number above 0`);
  else if (qty > D2C_LIMITS.QTY_MAX) err('qty', `Qty ${qtyText} is above ${D2C_LIMITS.QTY_MAX}`);
  else res.qty = qty;
  return res;
};

/** Header values that must agree within one Group. */
const HEADER: { field: string; label: string; of: (r: Resolved, raw: RawRow) => string }[] = [
  { field: 'sender', label: 'Dispatch Location', of: (r, raw) => (r.sender ? `#${r.sender.id}` : lower(raw.sender)) },
  { field: 'channel', label: 'Channel', of: (r, raw) => r.channel ?? lower(raw.channel) },
  { field: 'location', label: 'Location', of: (r, raw) => (r.location ? `#${r.location.id}` : lower(raw.location)) },
  { field: 'uniwareChannel', label: 'Uniware Channel', of: (r, raw) => (r.route ? `#${r.route.id}` : lower(raw.uniwareChannel)) },
  { field: 'poDate', label: 'PO Date', of: (r, raw) => r.poDate ?? lower(raw.poDate) },
  { field: 'priority', label: 'Priority', of: (r, raw) => r.priority ?? lower(raw.priority) },
  { field: 'type', label: 'Type', of: (r, raw) => r.type ?? lower(raw.type) },
  { field: 'expiry', label: 'PO Expiry Date', of: (r, raw) => r.expiry ?? lower(raw.expiry) },
];

/** Grouping key (PRD + decision 12): the Group, else same dispatch + location + channel + date + priority + type + expiry. */
const groupKey = (r: Resolved, raw: RawRow): string =>
  r.group ? `g:${r.group.toLowerCase()}` : `k:${HEADER.map((h) => h.of(r, raw)).join('|')}`;

export const openKey = (senderId: number, receivingId: number, sku: string) => `${senderId}:${receivingId}:${sku.toLowerCase()}`;

/** Checks every row and groups them into transfers (in order of first appearance = the order serials are taken). */
export const validateRows = (rows: RawRow[], m: D2cMasters): ValidationOutcome => {
  const results: RowResult[] = [];
  const groups = new Map<string, { raws: RawRow[]; res: Resolved[]; outs: RowResult[] }>();
  for (const raw of rows) {
    const out: RowResult = { row: raw.row, errors: [], warnings: [] };
    results.push(out);
    const res = resolveRow(raw, m, out);
    const key = groupKey(res, raw);
    const g = groups.get(key) ?? { raws: [], res: [], outs: [] };
    g.raws.push(raw);
    g.res.push(res);
    g.outs.push(out);
    groups.set(key, g);
  }

  const transfers: ProposedTransfer[] = [];
  for (const [key, g] of groups) {
    const head = g.res[0];
    const headRaw = g.raws[0];
    // rows of one Group must agree on the header
    for (let i = 1; i < g.res.length; i++) {
      for (const h of HEADER) {
        if (h.of(g.res[i], g.raws[i]) !== h.of(head, headRaw)) {
          g.outs[i].errors.push({ field: h.field, message: `Group ${head.group}: ${h.label} differs from row ${headRaw.row}` });
        }
      }
      if ((g.raws[i].remarks ?? '') !== (headRaw.remarks ?? '')) {
        g.outs[i].errors.push({ field: 'remarks', message: `Group ${head.group}: remarks differ from row ${headRaw.row}` });
      }
    }
    // lines: one per SKU, duplicates merged
    const lines = new Map<string, ProposedLine>();
    g.res.forEach((r, i) => {
      if (!r.sku || r.qty === null) return;
      const k = r.sku.code.toLowerCase();
      const have = lines.get(k);
      if (have) {
        g.outs[i].warnings.push({ field: 'skuCode', message: `SKU ${r.sku.code} is already on row ${have.rows[0]} of this transfer: quantities added` });
        have.qty += r.qty;
        have.rows.push(g.raws[i].row);
      } else {
        lines.set(k, { skuCode: r.sku.code, skuName: r.sku.name, brand: brandOf(r.sku.brand), qty: r.qty, mrp: r.mrp ?? 0, gmv: 0, poValue: 0, rows: [g.raws[i].row] });
      }
    });
    for (const l of lines.values()) Object.assign(l, pricesOf(l.mrp, l.qty));
    // open duplicate: same lane + SKU in a transfer not dispatched yet
    if (head.sender && head.receiving) {
      for (const l of lines.values()) {
        const codes = m.open.get(openKey(head.sender.id, head.receiving.id, l.skuCode));
        if (!codes?.length) continue;
        const i = g.raws.findIndex((x) => x.row === l.rows[0]);
        g.outs[i].warnings.push({ field: 'skuCode', message: `SKU ${l.skuCode} is already in open transfer ${codes.join(', ')} on this lane (not dispatched yet)` });
      }
    }
    const lineList = [...lines.values()];
    transfers.push({
      key,
      group: head.group,
      rows: g.raws.map((x) => x.row),
      valid: g.outs.every((o) => !o.errors.length) && lineList.length > 0,
      senderId: head.sender?.id ?? null,
      senderCode: head.sender?.code ?? null,
      channel: head.channel,
      locationId: head.location?.id ?? null,
      location: head.location?.code ?? null,
      receivingId: head.receiving?.id ?? null,
      receivingCode: head.receiving?.code ?? null,
      prefix: head.location?.prefix?.trim() || null,
      channelCategory: head.location?.channelCategory ?? null,
      route: head.route ? { id: head.route.id, customerCode: head.route.customerCode, vendorCode: head.route.vendorCode, uniwareChannelCode: head.route.uniwareChannelCode } : null,
      routeChannels: head.routeChannels,
      poDate: head.poDate,
      priority: head.priority,
      type: head.type,
      expiry: head.expiry,
      remarks: headRaw.remarks?.trim() || null,
      lines: lineList,
      totalUnits: lineList.reduce((s, l) => s + l.qty, 0),
    });
  }
  const errorCount = results.reduce((n, r) => n + r.errors.length, 0);
  return {
    rows: results,
    transfers,
    errorCount,
    warningCount: results.reduce((n, r) => n + r.warnings.length, 0),
    canImport: errorCount === 0 && transfers.length > 0 && transfers.every((t) => t.valid),
  };
};

// ---- the masters snapshot ----------------------------------------------------------------------------------------

const bool = (v: unknown): boolean => v === true || Number(v) === 1;
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * The masters the checks need: every facility, transfer location and route (small tables), the SKUs named in the rows
 * and the open (not dispatched) transfer lines of those SKUs. `excludeUid` = the transfer being edited.
 */
export const loadMasters = async (skuCodes: string[], settings: D2cSettings, today: string, excludeUid?: string): Promise<D2cMasters> => {
  const q = AppDataSource.manager;
  const codes = [...new Set(skuCodes.map((c) => c.trim()).filter(Boolean))];
  const [facilities, locations, routes, skus, open] = await Promise.all([
    q.query<{ id: number; code: string; name: string | null; is_active: unknown; allow_internal_transfer: unknown; aliases: unknown }[]>(
      `SELECT id, code, name, is_active, allow_internal_transfer, aliases FROM ${TABLES.MASTER_FACILITIES}`,
    ),
    q.query<{ id: string | number; channel_name: string; channel_location_code: string | null; transfer_facility_id: number | null; transfer_po_prefix: string | null; is_active: unknown; channel_category: string | null }[]>(
      `SELECT id, channel_name, channel_location_code, transfer_facility_id, transfer_po_prefix, is_active, channel_category
         FROM ${TABLES.DETAILS_CHANNELS} WHERE transfer_facility_id IS NOT NULL`,
    ),
    q.query<{ id: number; dispatch_facility_id: number; location_id: string | number; is_active: unknown; uniware_channel_code: string | null; customer_code: string | null; vendor_code: string | null }[]>(
      `SELECT id, dispatch_facility_id, location_id, is_active, uniware_channel_code, customer_code, vendor_code FROM ${TABLES.D2C_TRANSFER_ROUTES}`,
    ),
    codes.length
      ? q.query<{ pep_code: string; product_name: string | null; mrp: unknown; intransit_mrp: unknown; is_active: unknown; product_type: string | null; brand_name: string | null }[]>(
        `SELECT pep_code, product_name, mrp, intransit_mrp, is_active, product_type, brand_name FROM ${TABLES.MASTER_SKUS} WHERE pep_code IN (?)`,
        [codes],
      )
      : Promise.resolve([]),
    codes.length
      ? q.query<{ sender: number; receiving: number; sku: string; code: string }[]>(
        `SELECT p.facilityId sender, d.transfer_facility_id receiving, l.skuCode sku, p.transferCode code
           FROM ${TABLES.DETAILS_PURCHASE_ORDERS} l
           JOIN ${TABLES.MASTER_PURCHASE_ORDERS} p ON p.uid = l.shipmentOrderId
           JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = p.locationId
          WHERE p.transferCode IS NOT NULL AND p.transferStage IN (?) AND l.skuCode IN (?) AND COALESCE(l.updatedQty, l.qty, 0) > 0
            AND p.uid <> ?`,
        [D2C_UNDISPATCHED_STAGES, codes, excludeUid ?? 0],
      )
      : Promise.resolve([]),
  ]);
  const skuMap = new Map<string, SkuM>();
  for (const s of skus) {
    skuMap.set(s.pep_code.toLowerCase(), {
      code: s.pep_code, name: s.product_name, mrp: mrpOf(num(s.mrp), num(s.intransit_mrp)), isActive: s.is_active === null ? null : bool(s.is_active),
      productType: s.product_type, brand: s.brand_name,
    });
  }
  const openMap = new Map<string, string[]>();
  for (const o of open) {
    const k = openKey(Number(o.sender), Number(o.receiving), o.sku);
    const list = openMap.get(k) ?? [];
    if (!list.includes(o.code)) list.push(o.code);
    openMap.set(k, list);
  }
  const aliasesOf = (v: unknown): string[] => {
    const a = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return []; } })() : v;
    return Array.isArray(a) ? a.map(String) : [];
  };
  return {
    settings,
    today,
    facilities: facilities.map((f) => ({ id: Number(f.id), code: f.code, name: f.name, isActive: bool(f.is_active), allowTransfer: bool(f.allow_internal_transfer), aliases: aliasesOf(f.aliases) })),
    locations: locations.map((l) => ({
      id: String(l.id), channel: l.channel_name, code: l.channel_location_code, facilityId: l.transfer_facility_id === null ? null : Number(l.transfer_facility_id),
      prefix: l.transfer_po_prefix, isActive: bool(l.is_active), channelCategory: l.channel_category,
    })),
    routes: routes.map((r) => ({
      id: Number(r.id), senderId: Number(r.dispatch_facility_id), locationId: String(r.location_id), isActive: bool(r.is_active),
      uniwareChannelCode: r.uniware_channel_code, customerCode: r.customer_code, vendorCode: r.vendor_code,
    })),
    skus: skuMap,
    open: openMap,
    testOnly: env.d2c.testOnly,
  };
};
