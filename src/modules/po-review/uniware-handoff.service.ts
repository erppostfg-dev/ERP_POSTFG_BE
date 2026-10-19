import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, IST_OFFSET_MS, SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, UPLOAD_STATUS } from '../../constants';
import { ActivityLog, MasterPurchaseOrder, PoUpload, ShipmentLog } from '../../entities';
import { appError } from '../../utils/AppError';
import { openS3File } from '../email-intake/s3-mirror.service';
import { flushChanges } from '../po-overview/po-overview.live';
import { bumpReview } from './po-review.live';

/*
 * Uniware hand-off (user, 2026-10-19). A completed PO has a sale order CSV in S3; on the Processed tab it waits:
 *   1. download the CSV (one PO, or several as ONE combined CSV): the first download is recorded (who, when);
 *   2. someone marks it uploaded into Uniware (only after a download): recorded (who, when) + a shipment history row,
 *      and only from then on does the PO show in PO Overview (po-overview.queries applyFilters).
 * Marks can be removed again (undo) by the same action, also recorded. Every action writes an activity_log row and
 * tells the open screens (Processed via the review version, PO Overview via shipment_logs).
 */

export interface Actor {
  id: number;
  email: string;
}

const audit = (by: Actor, what: string) =>
  AppDataSource.getRepository(ActivityLog).insert({
    userId: by.id,
    method: 'AUDIT',
    path: what.slice(0, 255),
    status: 200,
    durationMs: 0,
    createdOn: new Date(Date.now() + IST_OFFSET_MS),
  });

const readText = async (s3Url: string): Promise<string> => {
  const f = await openS3File(s3Url);
  if (!f) throw appError(ERROR_CODES.PO_FILE_MISSING, s3Url);
  const chunks: Buffer[] = [];
  for await (const c of f.body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

/** Completed uploads with a CSV, in the order asked; any other id is refused (nothing recorded). */
const readyUploads = async (ids: string[]): Promise<PoUpload[]> => {
  const rows = await AppDataSource.getRepository(PoUpload).findBy({ id: In(ids) });
  const ok = rows.filter((u) => u.status === UPLOAD_STATUS.COMPLETED && u.uniwareCsvUrl);
  const bad = ids.filter((id) => !ok.some((u) => String(u.id) === id));
  if (bad.length) throw appError(ERROR_CODES.UNIWARE_CSV_NOT_READY, bad.join(', '));
  return ids.map((id) => ok.find((u) => String(u.id) === id)!);
};

/** First download only: later downloads keep the first who / when. */
const markDownloaded = async (uploads: PoUpload[], by: Actor) => {
  const fresh = uploads.filter((u) => !u.csvDownloadedAt).map((u) => u.id);
  if (fresh.length) await AppDataSource.getRepository(PoUpload).update({ id: In(fresh) }, { csvDownloadedAt: new Date(), csvDownloadedBy: by.id });
  bumpReview();
};

const saleOrderOf = async (u: PoUpload): Promise<string | null> =>
  u.poUid ? ((await AppDataSource.getRepository(MasterPurchaseOrder).findOne({ select: ['orderNo1'], where: { uid: u.poUid } }))?.orderNo1 ?? null) : null;

/** One PO's sale order CSV (file name = its sale order code). */
export const downloadOne = async (uploadId: string, by: Actor): Promise<{ fileName: string; text: string }> => {
  const [u] = await readyUploads([uploadId]);
  const text = await readText(u.uniwareCsvUrl!);
  await markDownloaded([u], by);
  const so = await saleOrderOf(u);
  await audit(by, `uniware csv: downloaded upload ${u.id} ${u.poNumber ?? ''} ${so ?? ''}`.trim());
  return { fileName: `${so ?? u.poNumber ?? u.id}.csv`, text };
};

/** Several POs as ONE CSV: the header once, then every PO's rows, in the order asked. */
export const downloadCombined = async (ids: string[], by: Actor): Promise<{ fileName: string; text: string }> => {
  if (!ids.length) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
  const uploads = await readyUploads(ids);
  let header = '';
  const rows: string[] = [];
  for (const u of uploads) {
    const lines = (await readText(u.uniwareCsvUrl!)).split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    if (!header) header = lines[0];
    rows.push(...lines.slice(1));
  }
  await markDownloaded(uploads, by);
  await audit(by, `uniware csv: combined download of ${uploads.length} upload(s): ${ids.join(',')}`);
  const stamp = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return { fileName: `uniware_sale_orders_${stamp}_${uploads.length}.csv`, text: `${[header, ...rows].join('\r\n')}\r\n` };
};

/** Marks (or with undo removes the mark of) "uploaded into Uniware"; a PO must have been downloaded first. */
export const markUploaded = async (ids: string[], by: Actor, undo = false): Promise<{ changed: string[] }> => {
  if (!ids.length) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
  const uploads = await readyUploads(ids);
  if (!undo) {
    const notYet = uploads.filter((u) => !u.csvDownloadedAt).map((u) => String(u.id));
    if (notYet.length) throw appError(ERROR_CODES.UNIWARE_NOT_DOWNLOADED, notYet.join(', '));
  }
  const todo = uploads.filter((u) => (undo ? u.uniwareUploadedAt : !u.uniwareUploadedAt));
  if (todo.length) {
    await AppDataSource.transaction(async (m) => {
      await m.getRepository(PoUpload).update(
        { id: In(todo.map((u) => u.id)) },
        undo ? { uniwareUploadedAt: null, uniwareUploadedBy: null } : { uniwareUploadedAt: new Date(), uniwareUploadedBy: by.id },
      );
      // The shipment's own history says it went to (or was taken back from) Uniware; this also tells PO Overview.
      const logs = m.getRepository(ShipmentLog);
      for (const u of todo.filter((x) => x.poUid)) {
        await logs.insert({
          shipmentUid: u.poUid!,
          userId: by.id,
          action: undo ? SHIPMENT_LOG_ACTION.UNIWARE_UPLOAD_UNDONE : SHIPMENT_LOG_ACTION.UNIWARE_UPLOADED,
          source: SHIPMENT_LOG_SOURCE.SCREEN,
          remark: await saleOrderOf(u),
        });
      }
    });
    await audit(by, `uniware: ${undo ? 'upload mark removed' : 'marked uploaded'} for upload(s) ${todo.map((u) => u.id).join(',')}`);
    bumpReview();
    void flushChanges();
  }
  return { changed: todo.map((u) => String(u.id)) };
};
