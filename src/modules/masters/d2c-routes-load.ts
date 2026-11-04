import { D2C_LOCATION_FACILITY } from '../../constants/d2c-transfers';

/*
 * The pure part of `npm run d2c:routes-load` (2026-11-03; plan "Route codes from the user's sheet"): no DB, no files.
 * The script reads the sheet, the masters and PEPIMS's PO_Format, and this module decides what to write:
 *   - facility codes: master_facilities.code EXACTLY (case matters: MUM_WAREHOUSE2 and MUM_Warehouse2 are two real
 *     facilities), else an exact alias, else a case-insensitive code / alias match ONLY when it names one facility;
 *   - transfer locations (details_channels): the approved location -> receiving facility mapping
 *     (D2C_LOCATION_FACILITY), one row per location name; PO prefix = PEPIMS's most used prefix for that location;
 *   - routes: key = (sender, channel + location, Uniware channel) exactly as the sheet says (2026-11-03 "Updated route
 *     sheet": no manual fixes; one sender + location may have 2+ Uniware channels = 2+ routes); the vendor = the Vendor
 *     Code row of (sender, receiving facility); exact duplicates are loaded once, rows of one key with different values
 *     are reported and NOT loaded (no guessing);
 *   - upsert (planRouteUpserts): a sheet route matches the DB row of the same key, else the ONLY DB row of its sender +
 *     location when that pair has one sheet route and one DB row left (its Uniware channel changed in the sheet, e.g.
 *     D2C_TRANSFER_MCAFF -> _L); changed fields are updated (an empty sheet cell never clears a DB value); DB routes
 *     not in the sheet are only reported.
 */

export interface Facility { id: number; code: string; aliases: string[]; allowInternalTransfer?: boolean }
export type FacilityHow = 'exact' | 'alias' | 'case';
export type FacilityMatch =
  | { id: number; code: string; how: FacilityHow }
  | { id: null; code: null; how: 'unmatched' | 'ambiguous'; candidates: string[] };

const lc = (s: string) => s.trim().toLowerCase();
/** Channel names compared without case, spaces, dashes or underscores (Kol_warehouse = KOL_WAREHOUSE = kol-warehouse). */
const channelKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** One facility code as written in the sheet -> the facility (see the header for the order of the rules). */
export const matchFacility = (raw: string, facilities: readonly Facility[]): FacilityMatch => {
  const s = raw.trim();
  const exact = facilities.find((f) => f.code === s);
  if (exact) return { id: exact.id, code: exact.code, how: 'exact' };
  const alias = facilities.filter((f) => f.aliases.some((a) => a.trim() === s));
  if (alias.length === 1) return { id: alias[0].id, code: alias[0].code, how: 'alias' };
  if (alias.length > 1) return { id: null, code: null, how: 'ambiguous', candidates: alias.map((f) => f.code) };
  const ci = facilities.filter((f) => lc(f.code) === lc(s) || f.aliases.some((a) => lc(a) === lc(s)));
  if (ci.length === 1) return { id: ci[0].id, code: ci[0].code, how: 'case' };
  return { id: null, code: null, how: ci.length ? 'ambiguous' : 'unmatched', candidates: ci.map((f) => f.code) };
};

/** A matcher that remembers every code it saw (for the report: alias / case fixes, unmatched, ambiguous). */
export const facilityMatcher = (facilities: readonly Facility[]) => {
  const seen = new Map<string, FacilityMatch & { where: Set<string> }>();
  const match = (raw: string, where: string): FacilityMatch => {
    const key = raw.trim();
    let m = seen.get(key);
    if (!m) seen.set(key, (m = { ...matchFacility(key, facilities), where: new Set() }));
    m.where.add(where);
    return m;
  };
  const report = () => [...seen.entries()].map(([raw, m]) => ({ raw, ...m, where: [...m.where].join(', ') }));
  return { match, report };
};

// ---- PO number prefix (PEPIMS PO_Format) ---------------------------------------------------------------------------

/** A PO number's prefix: the text before the first "|"; null when there is none or it is not like a location code. */
export const poPrefixOf = (poNumber: string): string | null => {
  const i = poNumber.indexOf('|');
  if (i <= 0) return null; // "SO33071": no prefix at all
  const p = poNumber.slice(0, i).trim();
  if (!p || !/[A-Za-z]/.test(p)) return null;
  if (/^(SO|PO)\d+$/i.test(p)) return null;
  return p;
};

export interface PrefixChoice { prefix: string; count: number; total: number; others: string[] }

/** The most used prefix of a location's PO numbers (ties: alphabetical, so the result never depends on row order). */
export const choosePrefix = (poNumbers: readonly string[]): PrefixChoice | null => {
  const counts = new Map<string, number>();
  for (const n of poNumbers) {
    const p = poPrefixOf(n);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (!sorted.length) return null;
  return { prefix: sorted[0][0], count: sorted[0][1], total: poNumbers.length, others: sorted.slice(1).map(([p, n]) => `${p} (${n})`) };
};

export interface PoFormatRow { channel: string; location: string; poNumber: string; poDate: string }

/** Prefix per (channel key, lower-case location) from PO_Format rows with a PO date within `days` of the newest one. */
export const prefixesByLocation = (rows: readonly PoFormatRow[], days: number): Map<string, PrefixChoice> => {
  const dates = rows.map((r) => r.poDate.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const newest = dates[dates.length - 1];
  const from = newest ? new Date(Date.parse(`${newest}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10) : '';
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const d = r.poDate.slice(0, 10);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(d) && d < from) continue;
    const k = locKey(r.channel, r.location);
    (by.get(k) ?? by.set(k, []).get(k)!).push(r.poNumber);
  }
  const out = new Map<string, PrefixChoice>();
  for (const [k, nums] of by) {
    const c = choosePrefix(nums);
    if (c) out.set(k, c);
  }
  return out;
};
const locKey = (channel: string, location: string): string => `${channelKey(channel)}|${lc(location)}`;

// ---- transfer locations --------------------------------------------------------------------------------------------

export interface Channel { id: number; displayName: string; slug: string; aliases: string[] }
export interface ExistingLocation {
  id: string; channelId: number; locationCode: string | null; transferFacilityId: number | null; transferPoPrefix: string | null; isActive: boolean;
}
export interface LocationPlan {
  channelId: number; channelName: string; locationCode: string; receivingId: number | null; receivingCode: string | null; receivingHow: string;
  prefix: string | null; prefixSource: 'pepims' | 'pepims twin' | 'facility code' | 'none'; prefixNote: string;
  /** new = insert; reuse = an existing row (fills only its empty fields); skip = cannot be loaded (see problem). */
  action: 'new' | 'reuse' | 'skip'; existingId: string | null;
  /** Columns to fill on a reused row: [column, old, new]. */
  fills: [string, unknown, unknown][];
  problem: string | null;
}

/** The channel row for a sheet / mapping channel name (display name, slug or alias, compared by channelKey). */
export const findChannel = (name: string, channels: readonly Channel[]): Channel | null => {
  const k = channelKey(name);
  const hits = channels.filter((c) => [c.displayName, c.slug, ...c.aliases].some((n) => channelKey(n) === k));
  return hits.length === 1 ? hits[0] : null;
};

export const planLocations = (
  channels: readonly Channel[], match: (raw: string, where: string) => FacilityMatch, existing: readonly ExistingLocation[],
  prefixes: Map<string, PrefixChoice>, mapping: Record<string, Record<string, string>> = D2C_LOCATION_FACILITY,
): LocationPlan[] => {
  const out: LocationPlan[] = [];
  for (const [channelName, locs] of Object.entries(mapping)) {
    const ch = findChannel(channelName, channels);
    for (const [locationCode, facilityCode] of Object.entries(locs)) {
      const base = { channelId: ch?.id ?? 0, channelName: ch?.displayName ?? channelName, locationCode, fills: [] as [string, unknown, unknown][] };
      if (!ch) {
        out.push({ ...base, receivingId: null, receivingCode: null, receivingHow: '', prefix: null, prefixSource: 'none', prefixNote: '', action: 'skip', existingId: null, problem: `channel ${channelName} not in master_channels` });
        continue;
      }
      const f = match(facilityCode, `location ${channelName}/${locationCode}`);
      const pepims = (loc: string) => prefixes.get(locKey(channelName, loc)) ?? prefixes.get(locKey(ch.displayName, loc));
      const pc = pepims(locationCode);
      // user, 2026-11-03: a location with no PEPIMS PO takes the prefix of its twin = another location name of the same
      // channel with the same receiving facility (Hyderabad -> Hyderabad2's Mcaff_Hyderabad2); the most used one wins
      const twin = pc ? null : Object.entries(locs)
        .filter(([l, code]) => l !== locationCode && lc(code) === lc(facilityCode))
        .map(([l]) => ({ l, c: pepims(l) }))
        .filter((x): x is { l: string; c: PrefixChoice } => !!x.c)
        .sort((a, b) => b.c.count - a.c.count || (a.l < b.l ? -1 : 1))[0] ?? null;
      const prefix = pc ? pc.prefix : twin ? twin.c.prefix : f.code;
      const prefixSource: LocationPlan['prefixSource'] = pc ? 'pepims' : twin ? 'pepims twin' : f.code ? 'facility code' : 'none';
      const prefixNote = pc ? `${pc.count}/${pc.total} POs${pc.others.length ? `; also ${pc.others.join(', ')}` : ''}`
        : twin ? `from ${twin.l} (${twin.c.count} POs)` : 'no PEPIMS PO in the window';
      const plan: LocationPlan = {
        ...base, receivingId: f.id, receivingCode: f.code, receivingHow: f.how, prefix, prefixSource, prefixNote, action: 'new', existingId: null, problem: null,
      };
      if (!f.id) {
        out.push({ ...plan, action: 'skip', problem: `receiving facility ${facilityCode} ${f.how}${f.how === 'ambiguous' ? ` (${f.candidates.join(' / ')})` : ''}` });
        continue;
      }
      const same = existing.filter((e) => e.channelId === ch.id && lc(e.locationCode ?? '') === lc(locationCode));
      if (same.length > 1) {
        out.push({ ...plan, action: 'skip', problem: `${same.length} existing rows for ${ch.displayName} / ${locationCode} (ids ${same.map((e) => e.id).join(', ')})` });
        continue;
      }
      if (same.length === 1) {
        const e = same[0];
        plan.action = 'reuse';
        plan.existingId = e.id;
        plan.locationCode = e.locationCode ?? locationCode;
        if (e.transferFacilityId === null) plan.fills.push(['transfer_facility_id', null, f.id]);
        else if (e.transferFacilityId !== f.id) plan.problem = `existing row ${e.id} has receiving facility id ${e.transferFacilityId}, mapping says ${f.code} (${f.id}): kept`;
        if (!e.transferPoPrefix && prefix) plan.fills.push(['transfer_po_prefix', null, prefix]);
        if (!e.isActive) plan.problem = [plan.problem, `existing row ${e.id} is switched off: kept off`].filter(Boolean).join('; ');
        if (e.transferFacilityId !== null && e.transferFacilityId !== f.id) plan.receivingId = e.transferFacilityId; // routes follow the row as it is
      }
      out.push(plan);
    }
  }
  return out;
};

// ---- routes --------------------------------------------------------------------------------------------------------

export interface ChannelSheetRow { row: number; uniwareChannel: string; customerCode: string; customerName: string; channel: string; location: string; sender: string }
export interface VendorSheetRow { row: number; sender: string; vendor: string; receiver: string }

export interface RoutePlan {
  rows: number[]; senderId: number; senderCode: string; channelName: string; locationCode: string; location: LocationPlan;
  receivingId: number; receivingCode: string; uniwareChannelCode: string | null; customerCode: string | null; customerName: string | null;
  vendorCode: string | null; vendorNote: string;
}
export interface RouteIssue { rows: number[]; kind: string; detail: string }

const blankToNull = (s: string | undefined): string | null => (s && s.trim() ? s.trim() : null);

/**
 * The vendor of (sender, receiver): Vendor Code rows whose facilities resolved to exactly these two; else rows whose
 * codes equal the two codes ignoring case, only when they give one vendor code (reported as a case fallback).
 */
const vendorFinder = (rows: readonly VendorSheetRow[], match: (raw: string, where: string) => FacilityMatch) => {
  const resolved = rows.map((r) => ({
    r, s: match(r.sender, `vendor sheet row ${r.row} (sender)`), t: match(r.receiver, `vendor sheet row ${r.row} (receiver)`), vendor: r.vendor.trim(),
  })).filter((x) => x.vendor);
  return (senderId: number, senderCode: string, receiverId: number, receiverCode: string): { code: string | null; note: string; conflict: boolean } => {
    const exact = resolved.filter((x) => x.s.id === senderId && x.t.id === receiverId);
    const codes = [...new Set(exact.map((x) => x.vendor))];
    if (codes.length === 1) return { code: codes[0], note: `vendor row ${exact.map((x) => x.r.row).join(', ')}`, conflict: false };
    if (codes.length > 1) return { code: null, note: `vendor sheet has ${codes.join(' / ')} (rows ${exact.map((x) => x.r.row).join(', ')})`, conflict: true };
    const ci = resolved.filter((x) => lc(x.s.code ?? x.r.sender) === lc(senderCode) && lc(x.t.code ?? x.r.receiver) === lc(receiverCode));
    const ciCodes = [...new Set(ci.map((x) => x.vendor))];
    if (ciCodes.length === 1) {
      return { code: ciCodes[0], note: `CASE FALLBACK: vendor row ${ci.map((x) => `${x.r.row} (${x.r.sender} -> ${x.r.receiver})`).join(', ')}`, conflict: false };
    }
    if (ciCodes.length > 1) return { code: null, note: `case-insensitive rows disagree: ${ciCodes.join(' / ')}`, conflict: true };
    return { code: null, note: 'no vendor row for this sender / receiver', conflict: false };
  };
};

/** Route key: sender + transfer location + Uniware channel (codes compared without case). */
const routeKey = (senderId: number, channelId: number, locationCode: string, uniwareChannel: string | null) =>
  `${senderId}|${channelId}|${lc(locationCode)}|${lc(uniwareChannel ?? '')}`;

export const buildRoutes = (
  channelRows: readonly ChannelSheetRow[], vendorRows: readonly VendorSheetRow[], locations: readonly LocationPlan[],
  match: (raw: string, where: string) => FacilityMatch,
): { routes: RoutePlan[]; issues: RouteIssue[] } => {
  const issues: RouteIssue[] = [];
  const vendorOf = vendorFinder(vendorRows, match);
  const byKey = new Map<string, RoutePlan[]>();
  for (const r of channelRows) {
    const s = match(r.sender, `channel sheet row ${r.row} (sender)`);
    if (!s.id) {
      issues.push({ rows: [r.row], kind: 'sender not found', detail: `${r.sender} (${s.how}${s.how === 'ambiguous' ? `: ${s.candidates.join(' / ')}` : ''})` });
      continue;
    }
    // sheet "Kol_warehouse" = channel KOL_WAREHOUSE, "HYDERABAD3" = Hyderabad3
    const loc = locations.find((l) => channelKey(l.channelName) === channelKey(r.channel) && lc(l.locationCode) === lc(r.location));
    if (!loc) {
      issues.push({ rows: [r.row], kind: 'location not in the mapping', detail: `${r.channel} / ${r.location}` });
      continue;
    }
    if (loc.action === 'skip' || !loc.receivingId || !loc.receivingCode) {
      issues.push({ rows: [r.row], kind: 'location not loaded', detail: `${r.channel} / ${r.location}: ${loc.problem ?? 'no receiving facility'}` });
      continue;
    }
    if (loc.receivingId === s.id) {
      issues.push({ rows: [r.row], kind: 'sender = receiver', detail: `${s.code} -> ${loc.channelName} / ${loc.locationCode} (receiving ${loc.receivingCode})` });
      continue;
    }
    const v = vendorOf(s.id, s.code, loc.receivingId, loc.receivingCode);
    if (v.conflict) issues.push({ rows: [r.row], kind: 'vendor conflict (left empty)', detail: `${s.code} -> ${loc.receivingCode}: ${v.note}` });
    const uniwareChannelCode = blankToNull(r.uniwareChannel);
    const plan: RoutePlan = {
      rows: [r.row], senderId: s.id, senderCode: s.code, channelName: loc.channelName, locationCode: loc.locationCode, location: loc,
      receivingId: loc.receivingId, receivingCode: loc.receivingCode, uniwareChannelCode, customerCode: blankToNull(r.customerCode),
      customerName: blankToNull(r.customerName), vendorCode: v.code, vendorNote: v.note,
    };
    const key = routeKey(s.id, loc.channelId, loc.locationCode, uniwareChannelCode);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(plan);
  }
  const routes: RoutePlan[] = [];
  const sig = (p: RoutePlan) => JSON.stringify([p.uniwareChannelCode, p.customerCode, p.customerName, p.vendorCode]);
  for (const plans of byKey.values()) {
    const sigs = [...new Set(plans.map(sig))];
    const rows = plans.flatMap((p) => p.rows);
    const what = `${plans[0].senderCode} -> ${plans[0].channelName}/${plans[0].locationCode} [${plans[0].uniwareChannelCode ?? '-'}]`;
    if (sigs.length === 1) {
      if (plans.length > 1) issues.push({ rows, kind: 'duplicate row (same values, loaded once)', detail: what });
      routes.push({ ...plans[0], rows });
      continue;
    }
    issues.push({
      rows, kind: 'CONFLICT (not loaded)',
      detail: `${what}: ${plans.map((p) => `row ${p.rows[0]} ${p.customerCode}/${p.customerName}/${p.vendorCode}`).join(' vs ')}`,
    });
  }
  return { routes, issues };
};

/** Sender + location pairs with 2+ Uniware channels among the routes (Ops pick one per transfer). */
export const multiChannelRoutes = (routes: readonly RoutePlan[]): { senderCode: string; channelName: string; locationCode: string; channels: string[] }[] => {
  const by = new Map<string, RoutePlan[]>();
  for (const r of routes) {
    const k = `${r.senderId}|${r.location.channelId}|${lc(r.locationCode)}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return [...by.values()].filter((g) => g.length > 1)
    .map((g) => ({ senderCode: g[0].senderCode, channelName: g[0].channelName, locationCode: g[0].locationCode, channels: g.map((r) => r.uniwareChannelCode ?? '(empty)') }));
};

// ---- upsert against d2c_transfer_routes ---------------------------------------------------------------------------

export interface ExistingRoute {
  id: number; senderId: number; locationId: string; uniwareChannelCode: string | null; customerCode: string | null;
  customerName: string | null; vendorCode: string | null; isActive: boolean;
}
export const ROUTE_FIELDS = [
  ['uniwareChannelCode', 'uniware_channel_code'], ['customerCode', 'customer_code'], ['customerName', 'customer_name'], ['vendorCode', 'vendor_code'],
] as const;
export type RouteField = (typeof ROUTE_FIELDS)[number][0];
export interface RouteChange { field: RouteField; col: string; old: string | null; value: string | null }
export interface RouteWork {
  r: RoutePlan;
  action: 'new' | 'update' | 'same';
  id: number | null;
  /** How the DB row was found: same key, or the only row of the pair (its Uniware channel changed in the sheet). */
  matchedBy: 'key' | 'pair' | null;
  changes: RouteChange[];
  /** DB values kept because the sheet cell is empty. */
  kept: string[];
  /** The DB row is switched off (left off). */
  inactive: boolean;
}

/** Sheet routes vs DB routes: new / update (changed fields) / same, and the DB routes the sheet does not have. */
export const planRouteUpserts = (routes: readonly RoutePlan[], existing: readonly ExistingRoute[]): { work: RouteWork[]; notInSheet: ExistingRoute[] } => {
  const pair = (senderId: number, locationId: string) => `${senderId}|${locationId}`;
  const used = new Set<number>();
  const found = new Map<RoutePlan, { e: ExistingRoute; by: 'key' | 'pair' }>();
  // 1. the same key
  for (const r of routes) {
    const locId = r.location.existingId;
    if (!locId) continue;
    const e = existing.find((x) => !used.has(x.id) && x.senderId === r.senderId && x.locationId === locId && lc(x.uniwareChannelCode ?? '') === lc(r.uniwareChannelCode ?? ''));
    if (e) {
      used.add(e.id);
      found.set(r, { e, by: 'key' });
    }
  }
  // 2. one sheet route + one DB row left on a pair: the same route, its Uniware channel changed
  const leftRoutes = new Map<string, RoutePlan[]>();
  for (const r of routes) {
    if (found.has(r) || !r.location.existingId) continue;
    const k = pair(r.senderId, r.location.existingId);
    (leftRoutes.get(k) ?? leftRoutes.set(k, []).get(k)!).push(r);
  }
  for (const [k, rs] of leftRoutes) {
    const es = existing.filter((x) => !used.has(x.id) && pair(x.senderId, x.locationId) === k);
    if (rs.length === 1 && es.length === 1) {
      used.add(es[0].id);
      found.set(rs[0], { e: es[0], by: 'pair' });
    }
  }
  const work = routes.map((r): RouteWork => {
    const f = found.get(r);
    if (!f) return { r, action: 'new', id: null, matchedBy: null, changes: [], kept: [], inactive: false };
    const changes: RouteChange[] = [];
    const kept: string[] = [];
    for (const [field, col] of ROUTE_FIELDS) {
      const old = f.e[field], want = r[field];
      if ((old ?? '') === (want ?? '')) continue;
      if (want === null) {
        kept.push(`${field}: kept ${old} (sheet empty)`);
        continue;
      }
      changes.push({ field, col, old, value: want });
    }
    return { r, action: changes.length ? 'update' : 'same', id: f.e.id, matchedBy: f.by, changes, kept, inactive: !f.e.isActive };
  });
  return { work, notInSheet: existing.filter((x) => !used.has(x.id)) };
};

/** Facilities that send or receive a loaded route (to get allow_internal_transfer = 1). */
export const facilitiesInRoutes = (routes: readonly RoutePlan[]): Map<number, { code: string; sends: number; receives: number }> => {
  const out = new Map<number, { code: string; sends: number; receives: number }>();
  const get = (id: number, code: string) => out.get(id) ?? out.set(id, { code, sends: 0, receives: 0 }).get(id)!;
  for (const r of routes) {
    get(r.senderId, r.senderCode).sends++;
    get(r.receivingId, r.receivingCode).receives++;
  }
  return out;
};
