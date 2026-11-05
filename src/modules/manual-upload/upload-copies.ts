import fs from 'fs/promises';
import path from 'path';
import { In, Like, Not } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ChannelName, COPY_ACTION, COPY_WHY, CopyAction, FILE_NAME_PO, FILES, MANUAL_UPLOAD, MANUAL_UPLOAD_STATUS, UPLOAD_STATUS,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { ManualUpload, MasterPurchaseOrder, PoUpload, User } from '../../entities';
import { logError } from '../../utils/classify-error';
import { log } from '../../utils/logger';
import { rejectPo } from '../po-review/po-review-actions.service';
import { bumpReview } from '../po-review/po-review.live';

/*
 * The same PO uploaded again (user 2026-11-05, option 2: "if it is already in review, ask: it is present, process it
 * again?"). At upload, before any OCR: the same file (sha1) or the PO number in the file name (FILE_NAME_PO) found in
 * POST_FG -> the upload is refused with the copies (MANUAL_ALREADY_IN) and the screen asks Open it / Process again /
 * Cancel. Process again = upload with replace: the copy in review is REJECTED, a failed copy DISMISSED (remark: replaced
 * by manual upload #n) when the new upload is processed, so only one copy is ever in review. A copy that is a sale
 * order, waits for approval or is still being read cannot be replaced (MANUAL_ALREADY_BLOCKED, with why).
 * Revert = this file + its calls in manual-upload.service.ts + the FE dialog.
 */

export interface UploadCopy {
  /** po_uploads.id (null: a manual upload not processed yet). */
  uploadId: string | null;
  manualUploadId: string | null;
  poNumber: string | null;
  /** po_uploads status, or the manual upload's when there is no PO row yet. */
  status: string;
  how: 'same file' | 'same PO number';
  action: CopyAction;
  /** Why it cannot be replaced (action blocked). */
  why: string | null;
  fileName: string | null;
  at: string | null;
  by: string | null;
  saleOrderCode: string | null;
}

const uploads = () => AppDataSource.getRepository(PoUpload);
const LIVE_RUNNING: readonly string[] = [UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.HELD, UPLOAD_STATUS.EXTRACTING, UPLOAD_STATUS.PROCESSING];
const dismissed = (u: PoUpload) => !!(u.errorDetails as { dismissed?: unknown } | null)?.dismissed;
const manualIdOf = (messageId: string | null) => messageId?.startsWith(MANUAL_UPLOAD.MESSAGE_ID('')) ? messageId.slice(MANUAL_UPLOAD.MESSAGE_ID('').length) : null;

/** A PO row as a copy (null when it does not count: rejected, or failed + dismissed). */
const asCopy = async (u: PoUpload, how: UploadCopy['how'], users: Map<number, string>, manual?: ManualUpload): Promise<UploadCopy | null> => {
  if (u.status === UPLOAD_STATUS.REJECTED || (u.status === UPLOAD_STATUS.FAILED && dismissed(u))) return null;
  let action: CopyAction = COPY_ACTION.REPLACE;
  let why: string | null = null;
  let saleOrderCode: string | null = null;
  if (u.status === UPLOAD_STATUS.COMPLETED) {
    saleOrderCode = (await AppDataSource.getRepository(MasterPurchaseOrder).findOne({ select: ['uid', 'orderNo1'], where: { channel: u.channel ?? '', poNumber: u.poNumber ?? '' } }))?.orderNo1 ?? null;
    action = COPY_ACTION.BLOCKED;
    why = COPY_WHY.COMPLETED(saleOrderCode);
  } else if (u.status === UPLOAD_STATUS.PENDING_APPROVAL) {
    action = COPY_ACTION.BLOCKED;
    why = COPY_WHY.PENDING_APPROVAL;
  } else if (LIVE_RUNNING.includes(u.status)) {
    action = COPY_ACTION.BLOCKED;
    why = COPY_WHY.RUNNING;
  }
  const manualId = manual ? String(manual.id) : manualIdOf(u.emailMessageId);
  return {
    uploadId: String(u.id), manualUploadId: manualId, poNumber: u.poNumber, status: u.status, how, action, why,
    fileName: u.fileName, at: (manual?.uploadedAt ?? u.createdAt)?.toISOString() ?? null,
    by: manual ? (users.get(manual.uploadedBy) ?? null) : u.emailFrom, saleOrderCode,
  };
};

/** The copies of these files' PO already in POST_FG (same file, or the PO number in the file name). */
export const findCopies = async (channel: ChannelName, displayName: string, files: { filename: string; sha1: string }[]): Promise<UploadCopy[]> => {
  const out = new Map<string, UploadCopy>();
  const hashes = new Set(files.map((f) => f.sha1));
  const earlier = (await AppDataSource.getRepository(ManualUpload).find({ where: { status: Not(MANUAL_UPLOAD_STATUS.CANCELLED) } }))
    .filter((m) => m.files.some((f) => hashes.has(f.sha1)));
  const users = new Map((await AppDataSource.getRepository(User).find({ select: ['id', 'email'], where: { id: In([...new Set(earlier.map((m) => m.uploadedBy)), 0]) } })).map((u) => [u.id, u.email]));
  for (const m of earlier) {
    const rows = await uploads().findBy({ emailMessageId: MANUAL_UPLOAD.MESSAGE_ID(String(m.id)) });
    for (const r of rows) {
      const c = await asCopy(r, 'same file', users, m);
      if (c) out.set(`u${r.id}`, c);
    }
    // uploaded / queued / being processed and no PO row yet: that upload first
    if (!rows.length && m.status !== MANUAL_UPLOAD_STATUS.FAILED && m.status !== MANUAL_UPLOAD_STATUS.DONE) {
      out.set(`m${m.id}`, {
        uploadId: null, manualUploadId: String(m.id), poNumber: null, status: m.status, how: 'same file', action: COPY_ACTION.BLOCKED,
        why: m.status === MANUAL_UPLOAD_STATUS.UPLOADED ? COPY_WHY.NOT_PROCESSED : COPY_WHY.RUNNING,
        fileName: m.files[0]?.filename ?? null, at: m.uploadedAt.toISOString(), by: users.get(m.uploadedBy) ?? null, saleOrderCode: null,
      });
    }
  }
  const rule = FILE_NAME_PO[channel];
  if (rule) {
    for (const f of files) {
      const n = rule.re.exec(f.filename)?.[1];
      if (!n) continue;
      const rows = await uploads().find({ where: { channel: displayName, poNumber: rule.prefix ? Like(`${rule.prefix(n)}%`) : n } });
      for (const r of rows) {
        if (out.has(`u${r.id}`)) continue;
        const c = await asCopy(r, 'same PO number', users);
        if (c) out.set(`u${r.id}`, c);
      }
    }
  }
  return [...out.values()];
};

/** The copies a new upload replaces (Process again), kept in its metadata.json until it is processed. */
export const REPLACES_KEY = 'replaces';

/**
 * When the new upload is processed (before its OCR): its old copies are taken out of the way, so only the new one is
 * in review: in review -> rejected, failed -> dismissed (remark: replaced by manual upload #n). A copy that moved on
 * meanwhile (approved, completed ...) is left as it is (the new one is then flagged as a duplicate by validation).
 */
export const replaceOldCopies = async (manual: ManualUpload): Promise<void> => {
  const meta = JSON.parse(await fs.readFile(path.join(manual.folder, FILES.METADATA), 'utf8').catch(() => '{}')) as { [REPLACES_KEY]?: string[]; uploadedBy?: string };
  const ids = meta[REPLACES_KEY] ?? [];
  if (!ids.length) return;
  const by = { id: manual.uploadedBy, email: meta.uploadedBy ?? `user ${manual.uploadedBy}` };
  const remark = MANUAL_UPLOAD.REPLACED_REMARK(String(manual.id));
  for (const u of await uploads().findBy({ id: In(ids) })) {
    try {
      if (u.status === UPLOAD_STATUS.NEEDS_REVIEW) await rejectPo(String(u.id), remark, by);
      else if (u.status === UPLOAD_STATUS.FAILED && !dismissed(u)) {
        await uploads().update({ id: u.id }, { errorDetails: { ...(u.errorDetails ?? {}), dismissed: { by: by.email, at: new Date().toISOString(), remark } } });
      } else {
        log.info(LOG_SOURCE.APP, `[manual-upload] ${manual.id}: old copy upload ${u.id} is ${u.status} now, left as it is`);
        continue;
      }
      log.info(LOG_SOURCE.APP, `[manual-upload] ${manual.id}: old copy upload ${u.id} (${u.status}) replaced`);
    } catch (err) {
      logError(LOG_SOURCE.APP, `[manual-upload] ${manual.id}: old copy upload ${u.id} could not be replaced`, err);
    }
  }
  bumpReview();
};
