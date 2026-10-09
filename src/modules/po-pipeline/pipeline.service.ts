import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ChannelName, FILES, PIPELINE_STEP, RESULT_STATUS, UPLOAD_OCR_STATUS, UPLOAD_STATUS } from '../../constants';
import { PoUpload } from '../../entities';
import { detectChannel, emailInfo, StoredMetadata } from '../ocr/channel-detector';
import { processPo } from '../po-processing/po-router';
import { MasterDataReader } from '../po-validation/master-data';
import { applySave, planSave } from './po-save.service';
import { applyPlan, emailValues, planEmail } from './po-uploads.service';

/*
 * The chain from a stored email to a saved PO (user, 2026-10-08), with po_uploads updated at every step:
 *
 *   intake stores a PO email   -> emailStored():  one po_uploads row for the email (queued / ocr pending)
 *   OCR starts                 -> ocrStarted():   extracting / ocr running, ocr_started_at, ocr_attempts + 1
 *   OCR ends                   -> ocrFinished():  failed / ocr error (+ error_details), or on success:
 *   processed.json             -> processPo()     (a failure: failed + error_details)
 *   validation + po_issues     -> step 1          (one row per PO; needs_review or processing)
 *   PO tables + CSV            -> step 2          (completed, or failed + error_details)
 *
 * Runs only when the database is connected (the server and ocr:run connect when DB_ENABLED=true; po:pipeline always). It never throws into the intake or the OCR: a problem
 * is logged and kept in po_uploads.error_details.
 */

const on = (): boolean => AppDataSource.isInitialized;

const log = (folder: string, msg: string): void => console.log(`[pipeline] ${path.basename(folder)}: ${msg}`);

const messageIdOf = async (folder: string): Promise<{ meta: StoredMetadata & { messageId?: string }; messageId: string | null }> => {
  const meta = JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as StoredMetadata & { messageId?: string };
  return { meta, messageId: meta.messageId ?? null };
};

/** The po_uploads rows of an email (one before processing, one per PO after). */
const rowsOf = async (messageId: string): Promise<PoUpload[]> => AppDataSource.getRepository(PoUpload).findBy({ emailMessageId: messageId });

const safely = async (folder: string, step: string, fn: () => Promise<void>): Promise<void> => {
  if (!on()) return;
  try {
    await fn();
  } catch (err) {
    console.error(`[pipeline] ${path.basename(folder)}: ${step} failed:`, err instanceof Error ? err.message : err);
  }
};

/*
 * PIPELINE_LIMIT (testing): at most N emails per process start go into the chain, new intake and resume together.
 * 0 = no limit (production). An email over the limit is only stored as files: no po_uploads row, no OCR.
 */
let taken = 0;
const limitReached = (): boolean => env.pipeline.limit > 0 && taken >= env.pipeline.limit;
/** Takes one place in the chain; false when PIPELINE_LIMIT is reached. */
export const takeSlot = (): boolean => {
  if (limitReached()) return false;
  taken++;
  return true;
};

/**
 * A PO email was stored (intake): its po_uploads row, if it has none yet. Returns whether the email goes on into the
 * chain (so the caller starts the OCR): false when PIPELINE_LIMIT is reached; true when the database is not connected
 * (no chain, the old behaviour).
 */
export const emailStored = async (folder: string): Promise<boolean> => {
  if (!on()) return true;
  let allowed = true;
  await safely(folder, 'emailStored', async () => {
    const { meta, messageId } = await messageIdOf(folder);
    if (!messageId || (await rowsOf(messageId)).length) return;
    if (!takeSlot()) {
      allowed = false;
      log(folder, `PIPELINE_LIMIT ${env.pipeline.limit} reached: stored as files only (no po_uploads row, no OCR)`);
      return;
    }
    const detected = detectChannel(emailInfo(meta));
    const channel = 'config' in detected ? detected.config.channel : null;
    const master = channel ? await new MasterDataReader(AppDataSource).forChannel(channel as ChannelName) : null;
    const repo = AppDataSource.getRepository(PoUpload);
    const row = await repo.save(repo.create({ ...(await emailValues(folder, master?.channel.displayName ?? null)), status: UPLOAD_STATUS.QUEUED }));
    log(folder, `po_uploads ${row.id} queued`);
  });
  return allowed;
};

/** The OCR started on this email. */
export const ocrStarted = (folder: string): Promise<void> =>
  safely(folder, 'ocrStarted', async () => {
    const { messageId } = await messageIdOf(folder);
    if (!messageId) return;
    const repo = AppDataSource.getRepository(PoUpload);
    for (const r of await rowsOf(messageId)) {
      await repo.save({ ...r, status: UPLOAD_STATUS.EXTRACTING, ocrStatus: UPLOAD_OCR_STATUS.RUNNING, ocrStartedAt: new Date(), ocrAttempts: r.ocrAttempts + 1 });
    }
    log(folder, 'OCR running');
  });

/** Marks every row of the email failed (OCR or processing did not work). */
const markFailed = async (folder: string, details: Record<string, unknown>, ocrFailed: boolean): Promise<void> => {
  const { messageId } = await messageIdOf(folder);
  if (!messageId) return;
  const repo = AppDataSource.getRepository(PoUpload);
  for (const r of await rowsOf(messageId)) {
    await repo.save({
      ...r,
      status: UPLOAD_STATUS.FAILED,
      ...(ocrFailed ? { ocrStatus: UPLOAD_OCR_STATUS.ERROR, ocrFinishedAt: new Date() } : {}),
      errorDetails: details,
    });
  }
  log(folder, `failed at ${String(details.step)}: ${String(details.reason ?? '')}`);
};

/** processed.json -> validation + po_issues (step 1) -> PO tables + sale order + CSV (step 2). */
export const runFromProcessing = (folder: string): Promise<void> =>
  safely(folder, 'processing', async () => {
    const p = await processPo(folder);
    if (p.status !== RESULT_STATUS.OK) {
      await markFailed(folder, { step: PIPELINE_STEP.PROCESSING, code: p.code ?? null, reason: p.reason ?? null }, false);
      return;
    }
    const plan = await planEmail(AppDataSource, new MasterDataReader(AppDataSource), folder);
    await applyPlan(AppDataSource, plan);
    for (const r of plan.rows) {
      log(folder, r.final ? `${r.poNumber}: already ${r.existing?.status}, unchanged` : `${r.poNumber}: ${r.status}${r.issues.create.length ? ` (${r.issues.create.length} new issue(s))` : ''}`);
    }

    // Step 2 reads the rows step 1 just wrote.
    const fresh = await planEmail(AppDataSource, new MasterDataReader(AppDataSource), folder);
    for (const s of await applySave(AppDataSource, folder, await planSave(AppDataSource, fresh))) {
      log(folder, s.error ? `${s.poNumber}: save FAILED: ${s.error}` : `${s.poNumber}: completed, sale order ${s.code}, CSV ${s.csvUrl}`);
    }
  });

/** The OCR finished (ok, skipped or failed). */
export const ocrFinished = (folder: string, result: { status: string; code?: string; reason?: string }): Promise<void> =>
  safely(folder, 'ocrFinished', async () => {
    if (result.status !== RESULT_STATUS.OK) {
      await markFailed(folder, { step: PIPELINE_STEP.OCR, status: result.status, code: result.code ?? null, reason: result.reason ?? null }, true);
      return;
    }
    log(folder, 'OCR ok');
    await runFromProcessing(folder);
  });
