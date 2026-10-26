import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'fflate';
import { Frame, stripText } from '../frame';
import { cleanCols, decodeText, parseCsvFrame, readCsv } from '../io';
import { fillAll } from '../stages/common';
import { frameToCsv, toCsv, writeAtomic } from './files';
import { bytesOf, Call, HttpError, Log, send, sendRetry, sleep } from './http';

/*
 * Amazon Selling Partner API connector (port of intransit-service/intransit/sources/amazon.py).
 *   Amazon_SOH.csv <- Reports API, GET_LEDGER_SUMMARY_VIEW_DATA, one day, aggregated by fulfilment centre
 *   Amazon_GRN.csv <- Fulfillment Inbound API v0: getShipments (status) + getShipmentItemsByShipmentId (sum of
 *                     QuantityReceived), for the FBA shipment ids of the Amazon rows of Shipment_Status.csv
 * Credentials: SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET, SPAPI_REFRESH_TOKEN.
 */

const ENDPOINT = 'https://sellingpartnerapi-eu.amazon.com'; // India is served by the EU endpoint
const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const MARKETPLACE_IN = 'A21TJRUUN4KGV';
const DAY_MS = 86400000;
const REPORT_POLL_MS = 30_000;

/** Columns stage inventory reads from Amazon_SOH.csv - checked before writing. */
const SOH_REQUIRED = ['FNSKU', 'MSKU', 'Title', 'Location', 'Disposition', 'Ending Warehouse Balance'];
/** Amazon_GRN.csv layout; stage shipments keys on Shipment ID, reads Status + Units located. */
const GRN_COLUMNS = ['Shipment ID', 'Shipment name', 'Status', 'Units located'];
const FBA_ID = /^FBA[0-9A-Z]+$/;
/**
 * Statuses where Amazon has not received anything yet - their units are 0 without asking (checked on the first live
 * run: 88 of 88 such shipments had 0). CHECKED_IN is deliberately absent: it is at the dock and receiving can start.
 */
const NOTHING_RECEIVED = new Set(['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'CANCELLED', 'DELETED']);
/**
 * API status code -> the wording Seller Central's Shipping Queue shows, which the reference report carries (fix plan
 * W2, 2026-10-19: IN_TRANSIT where the reference says "In transit"). Codes are kept for the rules above; only the
 * Status column written to Amazon_GRN.csv uses the wording. An unknown code is written as Amazon sent it.
 */
const SELLER_CENTRAL_STATUS: Record<string, string> = {
  WORKING: 'Working',
  READY_TO_SHIP: 'Ready to ship',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  CHECKED_IN: 'Checked in',
  RECEIVING: 'Receiving',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  DELETED: 'Deleted',
  ERROR: 'Error',
};
export const sellerCentralStatus = (code: string): string => SELLER_CENTRAL_STATUS[code.toUpperCase()] ?? code;
/**
 * A CLOSED shipment's units are reused from the cache for this long. Amazon can still correct a closed shipment by a
 * few units (seen on the first live run), so entries are re-checked rather than trusted forever.
 */
const CACHE_MAX_AGE_DAYS = 14;
export const AMAZON_CACHE_FILE = 'amazon_grn_closed.csv';
const SHIPMENTS_PER_CALL = 50;
/** Stay at Amazon's ~2 calls/s instead of hitting 429. */
const PACE_MS = 500;

export interface AmazonConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export const AMAZON_KEYS = ['SPAPI_CLIENT_ID', 'SPAPI_CLIENT_SECRET', 'SPAPI_REFRESH_TOKEN'];

/** Minimal SP-API client: LWA token refresh plus retry on throttling. */
export class SpApi {
  private token: string | null = null;
  private expires = 0;

  constructor(private readonly cfg: Required<AmazonConfig>) {}

  async login(): Promise<string> {
    if (this.token && Date.now() < this.expires - 60_000) return this.token;
    const res = await send(TOKEN_URL, {
      form: { grant_type: 'refresh_token', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.cfg.refreshToken },
    });
    // e.g. invalid_client (id/secret) or invalid_grant (refresh token)
    if (!res.ok) throw new HttpError(res.status, `login failed, ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = body.access_token;
    this.expires = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  async call<T>(method: string, apiPath: string, extra: Pick<Call, 'query' | 'json'> = {}): Promise<T> {
    const res = await sendRetry(`${ENDPOINT}${apiPath}`, async () => ({ method, ...extra, headers: { 'x-amz-access-token': await this.login() } }), `${method} ${apiPath}`);
    return (await res.json()) as T;
  }

  async download(url: string): Promise<Uint8Array> {
    return bytesOf(await sendRetry(url, () => ({ timeoutMs: 300_000 }), 'Amazon report download'));
  }
}

// ---- Amazon_SOH ------------------------------------------------------------------------------------------------

/** Request a report, wait for it, return it as text columns (null = no data). */
const downloadReport = async (api: SpApi, reportType: string, start: string, end: string, options: Record<string, string>, log: Log): Promise<Frame | null> => {
  const { reportId: rid } = await api.call<{ reportId: string }>('POST', '/reports/2021-06-30/reports', {
    json: { reportType, marketplaceIds: [MARKETPLACE_IN], dataStartTime: start, dataEndTime: end, reportOptions: options },
  });
  log(`  report ${rid} requested (${start.slice(0, 10)})`);
  let rep: { processingStatus: string; reportDocumentId?: string };
  for (;;) {
    rep = await api.call('GET', `/reports/2021-06-30/reports/${rid}`);
    if (rep.processingStatus === 'DONE') break;
    if (rep.processingStatus === 'CANCELLED') return null; // Amazon cancels a report that has no data
    if (rep.processingStatus === 'FATAL') throw new Error(`report ${rid} failed (FATAL)`);
    await sleep(REPORT_POLL_MS);
  }
  const doc = await api.call<{ url: string; compressionAlgorithm?: string }>('GET', `/reports/2021-06-30/documents/${rep.reportDocumentId}`);
  let raw = await api.download(doc.url);
  if (doc.compressionAlgorithm === 'GZIP') raw = gunzipSync(raw);
  return fillAll(cleanCols(parseCsvFrame(decodeText(raw), reportType, '\t')), '');
};

/** "10/14/2026" or "2026-10-14" -> epoch ms (null when unreadable); pandas reads the ledger's Date month-first. */
const ledgerDate = (v: string): number | null => {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/**
 * Latest complete day of the FBA inventory ledger, per fulfilment centre (the day before `asOf` first - default
 * today, UTC - as the day itself is not complete).
 */
const fetchSoh = async (api: SpApi, log: Log, asOf?: string, maxDaysBack = 4): Promise<[Frame, string]> => {
  const today = Date.parse(asOf ?? new Date().toISOString().slice(0, 10));
  for (let back = 1; back <= maxDaysBack; back++) {
    const day = new Date(today - back * DAY_MS).toISOString().slice(0, 10);
    let df = await downloadReport(api, 'GET_LEDGER_SUMMARY_VIEW_DATA', `${day}T00:00:00+00:00`, `${day}T23:59:59+00:00`, {
      aggregateByLocation: 'FC',
      aggregatedByTimePeriod: 'DAILY',
    }, log);
    if (!df || df.empty) {
      log(`  no ledger data for ${day}, trying the day before`);
      continue;
    }
    const missing = SOH_REQUIRED.filter((c) => !df?.has(c));
    if (missing.length) throw new Error(`ledger report is missing columns [${missing.join(', ')}]; got [${df.columns.join(', ')}]`);
    // Stage inventory sums Ending Warehouse Balance per SKU and location, so exactly one day may be present.
    if (df.has('Date')) {
      const d = (df.get('Date') as string[]).map(ledgerDate);
      const max = Math.max(...d.filter((x): x is number => x !== null));
      df = df.filter(d.map((x) => x === max));
    }
    return [df, day];
  }
  throw new Error(`no ledger data in the last ${maxDaysBack} days`);
};

// ---- Amazon_GRN ------------------------------------------------------------------------------------------------

/** FBA shipment IDs of the Amazon rows - the keys stage shipments looks up. */
const shipmentIds = (status: Frame, log: Log): string[] => {
  const channel = stripText(status.get('Channel'));
  const po = stripText(status.get('PO Number'));
  const ids = new Set(po.filter((_, i) => channel[i].toLowerCase() === 'amazon').map((p) => p.toUpperCase()));
  ids.delete('');
  const valid = [...ids].filter((i) => FBA_ID.test(i)).sort();
  const skipped = [...ids].filter((i) => !FBA_ID.test(i)).sort();
  log(`  Amazon PO Numbers: ${ids.size} -> ${valid.length} FBA shipment IDs${skipped.length ? ` (skipped ${skipped.length} not shaped like an FBA ID, e.g. ${skipped.slice(0, 3).join(', ')})` : ''}`);
  return valid;
};

const unitsReceived = async (api: SpApi, shipmentId: string, log: Log): Promise<number> => {
  const { payload } = await api.call<{ payload: { NextToken?: string; ItemData?: { QuantityReceived?: number }[] } }>(
    'GET', `/fba/inbound/v0/shipments/${shipmentId}/items`, { query: { MarketplaceId: MARKETPLACE_IN } },
  );
  if (payload.NextToken) log(`  WARNING ${shipmentId}: more item pages than fetched - units may be understated`);
  return (payload.ItemData ?? []).reduce((t, it) => t + Math.trunc(Number(it.QuantityReceived ?? 0) || 0), 0);
};

type Cache = Map<string, [number, string]>;
type ShipmentsPage = { payload: { NextToken?: string; ShipmentData?: { ShipmentId: string; ShipmentName?: string; ShipmentStatus?: string }[] } };

/** Shipment ID -> [units received, date fetched] for CLOSED shipments. */
const loadClosedCache = async (file: string): Promise<Cache> => {
  if (!fs.existsSync(file)) return new Map();
  const df = fillAll(await readCsv(file), '');
  const ids = df.get('Shipment ID') as string[];
  return new Map(ids.map((id, i) => [id, [Number(df.get('Units located')[i]), df.get('Fetched on')[i] as string]]));
};

const saveClosedCache = (cache: Cache, file: string): Promise<void> =>
  writeAtomic(file, toCsv([['Shipment ID', 'Units located', 'Fetched on'], ...[...cache].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, [u, d]]) => [k, String(u), d])]));

/**
 * Status + units received per shipment, in Amazon_GRN.csv's columns. Units are only requested where they can be
 * non-zero and are not already known: shipments in NOTHING_RECEIVED get 0, CLOSED shipments come from the cache while
 * younger than CACHE_MAX_AGE_DAYS. Newly fetched CLOSED shipments are added to the cache (the caller saves it).
 */
const fetchGrn = async (api: SpApi, ids: string[], cache: Cache, log: Log): Promise<Frame> => {
  const today = new Date().toISOString().slice(0, 10);
  const rows: { id: string; name: string; status: string; units?: number }[] = [];
  for (let i = 0; i < ids.length; i += SHIPMENTS_PER_CALL) {
    let query: Call['query'] = { MarketplaceId: MARKETPLACE_IN, QueryType: 'SHIPMENT', ShipmentIdList: ids.slice(i, i + SHIPMENTS_PER_CALL).join(',') };
    for (;;) {
      const page: ShipmentsPage = await api.call<ShipmentsPage>('GET', '/fba/inbound/v0/shipments', { query });
      const payload = page.payload;
      for (const s of payload.ShipmentData ?? []) rows.push({ id: s.ShipmentId, name: s.ShipmentName ?? '', status: s.ShipmentStatus ?? '' });
      if (!payload.NextToken) break;
      query = { MarketplaceId: MARKETPLACE_IN, QueryType: 'NEXT_TOKEN', NextToken: payload.NextToken };
    }
  }
  log(`  shipments returned: ${rows.length} of ${ids.length} requested`);

  const toFetch: typeof rows = [];
  let nNone = 0;
  let nCached = 0;
  for (const r of rows) {
    const status = r.status.toUpperCase();
    const hit = status === 'CLOSED' ? cache.get(r.id) : undefined;
    if (NOTHING_RECEIVED.has(status)) {
      r.units = 0;
      nNone++;
    } else if (hit && (Date.parse(today) - Date.parse(hit[1])) / DAY_MS < CACHE_MAX_AGE_DAYS) {
      r.units = hit[0];
      nCached++;
    } else toFetch.push(r);
  }
  log(`  units: ${toFetch.length} to fetch | ${nCached} closed, reused from cache | ${nNone} not received yet (0)`);

  for (let n = 1; n <= toFetch.length; n++) {
    const r = toFetch[n - 1];
    if (n > 1) await sleep(PACE_MS);
    r.units = await unitsReceived(api, r.id, log);
    if (r.status.toUpperCase() === 'CLOSED') cache.set(r.id, [r.units, today]);
    if (n % 100 === 0) log(`  ... units fetched for ${n}/${toFetch.length} shipments`);
  }
  return Frame.fromRows(GRN_COLUMNS, rows.map((r) => [r.id, r.name, sellerCentralStatus(r.status), r.units ?? 0]));
};

// ---- entry points ----------------------------------------------------------------------------------------------

/** One read-only call per API the connector uses; nothing is created. */
const ACCESS_PROBES: [string, string, Call['query']][] = [
  ['Reports API (FBA inventory ledger)', '/reports/2021-06-30/reports', { reportTypes: 'GET_LEDGER_SUMMARY_VIEW_DATA', pageSize: 1 }],
  ['Fulfillment Inbound API (shipments)', '/fba/inbound/v0/shipments', { MarketplaceId: MARKETPLACE_IN, QueryType: 'SHIPMENT', ShipmentStatusList: 'CLOSED' }],
];

/** Login + permission check; throws if any API is refused. */
export const checkAmazon = async (cfg: AmazonConfig, log: Log): Promise<void> => {
  const api = new SpApi(requireConfig(cfg));
  await api.login();
  log('Amazon login: OK');
  const failures: string[] = [];
  for (const [name, apiPath, query] of ACCESS_PROBES) {
    try {
      await api.call('GET', apiPath, { query });
      log(`${name}: OK`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(name);
      log(`${name}: FAILED - ${msg}`);
    }
  }
  if (failures.length) throw new Error(`no access to ${failures.join(', ')}`);
};

/**
 * Writes Amazon_SOH.csv and/or Amazon_GRN.csv into outDir. GRN reads Shipment_Status.csv from inputDir and keeps
 * its closed-shipment cache in cacheDir. Returns the file names written.
 */
export const fetchAmazon = async (
  cfg: AmazonConfig,
  dirs: { inputDir: string; outDir: string; cacheDir: string },
  log: Log,
  opts: { only?: 'soh' | 'grn'; refreshCache?: boolean; asOf?: string } = {},
): Promise<string[]> => {
  const api = new SpApi(requireConfig(cfg));
  const statusCsv = path.join(dirs.inputDir, 'Shipment_Status.csv');
  // fail before the slow report, not after
  if (opts.only !== 'soh' && !fs.existsSync(statusCsv)) throw new Error('Shipment_Status.csv is needed for Amazon_GRN: upload it first');
  const written: string[] = [];

  if (opts.only !== 'grn') {
    log('Amazon_SOH: requesting the FBA inventory ledger ...');
    const [soh, day] = await fetchSoh(api, log, opts.asOf);
    await writeAtomic(path.join(dirs.outDir, 'Amazon_SOH.csv'), frameToCsv(soh));
    log(`Amazon_SOH.csv: ${soh.length} rows for ${day}`);
    written.push('Amazon_SOH.csv');
  }
  if (opts.only !== 'soh') {
    log('Amazon_GRN: fetching inbound shipments ...');
    const status = fillAll(cleanCols(await readCsv(statusCsv)), '');
    const cacheFile = path.join(dirs.cacheDir, AMAZON_CACHE_FILE);
    const cache = opts.refreshCache ? new Map() : await loadClosedCache(cacheFile);
    const grn = await fetchGrn(api, shipmentIds(status, log), cache, log);
    await saveClosedCache(cache, cacheFile);
    await writeAtomic(path.join(dirs.outDir, 'Amazon_GRN.csv'), frameToCsv(grn));
    log(`Amazon_GRN.csv: ${grn.length} shipments`);
    written.push('Amazon_GRN.csv');
  }
  return written;
};

const requireConfig = (cfg: AmazonConfig): Required<AmazonConfig> => {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) throw new Error(`fill in ${AMAZON_KEYS.join(', ')} in .env`);
  return cfg as Required<AmazonConfig>;
};
