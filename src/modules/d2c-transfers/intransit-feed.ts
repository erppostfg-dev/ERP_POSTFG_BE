import path from 'path';
import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  D2C_PACKAGE_STATUS, D2C_REQUEST_STATE, D2C_STAGE, D2C_TRANSFERS_EXTRA_COLUMNS, D2C_TRANSFERS_FILE, D2C_TRANSFERS_REF_SOURCE, D2C_TRANSFERS_SOURCE, TABLES,
  TEST_FACILITY,
} from '../../constants';
import { toCsv, writeAtomic } from '../intransit/sources/files';
import { COMBINED_TARGET_COLS } from '../intransit/stages/combined-intransit';
import { D2cSettings, jsonOf, readSettings } from './settings';

/*
 * Phase 8 (plan d2c-internal-transfers 7.2 Option B + the user's answers): our own exact in-transit feed of the D2C
 * internal transfers, D2C_Transfers.csv, written from our tables at every build for today (both INTRANSIT_PO_SOURCE
 * values) and stored as the day's file (runs.service.ts readTransfers), so a past build replays the stored copy.
 *
 * Rows (one per line / per invoice SKU, combined-intransit's TARGET_COLS + PO Number (Inward) + Transfer Code):
 *   not dispatched   transfers with a sale order (soState created), stage not draft / cancelled / closed: per line
 *                    final Intransit units = allocatedQty (SO items allocated or in process, not dispatched: the
 *                    Export-B2B rule of today, never the raw balance), Final Planning Units = open balance
 *                    (updatedQty - dispatchedQty); Final Status Working (sale order) or RTS (packed / RTS / invoiced).
 *   dispatched       per dispatched invoice (not cancelled) whose GRN is not complete, per SKU of its sku_qty:
 *                    dispatched - received (> 0); Final Status Intransit (no inward PO yet) or PO Created.
 *   reference        one row per transfer of ours (not draft), no units, Source D2C_Transfers_Ref: its reference ID
 *                    wins over PEPIMS / Export-B2B rows of the same PO Number even when nothing of it is open.
 * Facility = sender, Channel = the transfer channel (details_channels.channel_name), Location = the location's
 * channel_location_code (Location Master / intransit_location resolve it as for PEPIMS rows), PO Number = reference ID.
 * Never emitted: drafts, transfers sent by or to a test facility (d2c:settings.testFacilities + TEST_FACILITY).
 * Local test mode (env.d2c.testOnly): the file is written EMPTY (header only), so a local build never counts a transfer.
 */

export const FEED_COLUMNS: readonly string[] = [...COMBINED_TARGET_COLS, ...D2C_TRANSFERS_EXTRA_COLUMNS];

export interface FeedHeader {
  uid: string;
  transferCode: string;
  poNumber: string | null;
  facility: string | null;
  channel: string | null;
  location: string | null;
  receiving: string | null;
  stage: string | null;
  soState: string | null;
  entryDate: string | null;
  poDate: string | null;
  brandName: string | null;
  statusPlanning: string | null;
  statusWarehouse: string | null;
  statusLogistics: string | null;
  dispatchDate: string | null;
}

export interface FeedLine {
  shipmentOrderId: string;
  srNo: string | null;
  skuName: string | null;
  skuCode: string | null;
  channelSkuCode: string | null;
  qty: number | null;
  updatedQty: number | null;
  dispatchedQty: number | null;
  allocatedQty: number | null;
  gmv: number | null;
  poValue: number | null;
  updatedGmv: number | null;
  updatedPoValue: number | null;
  brandName: string | null;
}

export interface FeedInvoice {
  poUid: string;
  inwardPoCode: string | null;
  inwardPoState: string | null;
  packageStatus: string | null;
  dispatchedAt: string | null;
  grnCompletedAt: string | null;
  skuQty: Record<string, { dispatched?: number; inward?: number; received?: number }> | null;
}

export interface FeedFacts {
  headers: FeedHeader[];
  lines: FeedLine[];
  invoices: FeedInvoice[];
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const txt = (v: string | number | null | undefined): string => (v === null || v === undefined ? '' : String(v));
const num = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

/** Stages whose undispatched units are packed / ready to ship: Final Status RTS; any other open stage: Working. */
const RTS_STAGES: readonly string[] = [D2C_STAGE.PACKED, D2C_STAGE.READY_TO_SHIP, D2C_STAGE.INVOICED];
/** Stages never counted. */
const NOT_COUNTED: readonly string[] = [D2C_STAGE.DRAFT, D2C_STAGE.CANCELLED, D2C_STAGE.CLOSED];

/** Upper-cased test facility codes (settings + TEST_FACILITY). */
export const testFacilitiesOf = (s: Pick<D2cSettings, 'testFacilities'>): Set<string> =>
  new Set([TEST_FACILITY, ...(Array.isArray(s.testFacilities) ? s.testFacilities : [])].map((f) => String(f).trim().toUpperCase()));

/** A transfer the feed leaves out entirely: a draft, or sent by / to a test facility. */
export const isLeftOut = (h: Pick<FeedHeader, 'stage' | 'facility' | 'receiving'>, tests: Set<string>): boolean =>
  !h.stage || h.stage === D2C_STAGE.DRAFT || tests.has((h.facility ?? '').trim().toUpperCase()) || tests.has((h.receiving ?? '').trim().toUpperCase());

/** The feed rows (header first) from our transfers. Pure: unit-tested without a database. */
export const buildFeedRows = (facts: FeedFacts, settings: Pick<D2cSettings, 'testFacilities'>, asOf: string): string[][] => {
  const tests = testFacilitiesOf(settings);
  const linesOf = new Map<string, FeedLine[]>();
  for (const l of facts.lines) {
    const k = String(l.shipmentOrderId);
    if (!linesOf.has(k)) linesOf.set(k, []);
    (linesOf.get(k) as FeedLine[]).push(l);
  }
  const invoicesOf = new Map<string, FeedInvoice[]>();
  for (const i of facts.invoices) {
    const k = String(i.poUid);
    if (!invoicesOf.has(k)) invoicesOf.set(k, []);
    (invoicesOf.get(k) as FeedInvoice[]).push(i);
  }
  const out: string[][] = [[...FEED_COLUMNS]];
  const headers = [...facts.headers].filter((h) => !isLeftOut(h, tests) && (!h.entryDate || h.entryDate <= asOf))
    .sort((a, b) => (a.transferCode < b.transferCode ? -1 : a.transferCode > b.transferCode ? 1 : 0));
  for (const h of headers) {
    const base = (): Record<string, string> => ({
      'Entry Date': txt(h.entryDate), 'PO Date': txt(h.poDate), Facility: txt(h.facility), Channel: txt(h.channel), Location: txt(h.location),
      'PO Number': txt(h.poNumber), Brand: txt(h.brandName), 'Dispatch Date': txt(h.dispatchDate),
      'Status Planning': txt(h.statusPlanning), 'Status Warehouse': txt(h.statusWarehouse), 'Status Logistics': txt(h.statusLogistics),
      'Status (Planning)': txt(h.statusPlanning), 'Status (Warehouse)': txt(h.statusWarehouse), 'Status (Logistics)': txt(h.statusLogistics),
      'Transfer Code': h.transferCode,
    });
    const emit = (r: Record<string, string>) => out.push(FEED_COLUMNS.map((c) => r[c] ?? ''));
    emit({ ...base(), Source: D2C_TRANSFERS_REF_SOURCE, 'final Intransit units': '0', 'Final Planning Units': '0' });
    if (NOT_COUNTED.includes(h.stage as string)) continue;
    const lines = [...(linesOf.get(h.uid) ?? [])].sort((a, b) => n(a.srNo) - n(b.srNo));

    // not dispatched: allocated / in process on the sale order
    if (h.soState === D2C_REQUEST_STATE.CREATED) {
      const status = RTS_STAGES.includes(h.stage as string) ? 'RTS' : 'Working';
      for (const l of lines) {
        const allocated = Math.max(0, Math.round(n(l.allocatedQty)));
        const balance = Math.max(0, Math.round(n(l.updatedQty ?? l.qty) - n(l.dispatchedQty)));
        if (!allocated && !balance) continue;
        emit({
          ...base(), Brand: txt(l.brandName ?? h.brandName), 'Sr No': txt(l.srNo), 'SKU Name': txt(l.skuName), 'SKU Code': txt(l.skuCode),
          'Channel SKU Code': txt(l.channelSkuCode ?? l.skuCode), Quantity: num(l.qty), GMV: num(l.gmv), 'PO Value': num(l.poValue),
          'Updated Quantity': num(l.updatedQty), 'Updated GMV': num(l.updatedGmv), 'Updated PO Value': num(l.updatedPoValue),
          'Final Status': status, 'final Intransit units': String(allocated), Source: D2C_TRANSFERS_SOURCE, 'Final Planning Units': String(balance),
        });
      }
    }

    // dispatched, waiting for the GRN: per invoice per SKU, dispatched - received
    for (const inv of invoicesOf.get(h.uid) ?? []) {
      if (!inv.dispatchedAt || inv.packageStatus === D2C_PACKAGE_STATUS.CANCELLED || inv.grnCompletedAt) continue;
      const hasPo = inv.inwardPoState === D2C_REQUEST_STATE.CREATED;
      const inward = inv.inwardPoState && inv.inwardPoState !== D2C_REQUEST_STATE.FAILED ? txt(inv.inwardPoCode) : '';
      for (const sku of Object.keys(inv.skuQty ?? {}).sort()) {
        const q = (inv.skuQty ?? {})[sku] ?? {};
        const open = Math.max(0, Math.round(n(q.dispatched) - n(q.received)));
        if (!open) continue;
        const l = lines.find((x) => x.skuCode === sku);
        emit({
          ...base(), Brand: txt(l?.brandName ?? h.brandName), 'Sr No': txt(l?.srNo), 'SKU Name': txt(l?.skuName), 'SKU Code': sku,
          'Channel SKU Code': txt(l?.channelSkuCode ?? sku), Quantity: String(Math.round(n(q.dispatched))), 'Updated Quantity': String(open),
          'Final Status': hasPo ? 'PO Created' : 'Intransit', 'final Intransit units': String(open), Source: D2C_TRANSFERS_SOURCE,
          'Final Planning Units': String(open), 'PO Number (Inward)': inward,
        });
      }
    }
  }
  return out;
};

/** A database value as text (strings and numbers as they are; anything else as JSON). */
const asText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : JSON.stringify(v));
const day = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return asText(v).slice(0, 10);
};
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : asText(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/** Our transfers, their lines and invoices (read only). */
export const readFeedFacts = async (m: EntityManager = AppDataSource.manager): Promise<FeedFacts> => {
  const heads = await m.query<Record<string, unknown>[]>(
    `SELECT p.uid, p.transferCode, p.poNumber, p.facility, COALESCE(d.channel_name, p.channel) channel,
            COALESCE(d.channel_location_code, p.location) location, f.code receiving, p.transferStage stage, p.soState, p.entryDate,
            p.poDate, p.brandName, p.statusPlanning, p.statusWarehouse, p.statusLogistics, p.dispatchDate
     FROM ${TABLES.MASTER_PURCHASE_ORDERS} p
     LEFT JOIN ${TABLES.DETAILS_CHANNELS} d ON d.id = p.locationId
     LEFT JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id
     WHERE p.transferCode IS NOT NULL AND (p.transferStage IS NULL OR p.transferStage <> ?)`,
    [D2C_STAGE.DRAFT],
  );
  const headers: FeedHeader[] = heads.map((r) => ({
    uid: String(r.uid), transferCode: String(r.transferCode), poNumber: strOrNull(r.poNumber), facility: strOrNull(r.facility),
    channel: strOrNull(r.channel), location: strOrNull(r.location), receiving: strOrNull(r.receiving), stage: strOrNull(r.stage),
    soState: strOrNull(r.soState), entryDate: day(r.entryDate), poDate: day(r.poDate), brandName: strOrNull(r.brandName),
    statusPlanning: strOrNull(r.statusPlanning), statusWarehouse: strOrNull(r.statusWarehouse), statusLogistics: strOrNull(r.statusLogistics),
    dispatchDate: day(r.dispatchDate),
  }));
  if (!headers.length) return { headers, lines: [], invoices: [] };
  const uids = headers.map((h) => h.uid);
  const lineRows = await m.query<Record<string, unknown>[]>(
    `SELECT shipmentOrderId, srNo, skuName, skuCode, channelSkuCode, qty, updatedQty, dispatchedQty, allocatedQty, gmv, poValue, updatedGmv,
            updatedPoValue, brandName
     FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE shipmentOrderId IN (?) ORDER BY shipmentOrderId, id`, [uids],
  );
  const invRows = await m.query<Record<string, unknown>[]>(
    `SELECT po_uid, inward_po_code, inward_po_state, package_status, dispatched_at, grn_completed_at, sku_qty
     FROM ${TABLES.PO_INVOICES} WHERE po_uid IN (?) ORDER BY po_uid, id`, [uids],
  );
  return {
    headers,
    lines: lineRows.map((r) => ({
      shipmentOrderId: String(r.shipmentOrderId), srNo: strOrNull(r.srNo), skuName: strOrNull(r.skuName), skuCode: strOrNull(r.skuCode),
      channelSkuCode: strOrNull(r.channelSkuCode), qty: numOrNull(r.qty), updatedQty: numOrNull(r.updatedQty), dispatchedQty: numOrNull(r.dispatchedQty),
      allocatedQty: numOrNull(r.allocatedQty), gmv: numOrNull(r.gmv), poValue: numOrNull(r.poValue), updatedGmv: numOrNull(r.updatedGmv),
      updatedPoValue: numOrNull(r.updatedPoValue), brandName: strOrNull(r.brandName),
    })),
    invoices: invRows.map((r) => ({
      poUid: String(r.po_uid), inwardPoCode: strOrNull(r.inward_po_code), inwardPoState: strOrNull(r.inward_po_state),
      packageStatus: strOrNull(r.package_status), dispatchedAt: strOrNull(r.dispatched_at), grnCompletedAt: strOrNull(r.grn_completed_at),
      skuQty: jsonOf<FeedInvoice['skuQty']>(r.sku_qty, null),
    })),
  };
};

export interface FeedResult {
  file: string;
  transfers: number;
  rows: number;
  units: number;
}

/**
 * Write D2C_Transfers.csv for `asOf` (the current state of our tables: call it for today) into outDir. Local test mode:
 * header only.
 */
export const writeTransferFeed = async (
  outDir: string, asOf: string, m: EntityManager = AppDataSource.manager, testOnly = env.d2c.testOnly,
): Promise<FeedResult> => {
  const rows = testOnly
    ? buildFeedRows({ headers: [], lines: [], invoices: [] }, { testFacilities: [] }, asOf)
    : await Promise.all([readFeedFacts(m), readSettings(m)]).then(([facts, settings]) => buildFeedRows(facts, settings, asOf));
  const file = path.join(outDir, D2C_TRANSFERS_FILE);
  await writeAtomic(file, toCsv(rows));
  const src = FEED_COLUMNS.indexOf('Source');
  const units = FEED_COLUMNS.indexOf('final Intransit units');
  const counted = rows.slice(1).filter((r) => r[src] === D2C_TRANSFERS_SOURCE);
  return {
    file, transfers: rows.slice(1).filter((r) => r[src] === D2C_TRANSFERS_REF_SOURCE).length, rows: counted.length,
    units: counted.reduce((s, r) => s + n(r[units]), 0),
  };
};
