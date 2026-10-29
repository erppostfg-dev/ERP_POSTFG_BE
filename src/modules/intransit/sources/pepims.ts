import path from 'path';
import { DataSource } from 'typeorm';
import { PEPIMS_DATABASE, PEPIMS_PO_FORMAT_COLUMNS, PEPIMS_SHIPMENT_STATUS_COLUMNS, PEPIMS_TRACKER_DAYS } from '../../../constants';
import { Log } from './http';
import { writeAtomic } from './files';

/*
 * Shipment_Status.csv and PO_Format.csv read from PEPIMS's own tracker (mcaff_inv.shipment_orders / sku_orders) instead
 * of being uploaded (user, 2026-10-22/23): the POs whose Entry Date falls in the `days` days ending with the report's
 * day, every column as PEPIMS's export writes it (constants/intransit-pepims.ts). Read only, inside START TRANSACTION
 * READ ONLY, with the app's database login (as masters:load reads PEPIMS's masters).
 * Output as the uploads: LF line ends, no BOM, Shipment_Status by UID descending, PO_Format by UID descending then
 * Sr No; dates YYYY-MM-DD; decimals without trailing zeros.
 */

export interface PepimsLogin {
  host: string;
  port: number;
  username: string;
  password: string;
}

export const PEPIMS_FILES = { SHIPMENT_STATUS: 'Shipment_Status.csv', PO_FORMAT: 'PO_Format.csv' } as const;

const DAY_MS = 86_400_000;

/**
 * The first day of the window: `days` days before asOf - the same day the report's own start date cuts at
 * (context.ts resolveFromDate, INTRANSIT_FROM_DATE=90), so every PO the report keeps is read.
 */
export const windowStart = (asOf: string, days: number): string => new Date(Date.parse(`${asOf}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

/** A cell as the upload writes it: blank for null, decimals without trailing zeros ("3.400" -> "3.4", "48768.00" -> "48768"). */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /^-?\d+\.\d+$/.test(s) ? String(Number(s)) : s;
};
const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const toCsv = (rows: string[][]): string => `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;

/** The value of a column spec (po.<col> | line.<col> | sum.<col> | '') for one PO (and line). */
const valueOf = (spec: string, po: Record<string, unknown>, line?: Record<string, unknown>): string => {
  if (!spec) return '';
  const [src, col] = spec.split('.');
  if (src === 'po') return cell(po[col]);
  if (src === 'sum') return cell(po[`sum_${col}`]);
  return cell(line?.[col]);
};

/** Run `fn` against PEPIMS in a read-only transaction. */
const withPepims = async <T>(login: PepimsLogin, fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> => {
  const ds = new DataSource({
    type: 'mysql', host: login.host, port: login.port, username: login.username, password: login.password, database: PEPIMS_DATABASE,
    synchronize: false, entities: [], dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
  });
  await ds.initialize();
  const qr = ds.createQueryRunner();
  try {
    await qr.query('START TRANSACTION READ ONLY');
    return await fn((sql, params) => qr.query(sql, params) as Promise<Record<string, unknown>[]>);
  } finally {
    await qr.query('ROLLBACK').catch(() => undefined);
    await qr.release();
    await ds.destroy();
  }
};

export interface PepimsTrackerResult {
  files: string[];
  from: string;
  to: string;
  pos: number;
  lines: number;
}

/** Write Shipment_Status.csv and PO_Format.csv for the window ending `asOf` into outDir. */
export const fetchPepimsTracker = async (login: PepimsLogin, outDir: string, asOf: string, log: Log, days = PEPIMS_TRACKER_DAYS): Promise<PepimsTrackerResult> => {
  const from = windowStart(asOf, days);
  log(`PEPIMS: POs with Entry Date ${from} .. ${asOf} (${days} days)`);
  const [pos, lines] = await withPepims(login, async (q) => {
    const p = await q(
      `SELECT o.*, s.sum_updatedQty, s.sum_updatedGmv, s.sum_updatedPoValue
       FROM shipment_orders o
       LEFT JOIN (SELECT shipmentOrderId, SUM(updatedQty) sum_updatedQty, SUM(updatedGmv) sum_updatedGmv, SUM(updatedPoValue) sum_updatedPoValue
                  FROM sku_orders GROUP BY shipmentOrderId) s ON s.shipmentOrderId = o.uid
       WHERE o.entryDate BETWEEN ? AND ? ORDER BY o.uid DESC`, [from, asOf]);
    const l = await q(
      `SELECT s.*, o.uid po_uid FROM sku_orders s JOIN shipment_orders o ON o.uid = s.shipmentOrderId
       WHERE o.entryDate BETWEEN ? AND ? ORDER BY o.uid DESC, CAST(s.srNo AS UNSIGNED), s.srNo, s.id`, [from, asOf]);
    return [p, l] as const;
  });
  const poBy = new Map(pos.map((p) => [String(p.uid), p]));

  const ss = [PEPIMS_SHIPMENT_STATUS_COLUMNS.map(([h]) => h), ...pos.map((p) => PEPIMS_SHIPMENT_STATUS_COLUMNS.map(([, spec]) => valueOf(spec, p)))];
  const pf = [PEPIMS_PO_FORMAT_COLUMNS.map(([h]) => h), ...lines.map((l) => {
    const p = poBy.get(String(l.po_uid)) as Record<string, unknown>;
    return PEPIMS_PO_FORMAT_COLUMNS.map(([, spec]) => valueOf(spec, p, l));
  })];
  await writeAtomic(path.join(outDir, PEPIMS_FILES.SHIPMENT_STATUS), toCsv(ss));
  await writeAtomic(path.join(outDir, PEPIMS_FILES.PO_FORMAT), toCsv(pf));
  log(`PEPIMS: ${PEPIMS_FILES.SHIPMENT_STATUS} ${pos.length} POs, ${PEPIMS_FILES.PO_FORMAT} ${lines.length} lines`);
  return { files: [PEPIMS_FILES.SHIPMENT_STATUS, PEPIMS_FILES.PO_FORMAT], from, to: asOf, pos: pos.length, lines: lines.length };
};
