import fs from 'fs/promises';
import path from 'path';
import { DataSource, In } from 'typeorm';
import {
  ERROR_CODES,
  errorMessage,
  FILES,
  FOLDERS,
  LABELS,
  MAX_OCR_ATTEMPTS,
  PIPELINE_STEP,
  RESULT_STATUS,
  RESUME_ACTION,
  ResumeAction,
  UPLOAD_SOURCE,
  UPLOAD_STATUS,
} from '../../constants';
import { PoUpload } from '../../entities';
import { storedFolderOf } from '../email-intake/email-storage.service';
import { ocrFinished, runFromProcessing, takeSlot } from './pipeline.service';
import { finishCsv } from './po-save.service';
import { readFolderPos } from './po-uploads.service';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { logError } from '../../utils/classify-error';

/*
 * Resume after a restart (decided 2026-10-08): po_uploads.status is the to-do list.
 *   queued                         -> OCR
 *   extracting, no OCR output      -> OCR again (attempts + 1; stops at MAX_OCR_ATTEMPTS)
 *   extracting, OCR output there   -> the OCR finished: on with the chain (or failed, if the OCR failed)
 *   processing, no po_uid          -> processed.json -> validation -> save
 *   processing, po_uid set         -> only upload the CSV the save wrote, and complete
 *   failed                         -> only with retryFailed (po:resume --retry-failed), from the step it failed at
 *   needs_review / completed / rejected -> nothing (a person, or done)
 * planResume() only reads; applyResume() does the work, one email at a time, within PIPELINE_LIMIT.
 */

export interface ResumeItem {
  /** One email: its rows share email_message_id (one per PO after processing). */
  messageId: string;
  folder: string | null;
  rows: PoUpload[];
  action: ResumeAction;
  /** Why (shown in the dry run; the skip reason). */
  reason: string;
}

const hasOcrOutput = async (folder: string): Promise<{ status?: string; code?: string; reason?: string } | null> => {
  try {
    return JSON.parse(await fs.readFile(path.join(folder, FILES.OCR_RESULT), 'utf8'));
  } catch {
    return null;
  }
};

/** The local storage group of a row: email intake under the label, manual uploads under manual/. */
const groupOf = (row: PoUpload): string => (row.source === UPLOAD_SOURCE.EMAIL ? LABELS.PO_INTAKE : FOLDERS.MANUAL);

const decide = async (rows: PoUpload[], folder: string, retryFailed: boolean): Promise<{ action: ResumeAction; reason: string }> => {
  const has = (s: string) => rows.some((r) => r.status === s);
  const attempts = Math.max(...rows.map((r) => r.ocrAttempts));
  const ocrAgain = (why: string) =>
    attempts >= MAX_OCR_ATTEMPTS
      ? { action: RESUME_ACTION.SKIP, reason: errorMessage(ERROR_CODES.TOO_MANY_OCR_ATTEMPTS, attempts, MAX_OCR_ATTEMPTS) }
      : { action: RESUME_ACTION.OCR, reason: why };

  if (rows.some((r) => r.status === UPLOAD_STATUS.PROCESSING && r.poUid)) return { action: RESUME_ACTION.CSV_ONLY, reason: 'PO rows saved, CSV not uploaded' };
  if (has(UPLOAD_STATUS.PROCESSING)) return { action: RESUME_ACTION.PROCESS, reason: 'validated, not saved' };
  if (has(UPLOAD_STATUS.EXTRACTING)) {
    return (await hasOcrOutput(folder)) ? { action: RESUME_ACTION.PROCESS, reason: 'OCR finished, chain stopped' } : ocrAgain('OCR interrupted');
  }
  if (has(UPLOAD_STATUS.QUEUED)) return ocrAgain('waiting for OCR');
  if (retryFailed && has(UPLOAD_STATUS.FAILED)) {
    const step = rows.map((r) => (r.errorDetails as { step?: string } | null)?.step).find(Boolean);
    if (step === PIPELINE_STEP.UNIWARE_CSV && rows.some((r) => r.poUid)) return { action: RESUME_ACTION.CSV_ONLY, reason: 'retry: CSV' };
    if (step === PIPELINE_STEP.OCR || !(await hasOcrOutput(folder))) return ocrAgain('retry: OCR');
    return { action: RESUME_ACTION.PROCESS, reason: `retry: ${step ?? 'processing'}` };
  }
  return { action: RESUME_ACTION.SKIP, reason: 'nothing to resume' };
};

/** What resume would do, per email, oldest first. Reads only. */
export const planResume = async (db: DataSource, retryFailed = false): Promise<ResumeItem[]> => {
  const statuses: string[] = [UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.EXTRACTING, UPLOAD_STATUS.PROCESSING];
  if (retryFailed) statuses.push(UPLOAD_STATUS.FAILED);
  const open = await db.getRepository(PoUpload).find({ where: { status: In(statuses) }, order: { id: 'ASC' } });

  const byMessage = new Map<string, PoUpload[]>();
  for (const r of open) if (r.emailMessageId) byMessage.set(r.emailMessageId, [...(byMessage.get(r.emailMessageId) ?? []), r]);

  const items: ResumeItem[] = [];
  for (const [messageId, rows] of byMessage) {
    const folder = (await storedFolderOf(groupOf(rows[0]), messageId)) ?? null;
    if (!folder) {
      items.push({ messageId, folder, rows, action: RESUME_ACTION.SKIP, reason: errorMessage(ERROR_CODES.EMAIL_FOLDER_NOT_FOUND, messageId) });
      continue;
    }
    items.push({ messageId, folder, rows, ...(await decide(rows, folder, retryFailed)) });
  }
  return items;
};

export interface ResumeOptions {
  /** How to run the OCR on a folder: the server queues it (background), a script waits for it. */
  runOcr: (folder: string) => Promise<void>;
  /** Most emails to resume in this run (on top of PIPELINE_LIMIT); 0 = all. */
  max?: number;
  /** Server start (PO intake, 2026-10-23): true = this OCR item was handed to the intake release (held), skip it here. */
  holdOcr?: (item: ResumeItem) => Promise<boolean>;
}

/** Resumes the planned emails one at a time; stops when PIPELINE_LIMIT or `max` is reached. Returns how many ran. */
export const applyResume = async (db: DataSource, items: ResumeItem[], opts: ResumeOptions): Promise<number> => {
  let done = 0;
  for (const item of items) {
    if (item.action === RESUME_ACTION.SKIP || !item.folder) continue;
    if (opts.max && done >= opts.max) break;
    if (item.action === RESUME_ACTION.OCR && opts.holdOcr && (await opts.holdOcr(item))) continue;
    if (!takeSlot()) {
      log.info(LOG_SOURCE.APP, `[resume] PIPELINE_LIMIT reached; the rest wait for the next run`);
      break;
    }
    done++;
    const name = path.basename(item.folder);
    log.info(LOG_SOURCE.APP, `[resume] ${name}: ${item.action} (${item.reason})`);
    try {
      if (item.action === RESUME_ACTION.OCR) await opts.runOcr(item.folder);
      else if (item.action === RESUME_ACTION.PROCESS) {
        const ocr = await hasOcrOutput(item.folder);
        if (ocr && ocr.status !== RESULT_STATUS.OK) await ocrFinished(item.folder, { status: ocr.status ?? RESULT_STATUS.FAILED, code: ocr.code, reason: ocr.reason });
        else await runFromProcessing(item.folder);
      } else if (item.action === RESUME_ACTION.CSV_ONLY) {
        const pos = await readFolderPos(item.folder);
        for (const row of item.rows.filter((r) => r.poUid)) {
          const relPath = pos.find((p) => p.po.po_number === row.poNumber)?.relPath ?? FILES.PROCESSED;
          log.info(LOG_SOURCE.APP, `[resume] ${name}: ${row.poNumber} CSV -> ${await finishCsv(db, item.folder, row, relPath)}`);
        }
      }
    } catch (err) {
      logError(LOG_SOURCE.APP, `[resume] ${name}: failed (taken again on the next resume)`, err);
    }
  }
  return done;
};
