import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { In, Not } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { CHANNEL_MASTER_IDS, CHANNELS, ChannelName, ERROR_CODES, FILES, SOURCE_SYSTEM, UPLOAD_STATUS, IST_OFFSET_MS, MANUAL_UPLOAD, MANUAL_UPLOAD_STATUS, ManualUploadStatus, PROVIDERS, RESULT_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { ActivityLog, ManualUpload, ManualUploadFile, MasterChannel, PoUpload } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { syncEmailToS3 } from '../email-intake/s3-mirror.service';
import { amazonConnector } from '../channel-api/amazon/amazon.connector';
import { shipmentsByIds } from '../channel-api/amazon/inbound-api';
import { s3UrlFor } from '../po-processing/common/processed-store';
import { MasterDataReader } from '../po-validation/master-data';
import { runChainFor } from '../po-pipeline/pipeline.service';
import { AmazonTsv, parseAmazonTsv, toExternalPo, withFileDetails } from './amazon-tsv';
import { ChannelConfig, channelConfigs } from '../ocr/channels.config';
import { extractPo } from '../ocr/extract-po.service';
import { emailStored } from '../po-pipeline/pipeline.service';
import { bumpReview } from '../po-review/po-review.live';

/*
 * Manual upload (user, 2026-10-22; constants/manual-upload.ts). Upload = store the PO's files as a folder like an
 * email's + copy to S3 (status uploaded). Process = queued. The queue runs one at a time with the SAME functions as an
 * email: emailStored (po_uploads row) -> extractPo (OCR -> processed.json -> validation -> PO tables + sale order +
 * Uniware CSV, or In Review). Nothing new in the chain: only how the files arrive.
 */

export interface Actor {
  id: number;
  email: string;
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
}

const repo = () => AppDataSource.getRepository(ManualUpload);

const audit = (by: Actor, what: string) =>
  AppDataSource.getRepository(ActivityLog).insert({
    userId: by.id, method: 'AUDIT', path: what.slice(0, 255), status: 200, durationMs: 0, createdOn: new Date(Date.now() + IST_OFFSET_MS),
  });

const safeName = (name: string) => path.basename(name).replace(/[^A-Za-z0-9._ ()-]+/g, '_').slice(0, 150) || 'file';
const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
const baseOf = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase();
/** The master_channels row of a reader channel: by the same id map validation uses (Scootsy / Purplle names differ). */
const masterIdOf = (channel: string): number | undefined => CHANNEL_MASTER_IDS[channel as ChannelName];

// ---- Channels the app can read --------------------------------------------------------------------------------------

/** What a reader takes, in words: "PDF", "Excel or CSV", "PDF + Excel". */
const sheetText = (c: ChannelConfig): string => {
  const sheet = c.files.sheet;
  return sheet ? ['x.xlsx', 'x.xls', 'x.csv'].filter((n) => sheet.test(n)).map((n) => n.slice(2).toUpperCase()).join(' / ') : '';
};
/** The files one PO needs (an optional one, e.g. 1mg's PDF, is left out: optionalOf). */
const needsOf = (c: ChannelConfig): string =>
  [c.files.pdf && !c.optional?.includes('pdf') ? 'PDF' : '', !c.optional?.includes('sheet') ? sheetText(c) : ''].filter(Boolean).join(' + ');
/** The file a PO may also have (same file name), e.g. "PDF" for Tata 1mg; "" when none. */
const optionalOf = (c: ChannelConfig): string =>
  [c.files.pdf && c.optional?.includes('pdf') ? 'PDF' : '', c.files.sheet && c.optional?.includes('sheet') ? sheetText(c) : ''].filter(Boolean).join(' + ');

/** How the channel normally sends POs (the Manual Upload list is grouped by it): api (Amazon), email; manual-only later. */
export type UploadGroup = 'api' | 'email' | 'manual';
export interface UploadChannel { channel: string; name: string; needs: string; twoFiles: boolean; group: UploadGroup; optional?: string }

/** Channels with a PO reader (channels.config) that are active in master_channels. */
export const uploadChannels = async (): Promise<UploadChannel[]> => {
  const masters = await AppDataSource.getRepository(MasterChannel).find({ where: { isActive: true } });
  return channelConfigs
    .map((c): UploadChannel | null => {
      const m = masters.find((x) => x.id === masterIdOf(c.channel));
      return m
        ? { channel: c.channel, name: m.displayName, needs: needsOf(c), twoFiles: !!(c.files.pdf && c.files.sheet) && !c.optional?.length, group: 'email', optional: optionalOf(c) || undefined }
        : null;
    })
    .filter((x): x is UploadChannel => x !== null)
    .concat(amazonMaster(masters))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** Amazon (user, 2026-10-22): its shipment .tsv, for shipments the automatic pull missed. */
const amazonMaster = (masters: MasterChannel[]): UploadChannel[] => {
  const m = masters.find((x) => x.id === masterIdOf(CHANNELS.AMAZON));
  return m ? [{ channel: CHANNELS.AMAZON, name: m.displayName, needs: MANUAL_UPLOAD.AMAZON_NEEDS, twoFiles: false, group: 'api' }] : [];
};

// ---- Upload ---------------------------------------------------------------------------------------------------------

/**
 * Splits the files into POs as the channel's reader needs them: one file per PO, or for a PDF + sheet channel (Blinkit,
 * Zepto) the two files with the same name (or the only PDF + the only sheet).
 */
const groupFiles = (c: ChannelConfig, files: UploadedFile[], channelName: string): UploadedFile[][] => {
  const { pdf, sheet } = c.files;
  // A PDF + sheet channel whose PDF is optional (Tata 1mg): one PO per sheet, its PDF (same file name) added when there.
  if (pdf && sheet && c.optional?.includes('pdf')) {
    const pdfs = files.filter((f) => pdf.test(f.originalname));
    const sheets = files.filter((f) => !pdf.test(f.originalname) && sheet.test(f.originalname));
    const other = files.filter((f) => !pdfs.includes(f) && !sheets.includes(f));
    if (other.length) throw appError(ERROR_CODES.MANUAL_FILES_MISSING, channelName, needsOf(c), other.map((f) => f.originalname).join(', '));
    const lonely = pdfs.filter((p) => !sheets.some((s) => baseOf(s.originalname) === baseOf(p.originalname)));
    if (lonely.length) throw appError(ERROR_CODES.MANUAL_FILES_MISSING, channelName, `${needsOf(c)} (a PDF only next to its ${needsOf(c)}, same file name)`, lonely.map((f) => f.originalname).join(', '));
    return sheets.map((s) => [s, ...pdfs.filter((p) => baseOf(p.originalname) === baseOf(s.originalname))]);
  }
  if (!(pdf && sheet)) {
    const pattern = (pdf ?? sheet)!;
    const bad = files.filter((f) => !pattern.test(f.originalname));
    if (bad.length) throw appError(ERROR_CODES.MANUAL_FILES_MISSING, channelName, needsOf(c), bad.map((f) => f.originalname).join(', '));
    return files.map((f) => [f]);
  }
  const pdfs = files.filter((f) => pdf.test(f.originalname));
  const sheets = files.filter((f) => !pdf.test(f.originalname) && sheet.test(f.originalname));
  const other = files.filter((f) => !pdfs.includes(f) && !sheets.includes(f));
  if (other.length) throw appError(ERROR_CODES.MANUAL_FILES_MISSING, channelName, needsOf(c), other.map((f) => f.originalname).join(', '));
  if (pdfs.length === 1 && sheets.length === 1) return [[pdfs[0], sheets[0]]];
  const groups: UploadedFile[][] = [];
  const lonely: string[] = [];
  for (const p of pdfs) {
    const s = sheets.find((x) => baseOf(x.originalname) === baseOf(p.originalname));
    if (s) groups.push([p, s]);
    else lonely.push(p.originalname);
  }
  lonely.push(...sheets.filter((s) => !groups.some((g) => g[1] === s)).map((s) => s.originalname));
  if (lonely.length) throw appError(ERROR_CODES.MANUAL_FILES_MISSING, channelName, `${needsOf(c)} with the same file name`, lonely.join(', '));
  return groups;
};

/** Stores each PO's files like an email folder, copies it to S3 and adds it to the queue as "uploaded". */
export const uploadFiles = async (channel: string, files: UploadedFile[], by: Actor): Promise<{ ids: string[] }> => {
  if (channel === CHANNELS.AMAZON) return uploadAmazon(files, by);
  const config = channelConfigs.find((c) => c.channel === channel);
  const id = masterIdOf(channel);
  const master = config && id ? await AppDataSource.getRepository(MasterChannel).findOneBy({ id, isActive: true }) : null;
  if (!config || !master) throw appError(ERROR_CODES.MANUAL_CHANNEL_NOT_READABLE, channel);
  if (!files.length) throw appError(ERROR_CODES.NO_FILES_UPLOADED);
  for (const f of files) if (!MANUAL_UPLOAD.ALLOWED_EXT.test(f.originalname)) throw appError(ERROR_CODES.MANUAL_FILE_TYPE, f.originalname);
  const groups = groupFiles(config, files, master.displayName);

  // The same file uploaded before (not cancelled): kept, with a warning note.
  const earlier = await repo().find({ where: { status: Not(MANUAL_UPLOAD_STATUS.CANCELLED) }, select: ['id', 'files'] });
  const seenIn = (hash: string) => earlier.find((e) => e.files.some((f) => f.sha1 === hash))?.id;

  const ids: string[] = [];
  for (const group of groups) {
    const meta: ManualUploadFile[] = group.map((f) => ({ filename: safeName(f.originalname), size: f.buffer.length, sha1: sha1(f.buffer) }));
    const dup = meta.map((m) => seenIn(m.sha1)).find(Boolean);
    const now = new Date();
    const row = await repo().save(repo().create({
      channel, files: meta, folder: '', status: MANUAL_UPLOAD_STATUS.UPLOADED, uploadedBy: by.id, uploadedAt: now,
      note: dup ? `Same file as manual upload #${dup}` : null,
    }));
    const folder = path.resolve(env.storage.emailDir, MANUAL_UPLOAD.FOLDER, `${now.toISOString().slice(0, 10)}_${row.id}`);
    await fs.mkdir(folder, { recursive: true });
    for (const [i, f] of group.entries()) await fs.writeFile(path.join(folder, meta[i].filename), f.buffer);
    await fs.writeFile(path.join(folder, FILES.METADATA), `${JSON.stringify({
      messageId: MANUAL_UPLOAD.MESSAGE_ID(row.id),
      provider: PROVIDERS.MANUAL,
      channel,
      uploadedBy: by.email,
      receivedAt: now.toISOString(),
      files: meta.map((m) => ({ filename: m.filename, size: m.size })),
      storedAt: now.toISOString(),
    }, null, 2)}\n`);
    let s3Folder: string | null = null;
    try {
      s3Folder = (await syncEmailToS3(folder)).s3Folder || null;
    } catch (err) {
      // The files are on disk; the copy is tried again when it is processed (extractPo copies the folder too).
      logError(LOG_SOURCE.S3, `manual upload ${row.id}: S3 copy failed (retried at Process)`, err);
    }
    await repo().update({ id: row.id }, { folder, s3Folder });
    ids.push(String(row.id));
  }
  await audit(by, `manual upload: ${master.displayName}, ${files.length} file(s) -> upload(s) ${ids.join(',')}`);
  bumpReview();
  return { ids };
};

// ---- Amazon shipment files (.tsv) ------------------------------------------------------------------------------------

/**
 * Where this shipment already is, if anywhere (user: "no duplicate processing"): a PO in POST_FG (any status but
 * failed: the automatic pull, an earlier manual upload, a review), or another manual upload still open or done.
 */
const amazonTakenBy = async (shipmentId: string, exceptManualId?: string): Promise<string | null> => {
  const [po] = (await AppDataSource.query(
    `SELECT u.id, u.status, m.orderNo1 so FROM po_uploads u LEFT JOIN master_purchase_orders m ON m.uid = u.po_uid
      WHERE u.source_system = ? AND u.external_id = ? AND u.status <> ? ORDER BY u.id DESC LIMIT 1`,
    [SOURCE_SYSTEM.AMAZON_SPAPI, shipmentId, UPLOAD_STATUS.FAILED],
  )) as { id: string | number; status: string; so: string | null }[];
  if (po) return `a PO in POST_FG (upload ${po.id}, ${po.status}${po.so ? `, sale order ${po.so}` : ''})`;
  const open = await repo().find({
    where: { channel: CHANNELS.AMAZON, externalId: shipmentId, status: In([MANUAL_UPLOAD_STATUS.UPLOADED, MANUAL_UPLOAD_STATUS.QUEUED, MANUAL_UPLOAD_STATUS.PROCESSING, MANUAL_UPLOAD_STATUS.DONE]) },
  });
  const other = open.find((r) => String(r.id) !== exceptManualId);
  return other ? `in the upload queue (#${other.id}, ${other.status})` : null;
};

/** Each file = one shipment: checked (layout, duplicates, Amazon status), then stored + S3 as "uploaded". All or nothing. */
const uploadAmazon = async (files: UploadedFile[], by: Actor): Promise<{ ids: string[] }> => {
  if (!files.length) throw appError(ERROR_CODES.NO_FILES_UPLOADED);
  const parsed: { file: UploadedFile; tsv: AmazonTsv }[] = [];
  for (const f of files) {
    if (!MANUAL_UPLOAD.AMAZON_EXT.test(f.originalname)) throw appError(ERROR_CODES.MANUAL_AMAZON_FILE, f.originalname);
    const tsv = parseAmazonTsv(f.originalname, f.buffer.toString('utf8'));
    if (parsed.some((p) => p.tsv.shipmentId === tsv.shipmentId)) throw appError(ERROR_CODES.MANUAL_DUPLICATE, tsv.shipmentId, 'in this upload twice');
    const where = await amazonTakenBy(tsv.shipmentId);
    if (where) throw appError(ERROR_CODES.MANUAL_DUPLICATE, tsv.shipmentId, where);
    parsed.push({ file: f, tsv });
  }
  // The status now (read-only, one call per 50): cancelled / deleted / closed are refused; unknown is allowed with a note.
  let statuses = new Map<string, string>();
  let statusNote: string | null = null;
  try {
    statuses = new Map((await shipmentsByIds(parsed.map((p) => p.tsv.shipmentId))).map((x) => [x.ShipmentId, x.ShipmentStatus]));
  } catch (err) {
    statusNote = 'Amazon status could not be read';
    logError(LOG_SOURCE.AMAZON, 'manual upload: Amazon status check failed (upload allowed)', err);
  }
  for (const p of parsed) {
    const st = statuses.get(p.tsv.shipmentId);
    if (st && (MANUAL_UPLOAD.AMAZON_REFUSED_STATUSES as readonly string[]).includes(st)) throw appError(ERROR_CODES.MANUAL_AMAZON_STATUS, p.tsv.shipmentId, st);
  }

  const ids: string[] = [];
  for (const { file, tsv } of parsed) {
    const status = statuses.get(tsv.shipmentId) ?? MANUAL_UPLOAD.AMAZON_STATUS_UNKNOWN;
    const name = safeName(file.originalname);
    const now = new Date();
    const row = await repo().save(repo().create({
      channel: CHANNELS.AMAZON, externalId: tsv.shipmentId, folder: '', status: MANUAL_UPLOAD_STATUS.UPLOADED, uploadedBy: by.id, uploadedAt: now,
      files: [{ filename: name, size: file.buffer.length, sha1: sha1(file.buffer) }],
      note: `Amazon: ${status}${statuses.has(tsv.shipmentId) ? '' : ` (${statusNote ?? 'not found at Amazon'})`}`,
    }));
    const folder = path.resolve(env.storage.emailDir, MANUAL_UPLOAD.FOLDER, `${now.toISOString().slice(0, 10)}_${row.id}`);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, name), file.buffer);
    await fs.writeFile(path.join(folder, FILES.METADATA), `${JSON.stringify({
      messageId: MANUAL_UPLOAD.MESSAGE_ID(row.id),
      provider: PROVIDERS.MANUAL,
      structured: true,
      sourceFile: name,
      channel: CHANNELS.AMAZON,
      poNumber: tsv.shipmentId,
      sourceSystem: SOURCE_SYSTEM.AMAZON_SPAPI,
      externalId: tsv.shipmentId,
      externalStatus: status,
      subject: tsv.name,
      uploadedBy: by.email,
      receivedAt: now.toISOString(),
      files: [{ filename: name, size: file.buffer.length }],
      storedAt: now.toISOString(),
    }, null, 2)}\n`);
    let s3Folder: string | null = null;
    try {
      s3Folder = (await syncEmailToS3(folder)).s3Folder || null;
    } catch (err) {
      logError(LOG_SOURCE.S3, `manual upload ${row.id}: S3 copy failed (retried at Process)`, err);
    }
    await repo().update({ id: row.id }, { folder, s3Folder });
    ids.push(String(row.id));
  }
  await audit(by, `manual upload: Amazon, ${parsed.map((p) => p.tsv.shipmentId).join(',')} -> upload(s) ${ids.join(',')}`);
  bumpReview();
  return { ids };
};

/** Process an Amazon file: duplicate check again (two people, same shipment), processed.json from the file, the chain. */
const processAmazon = async (u: ManualUpload): Promise<string | null> => {
  const meta = JSON.parse(await fs.readFile(path.join(u.folder, FILES.METADATA), 'utf8')) as { sourceFile: string; externalStatus?: string };
  const tsv = parseAmazonTsv(meta.sourceFile, await fs.readFile(path.join(u.folder, meta.sourceFile), 'utf8'));
  const where = await amazonTakenBy(tsv.shipmentId, String(u.id));
  if (where) throw appError(ERROR_CODES.MANUAL_DUPLICATE, tsv.shipmentId, where);
  const master = await new MasterDataReader(AppDataSource).forChannel(CHANNELS.AMAZON);
  const po = withFileDetails(amazonConnector.toProcessed(toExternalPo(tsv, meta.externalStatus ?? MANUAL_UPLOAD.AMAZON_STATUS_UNKNOWN), master), tsv, meta.sourceFile);
  po.ref_file_urls = [s3UrlFor(u.folder, JSON.parse(await fs.readFile(path.join(u.folder, FILES.METADATA), 'utf8')), meta.sourceFile)];
  await fs.writeFile(path.join(u.folder, FILES.PROCESSED), `${JSON.stringify(po, null, 2)}\n`);
  await syncEmailToS3(u.folder); // the review screen reads processed.json from S3
  const out = await runChainFor(u.folder);
  const failed = out.find((o) => o.error);
  if (failed) throw new Error(failed.error);
  return out.map((o) => `${o.poNumber}: ${o.status}${o.saleOrder ? ` (${o.saleOrder})` : ''}`).join('; ') || null;
};

// ---- The queue: one at a time ---------------------------------------------------------------------------------------

let running = false;

/** One upload through the same chain as an email. */
const runOne = async (u: ManualUpload): Promise<void> => {
  await repo().update({ id: u.id }, { status: MANUAL_UPLOAD_STATUS.PROCESSING, note: u.note });
  bumpReview();
  let status: ManualUploadStatus = MANUAL_UPLOAD_STATUS.DONE;
  let note: string | null = u.note;
  try {
    if (u.channel === CHANNELS.AMAZON) {
      note = await processAmazon(u);
      await repo().update({ id: u.id }, { status, note: note?.slice(0, 500) ?? null, finishedAt: new Date() });
      bumpReview();
      return;
    }
    const allowed = await emailStored(u.folder);
    if (!allowed) throw new Error(`PIPELINE_LIMIT ${env.pipeline.limit} reached: process it again after a restart`);
    const ocr = await extractPo(u.folder);
    if (ocr.status !== RESULT_STATUS.OK) {
      status = MANUAL_UPLOAD_STATUS.FAILED;
      note = ocr.reason ?? ocr.status;
    }
  } catch (err) {
    status = MANUAL_UPLOAD_STATUS.FAILED;
    note = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logError(LOG_SOURCE.OCR, `manual upload ${u.id} failed`, err);
  }
  await repo().update({ id: u.id }, { status, note: note?.slice(0, 500) ?? null, finishedAt: new Date() });
  log.info(LOG_SOURCE.OCR, `[manual-upload] ${u.id} ${status}${note ? `: ${note}` : ''}`);
  bumpReview();
};

/** Runs queued uploads, oldest first, one at a time, until none is left. Safe to call any time. */
export const kickQueue = (): void => {
  if (running || !AppDataSource.isInitialized) return;
  running = true;
  void runJob('manual-upload', async () => {
    for (;;) {
      const next = await repo().findOne({ where: { status: MANUAL_UPLOAD_STATUS.QUEUED }, order: { id: 'ASC' } });
      if (!next) return;
      await runOne(next);
    }
  })
    .catch((err) => logError(LOG_SOURCE.OCR, 'manual upload queue stopped (continues at the next Process or start)', err))
    .finally(() => { running = false; });
};

/** At server start: an upload cut off while processing runs again; queued ones continue. "uploaded" ones wait. */
export const resumeManualQueue = async (): Promise<void> => {
  try {
    const cut = await repo().update({ status: MANUAL_UPLOAD_STATUS.PROCESSING }, { status: MANUAL_UPLOAD_STATUS.QUEUED });
    if (cut.affected) log.info(LOG_SOURCE.OCR, `[manual-upload] ${cut.affected} upload(s) cut off by the restart: queued again`);
    kickQueue();
  } catch (err) {
    // Before the ManualUploads migration has run there is no table: nothing to resume.
    if ((err as { code?: string }).code !== 'ER_NO_SUCH_TABLE') logError(LOG_SOURCE.DB, 'manual upload queue: resume failed', err);
  }
};

const byId = async (id: string): Promise<ManualUpload> => {
  const u = await repo().findOneBy({ id });
  if (!u) throw appError(ERROR_CODES.MANUAL_UPLOAD_NOT_FOUND, id);
  return u;
};

/** Process clicked (one or several): uploaded -> queued, then the queue runs. */
export const processUploads = async (ids: string[], by: Actor): Promise<{ queued: string[] }> => {
  if (!ids.length) throw appError(ERROR_CODES.UPLOAD_IDS_REQUIRED);
  const rows = await repo().findBy({ id: In(ids) });
  const wrong = rows.find((r) => r.status !== MANUAL_UPLOAD_STATUS.UPLOADED);
  if (wrong) throw appError(ERROR_CODES.MANUAL_UPLOAD_WRONG_STATE, wrong.id, wrong.status, 'processed');
  const missing = ids.find((id) => !rows.some((r) => String(r.id) === id));
  if (missing) throw appError(ERROR_CODES.MANUAL_UPLOAD_NOT_FOUND, missing);
  await repo().update({ id: In(ids) }, { status: MANUAL_UPLOAD_STATUS.QUEUED, processBy: by.id, processAt: new Date() });
  await audit(by, `manual upload: process ${ids.join(',')}`);
  bumpReview();
  kickQueue();
  return { queued: ids };
};

/** Failed -> queued again (same folder; its po_uploads row is reused). */
export const retryUpload = async (id: string, by: Actor): Promise<{ status: string }> => {
  const u = await byId(id);
  if (u.status !== MANUAL_UPLOAD_STATUS.FAILED) throw appError(ERROR_CODES.MANUAL_UPLOAD_WRONG_STATE, id, u.status, 'retried');
  await repo().update({ id }, { status: MANUAL_UPLOAD_STATUS.QUEUED, processBy: by.id, processAt: new Date(), finishedAt: null });
  await audit(by, `manual upload: retry ${id}`);
  bumpReview();
  kickQueue();
  return { status: MANUAL_UPLOAD_STATUS.QUEUED };
};

/** Only an upload nobody processed yet can be cancelled; it stays in the list (nothing deleted). */
export const cancelUpload = async (id: string, by: Actor): Promise<{ status: string }> => {
  const u = await byId(id);
  if (u.status !== MANUAL_UPLOAD_STATUS.UPLOADED) throw appError(ERROR_CODES.MANUAL_UPLOAD_WRONG_STATE, id, u.status, 'cancelled');
  await repo().update({ id }, { status: MANUAL_UPLOAD_STATUS.CANCELLED, finishedAt: new Date() });
  await audit(by, `manual upload: cancelled ${id}`);
  bumpReview();
  return { status: MANUAL_UPLOAD_STATUS.CANCELLED };
};

// ---- The list (Upload queue) ----------------------------------------------------------------------------------------

export interface ManualUploadItem {
  id: string;
  channel: string;
  channelName: string;
  files: { filename: string; size: number }[];
  status: ManualUploadStatus;
  note: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  processBy: string | null;
  processAt: string | null;
  finishedAt: string | null;
  /** Its POs once processed: po_uploads id, PO number, status (completed / needs_review / failed …), sale order CSV ready. */
  pos: { uploadId: string; poNumber: string | null; status: string }[];
}

export const listUploads = async (): Promise<ManualUploadItem[]> => {
  const rows = await repo().find({ order: { id: 'DESC' }, take: MANUAL_UPLOAD.LIST_LIMIT, relations: { uploader: true, processor: true } });
  const masters = await AppDataSource.getRepository(MasterChannel).find();
  const pos = rows.length
    ? await AppDataSource.getRepository(PoUpload).find({
      where: { emailMessageId: In(rows.map((r) => MANUAL_UPLOAD.MESSAGE_ID(r.id))) },
      select: ['id', 'poNumber', 'status', 'emailMessageId'],
    })
    : [];
  return rows.map((r) => ({
    id: String(r.id),
    channel: r.channel,
    channelName: masters.find((m) => m.id === masterIdOf(r.channel))?.displayName ?? r.channel,
    files: r.files.map((f) => ({ filename: f.filename, size: f.size })),
    status: r.status,
    note: r.note,
    uploadedBy: r.uploader?.name ?? r.uploader?.email ?? null,
    uploadedAt: r.uploadedAt.toISOString(),
    processBy: r.processor?.name ?? r.processor?.email ?? null,
    processAt: r.processAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    pos: pos.filter((p) => p.emailMessageId === MANUAL_UPLOAD.MESSAGE_ID(r.id)).map((p) => ({ uploadId: String(p.id), poNumber: p.poNumber, status: p.status })),
  }));
};
