import crypto from 'crypto';
import path from 'path';
import { Frame } from '../frame';
import { fileKind, frameToCsv, readReport, writeAtomic } from './files';
import { bytesOf, Log, sendRetry, sleep } from './http';

/*
 * Flipkart Seller API connector (port of intransit-service/intransit/sources/flipkart.py, Reports API).
 *   fetch  FK_SOH.csv from current_inventory_report, in the layout stage inventory reads
 *          (FSN, SKU, Title, Warehouse Id, Live on Website).
 *   probe  download current_inventory_report and one stock_ledger, save them raw and log their columns: run once to
 *          confirm the layout, as Flipkart does not document report columns.
 * FK_GRN.csv has no Flipkart API (consignment GRNs are only in Seller Hub), so it stays a manual upload.
 * Credentials: FLIPKART_APP_ID, FLIPKART_APP_SECRET (a Seller Hub self-access app).
 */

const BASE_URL = 'https://api.flipkart.net';
const TOKEN_PATH = '/oauth-service/oauth/token';
const DAY_MS = 86400000;

/** Columns stage inventory reads from FK_SOH.csv. */
const FK_SOH_REQUIRED = ['FSN', 'SKU', 'Title', 'Warehouse Id', 'Live on Website'];
/**
 * report column -> FK_SOH.csv column. Assumes the report uses the same headers as the manual Seller Hub export; if
 * `probe` shows different names, change the KEYS here (e.g. { 'Seller SKU Id': 'SKU', ... }).
 */
const FK_SOH_COLUMNS: Record<string, string> = Object.fromEntries(FK_SOH_REQUIRED.map((c) => [c, c]));
/** Warehouse ids the Reports API documents for stock_ledger / mir_ledger. */
export const LEDGER_WAREHOUSES = ['bil', 'binola', 'blr_wfld', 'del', 'kol', 'malur_bts', 'ulub_bts', 'mum_bndi'];
const REPORT_POLL_MS = 20_000;
const REPORT_TIMEOUT_MS = 60 * 60 * 1000;

export interface FlipkartConfig {
  appId?: string;
  appSecret?: string;
}

export const FLIPKART_KEYS = ['FLIPKART_APP_ID', 'FLIPKART_APP_SECRET'];

/** Minimal Flipkart Seller API client: client-credentials token + retry on 429. */
export class FlipkartApi {
  private token: string | null = null;
  private expires = 0;

  constructor(private readonly cfg: Required<FlipkartConfig>) {}

  login(): Promise<string> {
    return this.accessToken();
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expires - 60_000) return this.token;
    const basic = Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString('base64');
    const res = await sendRetry(`${BASE_URL}${TOKEN_PATH}`, () => ({
      headers: { Authorization: `Basic ${basic}` },
      query: { grant_type: 'client_credentials', scope: 'Seller_Api' },
    }), 'Flipkart login');
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = body.access_token;
    this.expires = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async call<T>(method: string, apiPath: string, json?: unknown): Promise<T> {
    const res = await sendRetry(`${BASE_URL}${apiPath}`, async () => ({
      method,
      json,
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    }), `${method} ${apiPath}`);
    return (await res.json()) as T;
  }

  /** The link carries its own key; the token only ever goes back to Flipkart's API host. */
  async download(url: string): Promise<Uint8Array> {
    const sameHost = new URL(url).host === new URL(BASE_URL).host;
    const res = await sendRetry(url, async () => ({
      headers: sameHost ? { Authorization: `Bearer ${await this.accessToken()}` } : ({} as Record<string, string>),
      timeoutMs: 300_000,
    }), 'Flipkart report download');
    return bytesOf(res);
  }
}

/** Trigger a report, wait until it completes, and return the downloaded file. */
const runReport = async (api: FlipkartApi, reportType: string, parameters: Record<string, string>, log: Log): Promise<Uint8Array> => {
  const { report_id: rid } = await api.call<{ report_id: string }>('POST', `/reports/${reportType}`, {
    correlation_id: crypto.randomUUID(),
    parameters,
  });
  log(`  ${reportType}: report ${rid} triggered ${JSON.stringify(parameters)}`);
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  for (;;) {
    const detail = await api.call<{ status: string; location: string }>('GET', `/reports/${rid}/detail`);
    if (detail.status === 'COMPLETED') return api.download(detail.location);
    if (detail.status === 'FAILED' || detail.status === 'EXPIRED') throw new Error(`${reportType} report ${rid} ended as ${detail.status}`);
    if (Date.now() > deadline) throw new Error(`${reportType} report ${rid} still ${detail.status} after ${REPORT_TIMEOUT_MS / 60000} min`);
    await sleep(REPORT_POLL_MS);
  }
};

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const inventoryParams = (todayMs: number, days: number): Record<string, string> => ({ from_date: isoDay(todayMs - days * DAY_MS), to_date: isoDay(todayMs) });

/** current_inventory_report -> FK_SOH.csv layout (extra columns are kept). */
const toFkSoh = (report: Frame, log: Log): Frame => {
  const missing = Object.keys(FK_SOH_COLUMNS).filter((c) => !report.has(c));
  if (missing.length) {
    throw new Error(
      `current_inventory_report is missing [${missing.join(', ')}]; it has [${report.columns.join(', ')}]. ` +
        'Run the probe, then map the report\'s names in FK_SOH_COLUMNS (sources/flipkart.ts).',
    );
  }
  const out = report.rename(FK_SOH_COLUMNS);
  const keys = out.keys(['FSN', 'Warehouse Id']);
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const dup = keys.filter((k) => (counts.get(k) ?? 0) > 1).length;
  // Stage inventory adds rows up per SKU and warehouse, so repeated FSN/warehouse rows (e.g. one per day) would
  // overstate the stock.
  if (dup) log(`  WARNING ${dup.toLocaleString('en-US')} rows share an FSN + Warehouse Id - check they are not several days of the same stock before using this file`);
  return out;
};

const todayUtc = (): number => Date.parse(new Date().toISOString().slice(0, 10));

/** Writes FK_SOH.csv into outDir; returns the file names written. */
export const fetchFlipkart = async (cfg: FlipkartConfig, outDir: string, log: Log, days = 1): Promise<string[]> => {
  const api = new FlipkartApi(requireConfig(cfg));
  const raw = await runReport(api, 'current_inventory_report', inventoryParams(todayUtc(), days), log);
  const soh = toFkSoh(readReport(raw), log);
  await writeAtomic(path.join(outDir, 'FK_SOH.csv'), frameToCsv(soh));
  log(`FK_SOH.csv: ${soh.length.toLocaleString('en-US')} rows`);
  return ['FK_SOH.csv'];
};

/** Download both candidate reports, save them raw, and say what they hold. */
export const probeFlipkart = async (cfg: FlipkartConfig, outDir: string, log: Log, warehouse = 'malur_bts', days = 7): Promise<void> => {
  const api = new FlipkartApi(requireConfig(cfg));
  const today = todayUtc();
  const describe = (name: string, df: Frame): void => {
    log(`\n=== ${name}: ${df.length} rows x ${df.columns.length} columns`);
    log(`columns: ${df.columns.join(' | ')}`);
  };

  let raw = await runReport(api, 'current_inventory_report', inventoryParams(today, days), log);
  let file = path.join(outDir, `current_inventory_report.${fileKind(raw)}`);
  await writeAtomic(file, raw);
  const inv = readReport(raw);
  describe(`current_inventory_report (saved to ${file})`, inv);
  const missing = Object.keys(FK_SOH_COLUMNS).filter((c) => !inv.has(c));
  log(`FK_SOH: ${missing.length ? `not found [${missing.join(', ')}] - map them in FK_SOH_COLUMNS` : 'all required columns present - fetch will work as is'}`);

  raw = await runReport(api, 'stock_ledger', { warehouse_id: warehouse, from_date: isoDay(today - days * DAY_MS), to_date: isoDay(today - DAY_MS) }, log);
  file = path.join(outDir, `stock_ledger_${warehouse}.${fileKind(raw)}`);
  await writeAtomic(file, raw);
  const ledger = readReport(raw);
  describe(`stock_ledger ${warehouse} (saved to ${file})`, ledger);
  const consignment = ledger.columns.filter((c) => c.toLowerCase().includes('consign'));
  log(
    `FK_GRN: ${consignment.length
      ? `stock_ledger has [${consignment.join(', ')}] - inward rows may rebuild GRN qty per consignment, but only for the documented warehouses ${LEDGER_WAREHOUSES.join(', ')}`
      : 'stock_ledger has no consignment column - FK_GRN needs a Seller Hub download (manual or RPA)'}`,
  );
};

/** Login check only (gets an access token). */
export const checkFlipkart = async (cfg: FlipkartConfig, log: Log): Promise<void> => {
  await new FlipkartApi(requireConfig(cfg)).login();
  log('Flipkart login: OK');
};

const requireConfig = (cfg: FlipkartConfig): Required<FlipkartConfig> => {
  if (!cfg.appId || !cfg.appSecret) throw new Error(`fill in ${FLIPKART_KEYS.join(', ')} in .env`);
  return cfg as Required<FlipkartConfig>;
};
