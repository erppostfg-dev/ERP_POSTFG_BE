import fs from 'fs/promises';
import path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import {
  BRAND_NAMES,
  ERROR_CODES,
  errorMessage,
  FILES,
  NEW_PO_STATUS,
  PIPELINE_STEP,
  NO_BRAND,
  round2,
  saleOrderCode,
  UNIWARE_CSV,
  UPLOAD_STATUS,
  VALIDATION_STATUS,
} from '../../constants';
import { DetailsPurchaseOrder, MasterPurchaseOrder, PoUpload, SaleOrderCodeCounter } from '../../entities';
import { EmailMetadata } from '../email-intake/s3-layout';
import { syncEmailToS3 } from '../email-intake/s3-mirror.service';
import { s3UrlFor } from '../po-processing/common/processed-store';
import { todayIst, ValidatedLine } from '../po-validation/validate-po';
import { appError } from '../../utils/AppError';
import { EmailPlan, RowPlan } from './po-uploads.service';

/*
 * Step 2 of saving a PO (user, 2026-10-08), for a PO whose po_uploads row passed validation (status processing):
 *   ONE transaction: next sale order code (sale_order_code_counter) + master_purchase_orders + details_purchase_orders
 *   (as PEPIMS fills them) + po_uploads.po_uid. Then the Uniware CSV is written next to processed.json and uploaded to
 *   the PO's S3 folder, and po_uploads becomes completed (uniware_csv_url, completed_at).
 *   A failure after the commit (CSV / S3) marks po_uploads failed with error_details; the PO rows stay, and a re-run
 *   only redoes the CSV.
 * planSave() only READS; applySave() writes.
 */

export interface SavePlan {
  row: RowPlan;
  upload: PoUpload | null;
  /** Why this PO is not saved ("" = it will be). */
  skip: string;
  master: Partial<MasterPurchaseOrder>;
  details: Partial<DetailsPurchaseOrder>[];
  /** The sale order code the next save would get (read without a lock; the real one is taken inside the transaction). */
  nextCode: string;
  csvRelPath: string;
}

const brand = (b: string): string | null => (NO_BRAND.includes(b.trim()) ? null : (BRAND_NAMES[b.trim().toLowerCase()] ?? b.trim()));
const n = (v: number | ''): number => (v === '' ? 0 : v);

/** The next serial for a date, read only (for the dry run). */
const peekSerial = async (db: DataSource, date: string): Promise<number> =>
  ((await db.getRepository(SaleOrderCodeCounter).findOneBy({ counterDate: date }))?.lastSerial ?? 0) + 1;

/**
 * Takes the next serial for a date INSIDE a transaction: the date's row is locked (SELECT ... FOR UPDATE) and +1;
 * no row yet -> a new row with 1. Two saves at the same moment can't get the same serial.
 */
export const takeSerial = async (m: EntityManager, date: string): Promise<number> => {
  const repo = m.getRepository(SaleOrderCodeCounter);
  const row = await repo.findOne({ where: { counterDate: date }, lock: { mode: 'pessimistic_write' } });
  if (!row) {
    await repo.insert({ counterDate: date, lastSerial: 1 });
    return 1;
  }
  await repo.update({ counterDate: date }, { lastSerial: row.lastSerial + 1 });
  return row.lastSerial + 1;
};

/** What step 2 would write for each PO of an email (rows from planEmail). Reads only. */
export const planSave = async (db: DataSource, plan: EmailPlan, now = new Date()): Promise<SavePlan[]> => {
  const today = todayIst(now);
  let serial = await peekSerial(db, today);
  const out: SavePlan[] = [];
  for (const row of plan.rows) {
    const v = row.validation;
    const upload = row.existing;
    const skip =
      !upload ? 'no po_uploads row yet: run po:record --apply first'
      : upload.status === UPLOAD_STATUS.COMPLETED ? 'already completed'
      : upload.status !== UPLOAD_STATUS.PROCESSING ? `po_uploads status is ${upload.status}`
      : v.status !== VALIDATION_STATUS.VALID || !v.location ? 'does not pass validation'
      : upload.poUid ? 'PO rows already saved (only the CSV is missing)'
      : '';

    const lines = v.lines;
    const ocr = (upload?.ocrResult ?? row.values.ocrResult ?? {}) as Record<string, unknown>;
    const master: Partial<MasterPurchaseOrder> = {
      entryDate: today,
      poDate: await poDateOf(plan, row),
      facility: v.location?.facilityCode ?? null,
      channel: v.channelDisplayName,
      location: v.location?.locationCode ?? null,
      poNumber: v.poNumber,
      totalUnits: lines.reduce((s, l) => s + n(l.qty), 0),
      // PEPIMS: a PO with several brands takes the FIRST line's brand; every line keeps its own.
      brandName: lines.length ? brand(lines[0].brandName) : null,
      statusActive: NEW_PO_STATUS.ACTIVE,
      statusPlanning: NEW_PO_STATUS.PLANNING,
      customerCode: v.location?.customerCode ?? null,
      // processed.json in S3 (decided 2026-10-08: `document` until the PM adds a column for it).
      document: (ocr.processed_json as string | undefined) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const details = lines.map((l: ValidatedLine, i): Partial<DetailsPurchaseOrder> => {
      const gmv = round2(n(l.qty) * n(l.ourMrp));
      const poValue = round2(n(l.chargedQty) * n(l.ourRate));
      return {
        srNo: String(i + 1),
        skuName: l.skuName || null,
        skuCode: l.pepCode,
        channelSkuCode: l.channelSkuCode,
        qty: n(l.qty),
        gmv,
        poValue,
        // PEPIMS starts the "updated" columns equal to the PO's values.
        updatedQty: n(l.qty),
        updatedGmv: gmv,
        updatedPoValue: poValue,
        brandName: brand(l.brandName),
        poNumber: v.poNumber,
        createdAt: now,
        updatedAt: now,
      };
    });
    const csvRelPath = path.posix.join(path.posix.dirname(row.relPath), UNIWARE_CSV.FILE_NAME(v.poNumber, today));
    out.push({ row, upload, skip, master, details, nextCode: saleOrderCode(today, skip ? 0 : serial), csvRelPath });
    if (!skip) serial++;
  }
  return out;
};

/** po_date of the PO as processed.json has it (YYYY-MM-DD or empty). */
const poDateOf = async (plan: EmailPlan, row: RowPlan): Promise<string | null> => {
  try {
    const po = JSON.parse(await fs.readFile(path.join(plan.folder, row.relPath), 'utf8')) as { po_date?: string };
    return po.po_date || null;
  } catch {
    return null;
  }
};

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The Uniware CSV of one PO (one row per line), in the column order of UNIWARE_CSV.HEADERS. */
export const uniwareCsv = (p: SavePlan, code: string): string => {
  const v = p.row.validation;
  const loc = v.location;
  const rows = v.lines.map((l) => [
    code,
    v.poNumber,
    UNIWARE_CSV.COD,
    loc?.uniwareChannel ?? '',
    l.pepCode,
    UNIWARE_CSV.SHIPPING_METHOD,
    l.pepCode,
    l.channelSkuCode,
    n(l.ourRate).toFixed(2),
    UNIWARE_CSV.ON_HOLD,
    n(l.qty),
    loc?.customerCode ?? '',
    loc?.facilityCode ?? '',
    p.master.poDate ?? '', // PO Date: the PO's date when the PO has one (user, 2026-10-08), YYYY-MM-DD
  ]);
  return [UNIWARE_CSV.HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
};

export interface SaveResult {
  poNumber: string;
  uploadId: string;
  poUid?: string;
  code?: string;
  csvUrl?: string;
  error?: string;
}

/** Saves every PO of the plan that is not skipped. */
export const applySave = async (db: DataSource, folder: string, plans: SavePlan[]): Promise<SaveResult[]> => {
  const results: SaveResult[] = [];
  const meta = JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as EmailMetadata;
  const uploads = db.getRepository(PoUpload);
  for (const p of plans) {
    if (p.skip || !p.upload) continue;
    const upload = p.upload;
    const r: SaveResult = { poNumber: p.row.poNumber, uploadId: upload.id };
    let code = '';
    try {
      // 1. PO rows + sale order code, in one transaction. The CSV is written to disk inside it (before the commit), so
      //    a stop after the commit leaves the CSV with its sale order code for resume to upload (finishCsv).
      const csvFile = path.join(folder, p.csvRelPath);
      await db.transaction(async (m) => {
        const serial = await takeSerial(m, p.master.entryDate as string);
        code = saleOrderCode(p.master.entryDate as string, serial);
        const masterRow = await m.getRepository(MasterPurchaseOrder).save(m.getRepository(MasterPurchaseOrder).create(p.master));
        const details = m.getRepository(DetailsPurchaseOrder);
        await details.save(p.details.map((d) => details.create({ ...d, shipmentOrderId: masterRow.uid })));
        await m.getRepository(PoUpload).save({ ...upload, poUid: masterRow.uid });
        r.poUid = masterRow.uid;
        await fs.writeFile(csvFile, uniwareCsv(p, code), 'utf8');
      });
      r.code = code;

      // 2. The email folder (with the CSV next to processed.json) is synced to S3.
      await syncEmailToS3(folder);
      r.csvUrl = s3UrlFor(folder, meta, p.csvRelPath);

      // 3. Done.
      await uploads.save({ ...upload, poUid: r.poUid ?? null, uniwareCsvUrl: r.csvUrl, status: UPLOAD_STATUS.COMPLETED, completedAt: new Date(), errorDetails: null });
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err);
      await uploads.save({
        ...upload,
        poUid: r.poUid ?? upload.poUid,
        status: UPLOAD_STATUS.FAILED,
        errorDetails: { step: r.poUid ? PIPELINE_STEP.UNIWARE_CSV : PIPELINE_STEP.SAVE_PO, message: r.error, saleOrderCode: code || null },
      });
    }
    results.push(r);
  }
  return results;
};

/**
 * Resume: a PO whose rows were saved (po_uid set, status processing) but whose CSV never reached S3. The CSV was written
 * in the save transaction: upload the folder and complete the row. No CSV on disk -> failed (the sale order code is
 * unknown, a person must look). Returns the CSV's S3 URL, or throws.
 */
export const finishCsv = async (db: DataSource, folder: string, upload: PoUpload, relPath: string): Promise<string> => {
  const meta = JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as EmailMetadata;
  const master = upload.poUid ? await db.getRepository(MasterPurchaseOrder).findOneBy({ uid: upload.poUid }) : null;
  const csvRelPath = path.posix.join(path.posix.dirname(relPath), UNIWARE_CSV.FILE_NAME(upload.poNumber ?? '', master?.entryDate ?? ''));
  const exists = await fs.access(path.join(folder, csvRelPath)).then(() => true, () => false);
  const uploads = db.getRepository(PoUpload);
  if (!exists) {
    const message = errorMessage(ERROR_CODES.UNIWARE_CSV_MISSING, csvRelPath);
    await uploads.save({ ...upload, status: UPLOAD_STATUS.FAILED, errorDetails: { step: PIPELINE_STEP.UNIWARE_CSV, message } });
    throw appError(ERROR_CODES.UNIWARE_CSV_MISSING, csvRelPath);
  }
  await syncEmailToS3(folder);
  const csvUrl = s3UrlFor(folder, meta, csvRelPath);
  await uploads.save({ ...upload, uniwareCsvUrl: csvUrl, status: UPLOAD_STATUS.COMPLETED, completedAt: new Date(), errorDetails: null });
  return csvUrl;
};
