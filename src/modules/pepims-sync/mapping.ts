import {
  BULK_ORDER_TYPE, BULK_SALE, DELIVERY_TYPE, OTHERS_CHANNEL, PEPIMS_CHANNEL_RENAMES, PEPIMS_DATE_RANGE, PEPIMS_FACILITY_FIXES, PEPIMS_FIELD_KIND,
  PEPIMS_INSTITUTIONAL_NAMES, PEPIMS_INTERNAL_TRANSFER_NAMES, PEPIMS_LINE_FIELDS, PEPIMS_MARKETING_NAMES, PEPIMS_PO_FIELDS, PEPIMS_SKIP_CHANNELS,
  PEPIMS_STATUS_FIXES, PepimsFieldKind, PO_GROUP, PoGroup, poGroupOf, pepimsCleanName, pepimsNameKey, STATUS_STAGE,
} from '../../constants';

/*
 * PEPIMS row -> our row (pure; constants/pepims-sync.ts). Every value is also given in a canonical text form (canon),
 * which is what the sync compares and keeps in pepims_sync_links.synced_values: dates YYYY-MM-DD, numbers with their
 * decimals, JSON as text, empty = null.
 */

export type Row = Record<string, unknown>;

/** What our tables already have, read once per run. */
export interface Masters {
  /** master_channels display names, exactly. */
  channels: Set<string>;
  /** master_facilities code (exact) -> id. */
  facilities: Map<string, number>;
  /** stage -> (status key -> the master's spelling). */
  statuses: Map<string, Map<string, string>>;
  /** courier partner key -> { id, code }. */
  partners: Map<string, { id: number; code: string }>;
  /** channel name -> its locations (active or not). */
  locations: Map<string, { id: string; code: string | null; drop: string | null; city: string | null }[]>;
}

/** Things the report lists (text kept as it was, no link). */
export interface Notes {
  facility?: string;
  transporters: string[];
  location?: string;
  statuses: string[];
  dates: { field: string; value: string }[];
}

export interface ChannelChoice {
  channel: string;
  poGroup: PoGroup;
  partyName: string | null;
  /** History text when the channel was changed (rename / bucket). */
  note: string | null;
}

const keyed = (list: readonly string[]) => new Set(list.map(pepimsNameKey));
const INSTITUTIONAL = keyed(PEPIMS_INSTITUTIONAL_NAMES);
const MARKETING = keyed(PEPIMS_MARKETING_NAMES);
const INTERNAL = keyed(PEPIMS_INTERNAL_TRANSFER_NAMES);
const SKIP = keyed(PEPIMS_SKIP_CHANNELS);
const RENAMES = new Map(Object.entries(PEPIMS_CHANNEL_RENAMES).map(([k, v]) => [pepimsNameKey(k), v]));

/** Our channel, group and party name for a PEPIMS "channel" (null = not imported, user: skip). */
export const channelChoice = (pepims: string | null, m: Masters): ChannelChoice | null => {
  const raw = pepims ?? '';
  const k = pepimsNameKey(raw);
  if (SKIP.has(k)) return null;
  if (m.channels.has(raw)) return { channel: raw, poGroup: poGroupOf(raw), partyName: null, note: null };
  const renamed = RENAMES.get(k) ?? [...m.channels].find((c) => pepimsNameKey(c) === k);
  if (renamed) return { channel: renamed, poGroup: poGroupOf(renamed), partyName: null, note: `channel in PEPIMS: "${raw}"` };
  const party = pepimsCleanName(raw);
  const bucket = (channel: string, poGroup: PoGroup): ChannelChoice => ({ channel, poGroup, partyName: party, note: `PEPIMS channel "${raw}" -> ${channel} (${poGroup})` });
  if (INSTITUTIONAL.has(k)) return bucket(BULK_SALE.CHANNEL[BULK_ORDER_TYPE.INSTITUTIONAL], PO_GROUP.INSTITUTIONAL);
  if (MARKETING.has(k)) return bucket(BULK_SALE.CHANNEL[BULK_ORDER_TYPE.MARKETING], PO_GROUP.MARKETING);
  if (INTERNAL.has(k)) return bucket(OTHERS_CHANNEL.NAME, PO_GROUP.INTERNAL_TRANSFER);
  return bucket(OTHERS_CHANNEL.NAME, PO_GROUP.OTHERS);
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** Any DB value as text (objects as JSON, so never "[object Object]"). */
export const textOf = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
};

/** A PEPIMS / our value in the form the sync compares (null = empty). */
export const canon = (kind: PepimsFieldKind, v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (kind === PEPIMS_FIELD_KIND.JSON) {
    const parsed: unknown = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return v; } })() : v;
    return parsed === null ? null : JSON.stringify(parsed);
  }
  if (kind === PEPIMS_FIELD_KIND.DATE) {
    const s = textOf(v).trim().slice(0, 10);
    return s || null;
  }
  if (kind === PEPIMS_FIELD_KIND.INT || kind === PEPIMS_FIELD_KIND.DEC2 || kind === PEPIMS_FIELD_KIND.DEC3) {
    if (typeof v === 'string' && !v.trim()) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return kind === PEPIMS_FIELD_KIND.INT ? String(Math.round(n)) : round(n, kind === PEPIMS_FIELD_KIND.DEC2 ? 2 : 3).toFixed(kind === PEPIMS_FIELD_KIND.DEC2 ? 2 : 3);
  }
  const s = textOf(v);
  return s === '' ? null : s;
};

/** The value to write for a canonical text. */
export const valueOf = (kind: PepimsFieldKind, c: string | null): unknown => {
  if (c === null) return null;
  if (kind === PEPIMS_FIELD_KIND.JSON) return JSON.parse(c) as unknown;
  if (kind === PEPIMS_FIELD_KIND.INT || kind === PEPIMS_FIELD_KIND.DEC2 || kind === PEPIMS_FIELD_KIND.DEC3) return Number(c);
  return c;
};

const statusKey = (v: string) => v.toLowerCase().replace(/[\s-]+/g, '');
const partnerKey = (v: string) => v.toLowerCase().replace(/[\s\-_]+/g, '');
export const partnerKeyOf = partnerKey;
export const statusKeyOf = statusKey;

const STAGE_OF: Record<string, string> = { statusPlanning: STATUS_STAGE.PLANNING, statusWarehouse: STATUS_STAGE.WAREHOUSE, statusLogistics: STATUS_STAGE.LOGISTICS };
const TRANSPORTERS = [['firstTransporter', 'firstTransporterId'], ['secondTransporter', 'secondTransporterId'], ['thirdTransporter', 'thirdTransporterId']] as const;

export interface MappedPo {
  /** Canonical values of PEPIMS_PO_FIELDS (what the sync compares). */
  fields: Record<string, string | null>;
  /** Links next to the text (null = not matched). */
  links: { facilityId: number | null; locationId: string | null; firstTransporterId: number | null; secondTransporterId: number | null; thirdTransporterId: number | null };
  notes: Notes;
}

/** A PEPIMS shipment_orders row as our master_purchase_orders values (for the PO's channel). */
export const mapPo = (r: Row, channel: string, m: Masters): MappedPo => {
  const notes: Notes = { transporters: [], statuses: [], dates: [] };
  const fields: Record<string, string | null> = {};
  for (const [f, kind] of Object.entries(PEPIMS_PO_FIELDS)) {
    let c = canon(kind, r[f]);
    if (kind === PEPIMS_FIELD_KIND.DATE && c !== null && (!DAY.test(c) || Number.isNaN(Date.parse(c)) || c < PEPIMS_DATE_RANGE.MIN || c > PEPIMS_DATE_RANGE.MAX)) {
      notes.dates.push({ field: f, value: c });
      c = null;
    }
    fields[f] = c;
  }
  // statuses: PEPIMS's few other spellings -> the master's
  for (const [f, stage] of Object.entries(STAGE_OF)) {
    const v = fields[f];
    if (v === null) continue;
    const fixed = PEPIMS_STATUS_FIXES[v] ?? v;
    const master = m.statuses.get(stage)?.get(statusKey(fixed));
    if (master) fields[f] = master;
    else notes.statuses.push(`${f}: ${v}`);
  }
  // delivery type: Pickup / Pick up / Drop In / Drop IN -> ours
  const dt = fields.deliveryType;
  if (dt !== null) {
    const k = statusKey(dt);
    if (k === statusKey(DELIVERY_TYPE.PICK_UP)) fields.deliveryType = DELIVERY_TYPE.PICK_UP;
    else if (k === statusKey(DELIVERY_TYPE.DROP_IN)) fields.deliveryType = DELIVERY_TYPE.DROP_IN;
  }
  // facility: exact code, else the user's / one-candidate fixes (case = main vs child: never guessed)
  let facilityId: number | null = null;
  const fac = fields.facility;
  if (fac !== null) {
    const code = m.facilities.has(fac) ? fac : PEPIMS_FACILITY_FIXES[fac];
    if (code && m.facilities.has(code)) {
      fields.facility = code;
      facilityId = m.facilities.get(code) ?? null;
    } else notes.facility = fac;
  }
  // transporters: the partner's code when the name matches (spaces, hyphens, case ignored)
  const ids: Record<string, number | null> = {};
  for (const [f, idField] of TRANSPORTERS) {
    const v = fields[f];
    const p = v !== null ? m.partners.get(partnerKey(v)) : undefined;
    if (p) fields[f] = p.code;
    else if (v !== null) notes.transporters.push(v);
    ids[idField] = p?.id ?? null;
  }
  // location: the channel's location by code, else by its drop city (only when one location fits)
  let locationId: string | null = null;
  const loc = fields.location;
  if (loc !== null) {
    const list = m.locations.get(channel) ?? [];
    const lk = loc.trim().toLowerCase();
    const byCode = list.filter((l) => (l.code ?? '').trim().toLowerCase() === lk);
    const byDrop = list.filter((l) => (l.drop ?? '').trim().toLowerCase() === lk || (l.city ?? '').trim().toLowerCase() === lk);
    const hit = byCode.length === 1 ? byCode[0] : byCode.length === 0 && byDrop.length === 1 ? byDrop[0] : undefined;
    if (hit) locationId = hit.id;
    else notes.location = loc;
  }
  return {
    fields,
    links: { facilityId, locationId, firstTransporterId: ids.firstTransporterId, secondTransporterId: ids.secondTransporterId, thirdTransporterId: ids.thirdTransporterId },
    notes,
  };
};

/** A PEPIMS sku_orders row as canonical details_purchase_orders values. */
export const mapLine = (r: Row): Record<string, string | null> =>
  Object.fromEntries(Object.entries(PEPIMS_LINE_FIELDS).map(([f, kind]) => [f, canon(kind, r[f])]));

/** Canonical values -> values to write. */
export const toValues = (canonical: Record<string, string | null>, kinds: Readonly<Record<string, PepimsFieldKind>>): Row =>
  Object.fromEntries(Object.entries(canonical).map(([f, c]) => [f, valueOf(kinds[f], c)]));
