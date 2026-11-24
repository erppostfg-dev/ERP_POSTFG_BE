import { In } from 'typeorm';
import type { Readable } from 'stream';
import { AppDataSource } from '../../config/data-source';
import { BULK_STOCK, ERROR_CODES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { BulkOrderLine } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { getSnapshot, snapshotFile } from '../intransit/snapshot.service';
import { readRows } from '../intransit/sources/files';
import { isId } from './bulk-orders.service';

/*
 * Stock on the approval screen (2026-11-24, user "work on this too"; backlog M5.4): per SKU of an order, the units ON
 * HAND at the mother warehouses (GGN / MUM / KOL) from the newest in-transit report's Daily Snapshot (sheet Sheet35(2):
 * Channel type GGNMWH / MUMMWH / KOLMWH, Stock Type SOH, Final Units). READ ONLY on the in-transit data (Ajay's module:
 * nothing there changes). The sheet (~2.5 MB) is read once per new snapshot (cached by its etag), never per order.
 * Combos are split into their items in that report: a combo code shows no figure ("not in the report").
 */

type Stock = Record<string, number>;
let cache: { etag: string; asOf: string; stock: Map<string, Stock> } | null = null;

const toBuffer = async (s: Readable): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(parts);
};

/** Units on hand per SKU (upper case) per mother warehouse, + the report day; empty when there is no report. */
export const motherWarehouseStock = async (): Promise<{ asOf: string | null; stock: Map<string, Stock> }> => {
  const view = await getSnapshot(undefined);
  const f = view.files.find((x) => x.name === BULK_STOCK.SHEET);
  if (!f || !view.shown) return { asOf: null, stock: new Map() };
  if (cache?.etag === f.etag) return cache;
  const { body } = await snapshotFile(f.key);
  if (!body) return cache ?? { asOf: null, stock: new Map() };
  const rows = readRows(new Uint8Array(await toBuffer(body)));
  const head = (rows[0] ?? []).map((h) => h.trim());
  const at = (name: string) => head.indexOf(name);
  const [iSku, iType, iStock, iUnits] = [at(BULK_STOCK.COL_SKU), at(BULK_STOCK.COL_TYPE), at(BULK_STOCK.COL_STOCK_TYPE), at(BULK_STOCK.COL_UNITS)];
  if ([iSku, iType, iStock, iUnits].some((i) => i < 0)) throw new Error(`${BULK_STOCK.SHEET}: columns changed (found ${head.join(', ')})`);
  const stock = new Map<string, Stock>();
  for (const r of rows.slice(1)) {
    const wh = BULK_STOCK.WAREHOUSES[(r[iType] ?? '').trim()];
    if (!wh || (r[iStock] ?? '').trim() !== BULK_STOCK.ON_HAND) continue;
    const k = (r[iSku] ?? '').trim().toUpperCase();
    if (!k) continue;
    const s = stock.get(k) ?? {};
    s[wh] = (s[wh] ?? 0) + (Number(r[iUnits]) || 0);
    stock.set(k, s);
  }
  cache = { etag: f.etag, asOf: view.shown.day, stock };
  return cache;
};

/**
 * One order's lines with the mother warehouses' stock (the callers check access). Never fails the screen: no report /
 * S3 problem = { asOf: null, note } and no figures.
 */
export const bulkOrderStock = async (id: string) => {
  if (!isId(id)) throw appError(ERROR_CODES.BULK_ORDER_NOT_FOUND, String(id));
  const lines = await AppDataSource.getRepository(BulkOrderLine).find({ select: { pepCode: true }, where: { orderId: In([id]) } });
  const codes = [...new Set(lines.map((l) => l.pepCode))];
  try {
    const { asOf, stock } = await motherWarehouseStock();
    return {
      asOf, warehouses: Object.values(BULK_STOCK.WAREHOUSES), note: asOf ? null : BULK_STOCK.NO_REPORT,
      skus: Object.fromEntries(codes.map((c) => [c, stock.get(c.toUpperCase()) ?? null])),
    };
  } catch (err) {
    logError(LOG_SOURCE.APP, `[bulk-orders] stock for order ${id} not read (screen shows none)`, err);
    return { asOf: null, warehouses: Object.values(BULK_STOCK.WAREHOUSES), note: BULK_STOCK.NO_REPORT, skus: Object.fromEntries(codes.map((c) => [c, null])) };
  }
};
