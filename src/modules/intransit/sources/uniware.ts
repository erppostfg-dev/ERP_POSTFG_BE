import path from 'path';
import { FACILITY_GROUPS, IST_OFFSET_MS, UNIWARE_EXPORTS, UniwareExport } from '../../../constants';
import { parseDeliveryDate } from '../stages/shipments';
import { readRows, toCsv, unpack, writeAtomic } from './files';
import { bytesOf, HttpError, Log, send, sendRetry, sleep, throttled } from './http';

/*
 * Uniware (Unicommerce) connector (port of intransit-service/intransit/sources/uniware.py): the three Uniware input
 * files via the export-job API, the same exports the dashboard runs (Dashboard > Other Reports > Export).
 *   b2b       -> Export-B2B Sale Orders.csv
 *   po        -> Purchase_Order.csv
 *   inventory -> Export-Inventory Snapshot.csv
 * Every one of these exports is per facility (an export run with Facility A holds only facility A's rows), so each
 * runs once per facility marked for it (master_facilities.uniware_export, given in cfg.facilities by the parent) and the
 * parts are combined into one file. What to export lives in constants/intransit-uniware-exports.ts; credentials in .env
 * (UNIWARE_*).
 */

const CREATE_PATH = '/services/rest/v1/export/job/create';
const STATUS_PATH = '/services/rest/v1/export/job/status';
const FACILITY_SEARCH_PATH = '/services/rest/v1/facility/search';
const DONE_STATUSES = new Set(['SUCCESSFUL', 'COMPLETE', 'COMPLETED']);
const FAILED_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED']);
/**
 * When a running export job is asked for its status: first after FIRST_POLL_MS, then every POLL_MS (was every 20 s).
 * Measured 19-Oct: Uniware has each export (even 52k B2B rows) ready in under 10 s.
 */
const FIRST_POLL_MS = 3_000;
const POLL_MS = 5_000;
const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DAY_MS = 86400000;

/** Columns the pipeline stages read from each file. A download missing any of these is refused. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  b2b: ['Sale Order Code', 'Display Order Code', 'Item SKU Code', 'Channel Product ID', 'Sale Order Status', 'Total Quantity',
    'Unallocated Quantity', 'Unfulfillable Quantity', 'Allocated Quantity', 'Cancelled Quantity', 'In Process Quantity', 'Complete Quantity'],
  po: ['PO Code', 'Created', 'Delivery Date', 'Item Type Name', 'Item SkuCode', 'Order Quantity', 'Recieved Quantity', 'Facility', 'Total',
    'Purchase Order Status', 'Reference No', 'ReferenceOrder'],
  inventory: ['Facility', 'Item Type Name', 'Item SkuCode', 'Open Sale', 'Inventory', 'Putaway Pending', 'Stock In Transfer', 'Open Purchase'],
};
export const UNIWARE_EXPORT_KEYS = Object.keys(REQUIRED_COLUMNS);

export interface UniwareConfig {
  tenant?: string;
  username?: string;
  password?: string;
  facilities: string[];
  parallel: number;
}

/** The .env keys the Uniware connector needs (the facilities come from master_facilities.uniware_export). */
export const UNIWARE_KEYS = ['UNIWARE_TENANT', 'UNIWARE_USERNAME', 'UNIWARE_PASSWORD'];

/** https://<tenant>.unicommerce.com from either the bare tenant name or the address copied from the browser. */
export const tenantBase = (tenant: string): string => {
  let host = tenant.trim();
  if (host.includes('://')) host = host.split('://', 2)[1];
  host = host.split('/', 1)[0];
  return host.includes('.') ? `https://${host}` : `https://${host}.unicommerce.com`;
};

/** Minimal Uniware client: OAuth password grant + JSON POSTs with retry on 429. */
export class UniwareApi {
  readonly base: string;
  private token: string | null = null;
  private expires = 0;
  private loggingIn: Promise<string> | null = null;

  constructor(private readonly cfg: Required<Omit<UniwareConfig, 'facilities' | 'parallel'>>) {
    this.base = tenantBase(cfg.tenant);
  }

  /**
   * A token, logging in when there is none. Parallel callers share one login: Uniware fails ("Internal Error ...
   * ConstraintViolationException", seen 2026-10-25) when several logins of one user run at the same moment.
   */
  login(): Promise<string> {
    if (this.token && Date.now() < this.expires - 60_000) return Promise.resolve(this.token);
    this.loggingIn ??= this.freshLogin().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async freshLogin(): Promise<string> {
    // Uniware's documented login sends the username and password in the query: never log this URL.
    const res = await send(`${this.base}/oauth/token`, {
      query: { grant_type: 'password', client_id: 'my-trusted-client', username: this.cfg.username, password: this.cfg.password },
    });
    if (!res.ok) throw new HttpError(res.status, `login failed, ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = body.access_token;
    this.expires = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async post<T extends Record<string, unknown>>(apiPath: string, payload: unknown, facility?: string): Promise<T> {
    const res = await sendRetry(`${this.base}${apiPath}`, async () => ({
      method: 'POST',
      json: payload,
      headers: { Authorization: `bearer ${await this.login()}`, ...(facility ? { Facility: facility } : {}) },
    }), apiPath);
    const body = (await res.json()) as T & { successful?: boolean; errors?: unknown; message?: string };
    // Uniware reports errors in a 200
    if (body.successful === false) throw new Error(`${apiPath} refused: ${JSON.stringify(body.errors ?? body.message)}`);
    return body;
  }

  /** The bearer token only ever goes back to this tenant, never to a storage host. */
  async download(url: string): Promise<Uint8Array> {
    const full = url.startsWith('http') ? url : `${this.base}${url}`;
    const sameHost = new URL(full).host === new URL(this.base).host;
    const res = await sendRetry(full, async () => ({
      headers: sameHost ? { Authorization: `bearer ${await this.login()}` } : ({} as Record<string, string>),
      timeoutMs: 600_000,
    }), 'Uniware export download');
    return bytesOf(res);
  }
}

// ---- facilities ------------------------------------------------------------------------------------------------

/** Codes of the enabled facilities this user can access. */
const searchFacilities = async (api: UniwareApi): Promise<string[]> => {
  const body = await api.post<{ parties?: { facilityCode?: string }[] }>(FACILITY_SEARCH_PATH, {
    facilityStatus: 'ENABLED',
    dateType: 'CREATED',
    fromDate: '2010-01-01T00:00:00.000Z',
    toDate: '2100-01-01T00:00:00.000Z',
  });
  return (body.parties ?? []).map((p) => p.facilityCode).filter((c): c is string => !!c);
};

/** The listed facilities Uniware knows (in its spelling); warns about the rest and about stock facilities not listed. */
const resolveFacilities = (listed: string[], known: string[], log: Log): string[] => {
  const byLower = new Map(known.map((k) => [k.toLowerCase(), k]));
  const usable = listed.filter((f) => byLower.has(f.toLowerCase())).map((f) => byLower.get(f.toLowerCase()) as string);
  const unknown = listed.filter((f) => !byLower.has(f.toLowerCase()));
  if (unknown.length) log(`  WARNING skipping facilities Uniware does not return for this user: ${unknown.join(', ')}`);
  const listedLower = new Set(listed.map((f) => f.toLowerCase()));
  const notListed = FACILITY_GROUPS.flatMap(([, , facs]) => facs).filter((f) => !listedLower.has(f.toLowerCase()));
  if (notListed.length) {
    log(`  NOTE: ${notListed.length} facilities the pipeline counts stock for are not marked for the Uniware export (master_facilities.uniware_export), so their rows will not be exported: ${notListed.join(', ')}`);
  }
  return usable;
};

// ---- export jobs -----------------------------------------------------------------------------------------------

/**
 * Copy of the payload whose date-range filters cover whole days in IST: from `days` days ago 00:00 to today
 * 23:59:59.999, as epoch milliseconds - the form Uniware's own export screen sends.
 */
const withRollingWindow = (payload: UniwareExport['payload'], days: number | null | undefined, nowMs: number): UniwareExport['payload'] => {
  const copy = JSON.parse(JSON.stringify(payload)) as UniwareExport['payload'];
  if (!days) return copy;
  const istMidnight = Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  const start = istMidnight - days * DAY_MS;
  const end = istMidnight + DAY_MS - 1;
  for (const f of copy.exportFilters ?? []) if (f.dateRange) f.dateRange = { start, end };
  return copy;
};

/** Uniware requires 'frequency'; each run asks for a single, unscheduled export. */
const createJob = async (api: UniwareApi, payload: UniwareExport['payload'], facility: string): Promise<string> =>
  (await api.post<{ jobCode: string }>(CREATE_PATH, { frequency: 'ONETIME', ...payload }, facility)).jobCode;

/** Poll until the export is ready; returns its download path. */
const waitForJob = async (api: UniwareApi, jobCode: string, facility: string): Promise<string> => {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  await sleep(FIRST_POLL_MS);
  for (;;) {
    const body = await api.post<{ status?: string; filePath?: string; message?: string }>(STATUS_PATH, { jobCode }, facility);
    const status = String(body.status ?? '').toUpperCase();
    if (DONE_STATUSES.has(status) && body.filePath) return body.filePath;
    if (FAILED_STATUSES.has(status)) throw new Error(`export job ${jobCode} ended as ${status}: ${body.message ?? ''}`);
    if (Date.now() > deadline) throw new Error(`export job ${jobCode} still ${status} after ${JOB_TIMEOUT_MS / 60000} min`);
    await sleep(POLL_MS);
  }
};

/** `expected` = the column names the file should have; a missing pipeline column is an error, other differences warn. */
const checkHeader = (key: string, rawHeader: string[], expectedRaw: string[], where: string, log: Log): void => {
  const header = rawHeader.map((c) => c.trim());
  const missingRequired = REQUIRED_COLUMNS[key].filter((c) => !header.includes(c));
  if (missingRequired.length) throw new Error(`${key}${where}: export is missing columns the pipeline needs: ${missingRequired.join(', ')}`);
  const expected = expectedRaw.map((c) => c.trim());
  const missing = expected.filter((c) => !header.includes(c));
  const extra = header.filter((c) => !expected.includes(c));
  if (expected.length && (missing.length || extra.length)) {
    log(`  WARNING ${key}${where}: columns differ from the expected header - missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'}`);
  }
};

/**
 * One table from the per-facility parts: one header, every data row. A row already delivered by an earlier
 * facility's export is the same record returned twice, so it is kept once (duplicates within one part are kept,
 * exactly as a single export delivers them).
 */
const combine = (key: string, parts: [string, string[][]][], log: Log): string[][] => {
  const header = parts[0][1][0];
  const headerKey = header.map((c) => c.trim()).join('\u0001');
  const seen = new Set<string>();
  const rows = [header];
  let dropped = 0;
  for (const [facility, table] of parts) {
    if (table[0].map((c) => c.trim()).join('\u0001') !== headerKey) throw new Error(`${key}: ${facility} returned different columns than ${parts[0][0]}`);
    const partRows = table.slice(1).filter((r) => r.some((c) => c.trim()));
    const partKeys = partRows.map((r) => r.join('\u0001'));
    partRows.forEach((r, i) => {
      if (seen.has(partKeys[i])) dropped++;
      else rows.push(r);
    });
    for (const k of partKeys) seen.add(k);
  }
  if (dropped) log(`  WARNING ${key}: ${dropped} rows appeared in more than one facility's export - kept once`);
  return rows;
};

/** Warn when the export reaches far before the rolling window - the sign of a date filter Uniware did not apply. */
const checkWindow = (key: string, rows: string[][], column: string, days: number, nowMs: number, log: Log): void => {
  const header = rows[0].map((c) => c.trim());
  const i = header.indexOf(column);
  if (i < 0 || rows.length < 2) return;
  const dates = rows.slice(1).map((r) => parseDeliveryDate((r[i] ?? '').trim())).filter((d): d is number => d !== null);
  if (!dates.length) {
    log(`  WARNING ${key}: could not read the dates in '${column}' to check the window`);
    return;
  }
  const oldest = Math.min(...dates);
  const day = new Date(oldest).toISOString().slice(0, 10);
  if (oldest < nowMs + IST_OFFSET_MS - (days + 7) * DAY_MS) {
    log(`  WARNING ${key}: oldest '${column}' is ${day}, well before the last ${days} days - the date filter may not have been applied (check its id in constants/intransit-uniware-exports.ts)`);
  } else log(`  ${key}: date window OK (oldest ${day})`);
};

// ---- item master (catalog) -------------------------------------------------------------------------------------

const ITEM_TYPE_PATH = '/services/rest/v1/catalog/itemType/get';

/** One SKU of Uniware's item master: SIMPLE, or BUNDLE (a combo) with its components. */
export interface UniwareItemType {
  sku: string;
  name: string;
  /** "SIMPLE" | "BUNDLE" (others passed on as Uniware sends them). */
  type: string;
  components: { sku: string; qty: number }[];
}

/** The item type of `sku`, or null when Uniware does not know the SKU. Other errors (login, network) are thrown. */
export const getItemType = async (api: UniwareApi, sku: string): Promise<UniwareItemType | null> => {
  let body: { itemTypeDTO?: { skuCode?: string; name?: string; type?: string; componentItemTypes?: { itemTypeDTO?: { skuCode?: string }; quantity?: number }[] } };
  try {
    body = await api.post(ITEM_TYPE_PATH, { skuCode: sku });
  } catch (err) {
    // an unknown SKU is a "refused" 200 (successful: false); anything else is a real failure
    if (err instanceof Error && err.message.startsWith(`${ITEM_TYPE_PATH} refused`)) return null;
    throw err;
  }
  const dto = body.itemTypeDTO;
  if (!dto) return null;
  return {
    sku: dto.skuCode ?? sku,
    name: dto.name ?? '',
    type: String(dto.type ?? ''),
    components: (dto.componentItemTypes ?? [])
      .map((c) => ({ sku: c.itemTypeDTO?.skuCode ?? '', qty: Number(c.quantity ?? 1) || 1 }))
      .filter((c) => c.sku),
  };
};

/** One SKU of Uniware's item master with the product fields master_skus keeps (Uniware = source of truth, user 2026-10-23). */
export interface UniwareItem extends UniwareItemType {
  enabled: boolean;
  ean: string | null;
  brand: string | null;
  mrp: number | null;
  hsnCode: string | null;
  gstTaxTypeCode: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  weightG: number | null;
  determineExpiryFrom: string | null;
  shelfLife: number | null;
}

/** The full item of `sku`, or null when Uniware does not know the SKU. Other errors (login, network) are thrown. */
export const getItem = async (api: UniwareApi, sku: string): Promise<UniwareItem | null> => {
  type Dto = Record<string, unknown> & { componentItemTypes?: { itemTypeDTO?: { skuCode?: string }; quantity?: number }[] };
  let body: { itemTypeDTO?: Dto };
  try {
    body = await api.post(ITEM_TYPE_PATH, { skuCode: sku });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${ITEM_TYPE_PATH} refused`)) return null;
    throw err;
  }
  const d = body.itemTypeDTO;
  if (!d) return null;
  const str = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
  const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    sku: str(d.skuCode) ?? sku,
    name: str(d.name) ?? '',
    type: String(d.type ?? ''),
    components: (d.componentItemTypes ?? []).map((c) => ({ sku: c.itemTypeDTO?.skuCode ?? '', qty: Number(c.quantity ?? 1) || 1 })).filter((c) => c.sku),
    enabled: d.enabled !== false,
    ean: str(d.ean),
    brand: str(d.brand),
    mrp: num(d.maxRetailPrice),
    hsnCode: str(d.hsnCode),
    gstTaxTypeCode: str(d.gstTaxTypeCode),
    lengthMm: num(d.length),
    widthMm: num(d.width),
    heightMm: num(d.height),
    weightG: num(d.weight),
    determineExpiryFrom: str(d.determineExpiryFrom),
    shelfLife: num(d.shelfLife),
  };
};

/** A logged-in client for item lookups (no facility list needed). */
export const uniwareCatalog = (cfg: UniwareConfig): UniwareApi => {
  if (!cfg.tenant || !cfg.username || !cfg.password) throw new Error(`fill in ${UNIWARE_KEYS.slice(0, 3).join(', ')} in .env`);
  return new UniwareApi({ tenant: cfg.tenant, username: cfg.username, password: cfg.password });
};

// ---- entry points ----------------------------------------------------------------------------------------------

const connect = async (cfg: UniwareConfig, log: Log): Promise<[UniwareApi, string[]]> => {
  if (!cfg.tenant || !cfg.username || !cfg.password) throw new Error(`fill in ${UNIWARE_KEYS.slice(0, 3).join(', ')} in .env`);
  if (!cfg.facilities.length) throw new Error('no facility is marked for the Uniware export: switch uniware_export on in master_facilities');
  const api = new UniwareApi({ tenant: cfg.tenant, username: cfg.username, password: cfg.password });
  return [api, resolveFacilities(cfg.facilities, await searchFacilities(api), log)];
};

/** Login + facility list check. */
export const checkUniware = async (cfg: UniwareConfig, log: Log): Promise<void> => {
  const [, facilities] = await connect(cfg, log);
  log(`Uniware login: OK\nFacilities to export: ${facilities.length} of ${cfg.facilities.length} listed`);
};

/**
 * Run each export once per facility (`parallel` jobs at a time), combine the parts per export, check them, and write
 * one file per export into outDir. Returns the file names written. `asOf` (YYYY-MM-DD, IST): the rolling windows end
 * with that day instead of today (the Inventory Snapshot is always the current stock).
 */
export const fetchUniware = async (cfg: UniwareConfig, outDir: string, log: Log, only?: string[], asOf?: string): Promise<string[]> => {
  const [api, facilities] = await connect(cfg, log);
  if (!facilities.length) throw new Error('none of the facilities marked for the Uniware export (master_facilities.uniware_export) is known to Uniware for this user');
  const keys = only?.length ? only : UNIWARE_EXPORT_KEYS;
  const todayMs = Date.now();
  // noon IST of the day asked for: its IST midnight is the one the windows are built from
  const nowMs = asOf && asOf < new Date(todayMs + IST_OFFSET_MS).toISOString().slice(0, 10) ? Date.parse(`${asOf}T12:00:00+05:30`) : todayMs;
  if (nowMs !== todayMs) log(`  date windows end on ${asOf}`);
  const payloads = Object.fromEntries(keys.map((k) => [k, withRollingWindow(UNIWARE_EXPORTS[k].payload, UNIWARE_EXPORTS[k].rolling_days, nowMs)]));
  // An export limited to the report's stock facilities (Inventory Snapshot) skips the others: their rows are never used.
  const stock = new Set(FACILITY_GROUPS.flatMap(([, , facs]) => facs.map((f) => f.toLowerCase())));
  const facilitiesFor = (k: string): string[] => (UNIWARE_EXPORTS[k].onlyFacilities === 'stock' ? facilities.filter((f) => stock.has(f.toLowerCase())) : facilities);
  const tasks = keys.flatMap((k) => facilitiesFor(k).map((f) => [k, f] as [string, string]));
  const results: (string[][] | undefined)[] = new Array(tasks.length);
  const parallel = Math.max(1, cfg.parallel || 1);
  log(`  ${tasks.length} export jobs (${keys.map((k) => `${k} x ${facilitiesFor(k).length}`).join(', ')}), ${parallel} at a time`);

  // A rolling queue: a new job starts as soon as one finishes (no waiting for the slowest job of a batch).
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      const [k, f] = tasks[i];
      const t0 = Date.now();
      const job = await createJob(api, payloads[k], f);
      const filePath = await waitForJob(api, job, f);
      const t1 = Date.now();
      const table = readRows(unpack(await api.download(filePath)));
      if (!table.length) throw new Error(`${k} / ${f}: export came back empty (not even a header)`);
      checkHeader(k, table[0], UNIWARE_EXPORTS[k].header ?? [], ` / ${f}`, log);
      results[i] = table;
      // where the time goes: Uniware preparing the export vs downloading it
      log(`  ${k} / ${f}: ${table.length - 1} rows (ready in ${Math.round((t1 - t0) / 1000)} s, downloaded in ${Math.round((Date.now() - t1) / 1000)} s)`);
    }
  }));
  // parts in facility order (as before), so the combined file is the same whichever job finished first
  const parts: Record<string, [string, string[][]][]> = Object.fromEntries(keys.map((k) => [k, []]));
  tasks.forEach(([k, f], i) => parts[k].push([f, results[i] as string[][]]));

  if (throttled.count) log(`  Uniware throttled ${throttled.count} request(s) (429); ${throttled.waitedS} s spent waiting before retrying`);

  const written: string[] = [];
  for (const k of keys) {
    const cfgK = UNIWARE_EXPORTS[k];
    const rows = combine(k, parts[k], log);
    if (cfgK.rolling_days && cfgK.date_column) checkWindow(k, rows, cfgK.date_column, cfgK.rolling_days, nowMs, log);
    await writeAtomic(path.join(outDir, cfgK.file), toCsv(rows));
    log(`  ${k}: ${cfgK.file} written (${rows.length - 1} rows from ${parts[k].length} facilities)`);
    written.push(cfgK.file);
  }
  return written;
};
