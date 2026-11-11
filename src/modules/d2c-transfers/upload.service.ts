import { randomUUID } from 'crypto';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { D2C_LIMITS, D2C_S3_UPLOAD_FOLDER, D2C_UPLOAD_COLUMN, D2C_UPLOAD_COLUMNS, D2C_UPLOAD_REQUIRED, ERROR_CODES, SHIPMENT_LOG_SOURCE } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { appError } from '../../utils/AppError';
import { csvCell, csvRecords } from '../../utils/csv';
import { log } from '../../utils/logger';
import { s3UrlOfKey, writeS3File } from '../email-intake/s3-mirror.service';
import { flushChanges } from '../po-overview/po-overview.live';
import { peekReferences, todayIst } from './reference';
import { readSettings } from './settings';
import { Actor, insertTransfers } from './transfers.service';
import { loadMasters, RawRow, validateRows, ValidationOutcome } from './validate';

/*
 * Bulk upload of internal transfers (plan 5.1; PRD: .csv only, at most 2 MB / 5,000 rows, no partial imports):
 *   GET  /template          the header row (PEPIMS's columns + Dispatch Location, Priority, Group, Type, PO Expiry Date,
 *                           Uniware Channel = optional, needed only for a route with 2+ Uniware channels)
 *   POST /uploads/preview   every row checked (validate.ts), grouped into transfers, with the reference IDs the import
 *                           would take now ("may change on save") and canImport
 *   POST /uploads/import    the same file again: re-checked (422 D2C_INVALID on any error), the file kept on S3
 *                           (d2c-transfers/uploads/<yyyy>/<mm>/<batchId>-<name>.csv; S3 off -> no file, a warning),
 *                           then ONE transaction inserts every transfer as a draft (source bulk_csv, one batch id)
 * Ignored columns: PO Number, Sr No, Channel SKU Code, GMV, PO Value (the tool computes them); SKU Name only warns.
 */

export interface UploadFile { originalname: string; buffer: Buffer }

/** "Sr/ No", "sr. no", "SR NO" -> "srno". */
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMN_BY_NORM = new Map(D2C_UPLOAD_COLUMNS.map((c) => [norm(c), c]));

export const templateCsv = (): string => `${D2C_UPLOAD_COLUMNS.map(csvCell).join(',')}\r\n`;

/** The file's rows as RawRow (row = line in the file, header = 1). Refuses a non-CSV, an empty / too big file, missing columns. */
export const parseUpload = (file: UploadFile | undefined): RawRow[] => {
  if (!file) throw appError(ERROR_CODES.D2C_UPLOAD_FILE, `send the .csv file in the "file" field`);
  if (path.extname(file.originalname || '').toLowerCase() !== '.csv') throw appError(ERROR_CODES.D2C_UPLOAD_FILE, `${file.originalname || 'the file'} is not a .csv file`);
  if (file.buffer.length > D2C_LIMITS.UPLOAD_MAX_BYTES) throw appError(ERROR_CODES.D2C_UPLOAD_FILE, `the file is over ${D2C_LIMITS.UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
  const { header, records } = csvRecords(file.buffer.toString('utf8'));
  const columns = new Map<string, string>();
  for (const h of header) {
    const c = COLUMN_BY_NORM.get(norm(h));
    if (c && !columns.has(c)) columns.set(c, h);
  }
  const missing = D2C_UPLOAD_REQUIRED.filter((c) => !columns.has(c));
  if (missing.length) throw appError(ERROR_CODES.D2C_UPLOAD_FILE, `missing column(s): ${missing.join(', ')} (download the template)`);
  if (!records.length) throw appError(ERROR_CODES.D2C_UPLOAD_FILE, 'the file has no rows');
  if (records.length > D2C_LIMITS.UPLOAD_MAX_ROWS) throw appError(ERROR_CODES.D2C_UPLOAD_FILE, `${records.length} rows: at most ${D2C_LIMITS.UPLOAD_MAX_ROWS} per file`);
  const C = D2C_UPLOAD_COLUMN;
  const cell = (r: Record<string, string>, c: string) => {
    const h = columns.get(c);
    return h === undefined ? '' : (r[h] ?? '');
  };
  return records.map((r, i) => ({
    row: i + 2,
    channel: cell(r, C.CHANNEL), location: cell(r, C.LOCATION), poDate: cell(r, C.PO_DATE), sender: cell(r, C.DISPATCH_LOCATION),
    priority: cell(r, C.PRIORITY), group: cell(r, C.GROUP), type: cell(r, C.TYPE), expiry: cell(r, C.PO_EXPIRY_DATE), skuCode: cell(r, C.SKU_CODE),
    skuName: cell(r, C.SKU_NAME), qty: cell(r, C.QTY), uniwareChannel: cell(r, C.UNIWARE_CHANNEL),
  }));
};

const check = async (rows: RawRow[]): Promise<{ outcome: ValidationOutcome; today: string }> => {
  const today = todayIst();
  const settings = await readSettings();
  const masters = await loadMasters(rows.map((r) => r.skuCode), settings, today);
  return { outcome: validateRows(rows, masters), today };
};

/** POST /d2c-transfers/uploads/preview */
export const previewUpload = async (file: UploadFile | undefined) => {
  const rows = parseUpload(file);
  const { outcome, today } = await check(rows);
  const settings = await readSettings();
  const ok = outcome.transfers.filter((t) => t.valid);
  const refs = await peekReferences(ok.map((t) => ({ prefix: t.prefix as string, poDate: t.poDate as string, type: t.type as string })), settings, today);
  const refOf = new Map(ok.map((t, i) => [t.key, refs[i]]));
  return {
    fileName: file?.originalname ?? null,
    rowCount: rows.length,
    canImport: outcome.canImport,
    errorCount: outcome.errorCount,
    warningCount: outcome.warningCount,
    rows: outcome.rows,
    transfers: outcome.transfers.map((t) => ({ ...t, referencePreview: refOf.get(t.key) ?? null })),
  };
};

/** S3 key of an uploaded file: d2c-transfers/uploads/<yyyy>/<mm>/<batchId>-<name>.csv */
export const uploadKey = (batchId: string, name: string, now = new Date()): string => {
  const safe = (path.basename(name || 'upload.csv').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120)) || 'upload.csv';
  return `${D2C_S3_UPLOAD_FOLDER}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${batchId}-${safe}`;
};

/** POST /d2c-transfers/uploads/import: all or nothing. */
export const importUpload = async (file: UploadFile | undefined, by: Actor) => {
  const rows = parseUpload(file);
  const { outcome, today } = await check(rows);
  if (!outcome.canImport) {
    throw appError(ERROR_CODES.D2C_INVALID, outcome.errorCount).withDetails(
      outcome.rows.flatMap((r) => r.errors.map((e) => ({ row: r.row, field: e.field, message: e.message }))),
    );
  }
  const batchId = randomUUID();
  const notices: string[] = [];
  let fileUrl: string | null = null;
  if (env.s3.enabled) {
    fileUrl = s3UrlOfKey(uploadKey(batchId, (file as UploadFile).originalname));
    await writeS3File(fileUrl, (file as UploadFile).buffer);
  } else {
    notices.push('S3 is off on this server: the uploaded file was not kept');
    log.warn(LOG_SOURCE.APP, '[d2c] upload imported without keeping the file (S3 off)', { batchId });
  }
  const created = await AppDataSource.transaction((m) =>
    insertTransfers(m, outcome.transfers, { source: SHIPMENT_LOG_SOURCE.BULK_CSV, batchId, userId: by.id, fileUrl, today }));
  void flushChanges();
  return {
    batchId,
    fileUrl,
    notices,
    transfers: created,
    warnings: outcome.rows.flatMap((r) => r.warnings.map((w) => ({ row: r.row, ...w }))),
  };
};
