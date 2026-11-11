import fs from 'fs/promises';
import path from 'path';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  ERROR_CODES, FAILED_ACTIONS, FILES, FOLDERS, LABELS, PIPELINE_STEP, LOG_SOURCE, MANUAL_UPLOAD, MAX_OCR_ATTEMPTS, RESUME_ACTION, UPLOAD_SOURCE, UPLOAD_STATUS,
} from '../../constants';
import { PoUpload } from '../../entities';
import { appError } from '../../utils/AppError';
import { logError } from '../../utils/classify-error';
import { log } from '../../utils/logger';
import { downloadS3Folder } from '../email-intake/s3-mirror.service';
import { groupDirFor, storedFolderOf } from '../email-intake/email-storage.service';
import { queueExtractPo } from '../ocr/extract-po.service';
import { retryActionFor, ResumeItem, runResumeItem } from '../po-pipeline/resume.service';
import { runChainFor, takeSlot } from '../po-pipeline/pipeline.service';
import { retryUpload } from '../manual-upload/manual-upload.service';
import { Actor } from './po-review-actions.service';
import { reopenRejected } from './po-review-reopen.service';
import { bumpReview } from './po-review.live';

/*
 * Failed + Rejected, many at once (user 2026-11-04: "select multiple and again to the same processing").
 *   Try again (failed): each PO from the step it failed at, exactly as `po:resume --retry-failed` does (OCR again when it
 *     failed before / at OCR: OCR cost, at most MAX_OCR_ATTEMPTS; else processed.json -> validation -> save, free; or only
 *     the Uniware CSV). A Manual Upload's PO = that upload's own Retry. Refused per PO with the reason: not failed any more,
 *     dismissed, the same PO already made / in review / waiting (it came again meanwhile), OCR tried MAX times.
 *     LOAD (user): nothing runs in the request; the chosen POs go into ONE in-process queue, run one after another
 *     (OCR through the existing one-at-a-time OCR queue), within PIPELINE_LIMIT. Each PO is first marked queued /
 *     processing in the DB, so a restart never loses the queue (the start-up resume finishes it).
 *   Dismiss (failed): leaves the Failed list with who / when / why (error_details.dismissed); nothing is deleted.
 *   Reopen (rejected): each exactly like the single Reopen (back to In Review with one issue to accept).
 */

export interface BulkResult { uploadId: string; result: 'queued' | 'done' | 'skipped'; reason: string }

const repo = () => AppDataSource.getRepository(PoUpload);

/** Another PO row of the same channel + PO number that is not failed / rejected (it came again and was taken). */
const sameTaken = async (u: PoUpload): Promise<PoUpload | null> => {
  if (!u.poNumber || !u.channel) return null;
  return repo().findOne({
    where: { channel: u.channel, poNumber: u.poNumber, status: In([UPLOAD_STATUS.COMPLETED, UPLOAD_STATUS.NEEDS_REVIEW, UPLOAD_STATUS.PENDING_APPROVAL, UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.EXTRACTING, UPLOAD_STATUS.PROCESSING, UPLOAD_STATUS.HELD]) },
    order: { id: 'DESC' },
  });
};

const dismissedOf = (u: PoUpload) => (u.errorDetails as { dismissed?: unknown } | null)?.dismissed;

/** The email's folder on this server, else copied back from S3 (prod keeps nothing on the disk). */
const folderOf = async (u: PoUpload): Promise<string | null> => {
  if (!u.emailMessageId) return null;
  const group = u.source === UPLOAD_SOURCE.EMAIL ? LABELS.PO_INTAKE : u.source === UPLOAD_SOURCE.API ? FOLDERS.CHANNEL_API : FOLDERS.MANUAL;
  const local = await storedFolderOf(group, u.emailMessageId);
  if (local) return local;
  const m = /^s3:\/\/[^/]+\/(.+)\/[^/]+$/.exec(u.fileUrl ?? '');
  if (!m) return null;
  const dir = path.join(groupDirFor(group), path.basename(m[1]));
  return (await downloadS3Folder(m[1], dir)) ? dir : null;
};

// ---- the one queue (load: one at a time) ------------------------------------------------------------------------------

/** chainOnly: failed AFTER processed.json was made (validation / save / CSV): on from that processed.json (no OCR, no rebuild). */
const queue: (ResumeItem & { chainOnly?: boolean })[] = [];
let draining = false;
const runOcr = async (folder: string) => {
  if (env.ocr.enabled) queueExtractPo(folder);
  else log.info(LOG_SOURCE.OCR, `[failed-retry] OCR_ENABLED=false: ${folder} stays queued`);
};
const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (!takeSlot()) { log.info(LOG_SOURCE.APP, '[failed-retry] PIPELINE_LIMIT reached; the rest wait'); queue.length = 0; break; }
      const run = item.chainOnly ? runChainFor(item.folder!).then(() => undefined) : runResumeItem(AppDataSource, item, runOcr);
      await run.catch((err: unknown) => logError(LOG_SOURCE.APP, `[failed-retry] ${item.messageId} failed again`, err));
      bumpReview();
    }
  } finally {
    draining = false;
  }
};

/** Try again: each chosen failed PO from the step it failed at (see the top). Returns at once; the work runs after. */
export const retryFailed = async (ids: string[], by: Actor): Promise<BulkResult[]> => {
  if (!ids.length || ids.length > FAILED_ACTIONS.MAX_IDS) throw appError(ERROR_CODES.FIELD_NOT_ID_LIST, 'uploadIds', FAILED_ACTIONS.MAX_IDS);
  const out: BulkResult[] = [];
  const seenMessages = new Set<string>();
  for (const u of await repo().findBy({ id: In(ids) })) {
    const skip = (reason: string) => out.push({ uploadId: String(u.id), result: 'skipped', reason });
    if (u.status !== UPLOAD_STATUS.FAILED) { skip(`it is ${u.status} now`); continue; }
    if (dismissedOf(u)) { skip('dismissed'); continue; }
    const taken = await sameTaken(u);
    if (taken) { skip(`the same PO is already upload ${taken.id} (${taken.status}): not made twice`); continue; }
    // a Manual Upload: that upload's own Retry (the same queue as Manual Upload)
    const manualId = u.emailMessageId?.startsWith(MANUAL_UPLOAD.MESSAGE_ID('')) ? u.emailMessageId.slice(MANUAL_UPLOAD.MESSAGE_ID('').length) : null;
    if (u.source === UPLOAD_SOURCE.MANUAL && manualId) {
      try {
        await retryUpload(manualId, by);
        out.push({ uploadId: String(u.id), result: 'queued', reason: `Manual Upload #${manualId} queued again` });
      } catch (err) {
        skip(err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    if (!u.emailMessageId || seenMessages.has(u.emailMessageId)) { skip(u.emailMessageId ? 'its email is already in this retry' : 'no email to retry from'); continue; }
    seenMessages.add(u.emailMessageId);
    const folder = await folderOf(u).catch(() => null);
    if (!folder) { skip('its files are not on this server or in S3'); continue; }
    const rows = await repo().findBy({ emailMessageId: u.emailMessageId });
    const plan = await retryActionFor(rows, folder);
    if (plan.action === RESUME_ACTION.SKIP) { skip(plan.reason); continue; }
    const step = (u.errorDetails as { step?: string } | null)?.step;
    const hasProcessed = await fs.access(path.join(folder, FILES.PROCESSED)).then(() => true, () => false);
    const chainOnly = plan.action === RESUME_ACTION.PROCESS && hasProcessed && step !== PIPELINE_STEP.OCR && step !== PIPELINE_STEP.PROCESSING;
    // Self-healing (2026-11-04): the retry is written to the DB first (queued for OCR / processing), so a restart or
    // deploy in the middle does not lose it: the server's start-up resume finishes what this queue had not reached.
    await repo().update({ emailMessageId: u.emailMessageId, status: UPLOAD_STATUS.FAILED }, {
      status: plan.action === RESUME_ACTION.OCR ? UPLOAD_STATUS.QUEUED : UPLOAD_STATUS.PROCESSING,
      errorDetails: { ...(u.errorDetails ?? {}), retriedBy: by.email, retriedAt: new Date().toISOString() },
    });
    const queuedRows = await repo().findBy({ emailMessageId: u.emailMessageId });
    queue.push({ messageId: u.emailMessageId, folder, rows: queuedRows, ...plan, chainOnly });
    out.push({ uploadId: String(u.id), result: 'queued', reason: plan.action === RESUME_ACTION.OCR ? `OCR again (try ${u.ocrAttempts + 1} of ${MAX_OCR_ATTEMPTS})` : plan.reason });
  }
  for (const id of ids) if (!out.some((o) => o.uploadId === id)) out.push({ uploadId: id, result: 'skipped', reason: 'no such PO' });
  log.info(LOG_SOURCE.APP, `[failed-retry] ${by.email}: ${out.filter((o) => o.result === 'queued').length} queued, ${out.filter((o) => o.result === 'skipped').length} skipped`);
  void drain();
  bumpReview();
  return out;
};

/**
 * Read again, no OCR (2026-11-04, user: after a reader fix, e.g. Gluzo's column names): a PO in review or failed is
 * rebuilt from its STORED OCR output (S3) with today's reader, then checked again (issues no longer found are closed,
 * new ones opened). Refused per PO with the reason: not in review / failed, made by a channel API (its connector reads
 * it), no stored OCR output (use Try again). Same queue, same restart safety (status processing first) as Try again.
 */
export const rereadUploads = async (ids: string[], by: Actor): Promise<BulkResult[]> => {
  if (!ids.length || ids.length > FAILED_ACTIONS.MAX_IDS) throw appError(ERROR_CODES.FIELD_NOT_ID_LIST, 'uploadIds', FAILED_ACTIONS.MAX_IDS);
  const out: BulkResult[] = [];
  const seenMessages = new Set<string>();
  for (const u of await repo().findBy({ id: In(ids) })) {
    const skip = (reason: string) => out.push({ uploadId: String(u.id), result: 'skipped', reason });
    if (u.status !== UPLOAD_STATUS.NEEDS_REVIEW && u.status !== UPLOAD_STATUS.FAILED) { skip(`it is ${u.status} now: only a PO in review or failed is read again`); continue; }
    if (u.source === UPLOAD_SOURCE.API) { skip('made by a channel pull: its connector reads it again'); continue; }
    if (!u.emailMessageId || seenMessages.has(u.emailMessageId)) { skip(u.emailMessageId ? 'its email is already in this run' : 'no email to read again'); continue; }
    seenMessages.add(u.emailMessageId);
    const folder = await folderOf(u).catch(() => null);
    if (!folder) { skip('its files are not on this server or in S3'); continue; }
    const hasRaw = await fs.access(path.join(folder, FILES.OCR_RAW_JSON)).then(() => true, () => false);
    if (!hasRaw) { skip('no stored OCR output: use Try again (OCR again)'); continue; }
    const rows = await repo().findBy({ emailMessageId: u.emailMessageId });
    // restart safety: processing in the DB first (the start-up resume finishes it)
    await repo().update({ emailMessageId: u.emailMessageId, status: In([UPLOAD_STATUS.NEEDS_REVIEW, UPLOAD_STATUS.FAILED]) }, {
      status: UPLOAD_STATUS.PROCESSING,
      errorDetails: { ...(u.errorDetails ?? {}), rereadBy: by.email, rereadAt: new Date().toISOString() },
    });
    queue.push({ messageId: u.emailMessageId, folder, rows, action: RESUME_ACTION.PROCESS, reason: 'read again from the stored OCR output' });
    out.push({ uploadId: String(u.id), result: 'queued', reason: 'read again from the stored OCR output (no OCR cost)' });
  }
  for (const id of ids) if (!out.some((o) => o.uploadId === id)) out.push({ uploadId: id, result: 'skipped', reason: 'no such PO' });
  log.info(LOG_SOURCE.APP, `[reread] ${by.email}: ${out.filter((o) => o.result === 'queued').length} queued, ${out.filter((o) => o.result === 'skipped').length} skipped`);
  void drain();
  bumpReview();
  return out;
};

/** Dismiss: off the Failed list with who / when / why; the row and its files are kept. */
export const dismissFailed = async (ids: string[], remark: string, by: Actor): Promise<BulkResult[]> => {
  if (!ids.length || ids.length > FAILED_ACTIONS.MAX_IDS) throw appError(ERROR_CODES.FIELD_NOT_ID_LIST, 'uploadIds', FAILED_ACTIONS.MAX_IDS);
  const out: BulkResult[] = [];
  for (const u of await repo().findBy({ id: In(ids) })) {
    if (u.status !== UPLOAD_STATUS.FAILED) { out.push({ uploadId: String(u.id), result: 'skipped', reason: `it is ${u.status} now` }); continue; }
    if (dismissedOf(u)) { out.push({ uploadId: String(u.id), result: 'skipped', reason: 'already dismissed' }); continue; }
    await repo().update({ id: u.id }, { errorDetails: { ...(u.errorDetails ?? {}), dismissed: { by: by.email, at: new Date().toISOString(), remark } } });
    out.push({ uploadId: String(u.id), result: 'done', reason: 'dismissed' });
  }
  for (const id of ids) if (!out.some((o) => o.uploadId === id)) out.push({ uploadId: id, result: 'skipped', reason: 'no such PO' });
  bumpReview();
  return out;
};

/** Reopen many rejected POs, each exactly like the single Reopen. */
export const reopenMany = async (ids: string[], remark: string, by: Actor): Promise<BulkResult[]> => {
  if (!ids.length || ids.length > FAILED_ACTIONS.MAX_IDS) throw appError(ERROR_CODES.FIELD_NOT_ID_LIST, 'uploadIds', FAILED_ACTIONS.MAX_IDS);
  const out: BulkResult[] = [];
  for (const id of ids) {
    try {
      const r = await reopenRejected(id, remark, by);
      out.push({ uploadId: id, result: 'done', reason: `back in review (${r.openIssues} issue(s))` });
    } catch (err) {
      out.push({ uploadId: id, result: 'skipped', reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
};
