import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ChannelName, FILES, PIPELINE_STEP, PO_INTAKE, PROVIDERS, RESULT_STATUS, UPLOAD_OCR_STATUS, UPLOAD_STATUS } from '../../constants';
import { PoUpload } from '../../entities';
import { detectChannel, emailInfo, StoredMetadata } from '../ocr/channel-detector';
import { processPo } from '../po-processing/po-router';
import { MasterDataReader } from '../po-validation/master-data';
import { alreadyHavePo, intakeGate, processFromOf, shouldHold } from '../po-intake-control/intake-settings.service';
import { applySave, planSave } from './po-save.service';
import { applyPlan, emailValues, planEmail } from './po-uploads.service';
import { LOG_SOURCE } from '../../constants/logging';
import { log as appLog } from '../../utils/logger';
import { logError } from '../../utils/classify-error';
import { step } from '../../utils/log-call';

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

const log = (folder: string, msg: string): void => appLog.info(LOG_SOURCE.APP, `[pipeline] ${path.basename(folder)}: ${msg}`);

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
    logError(LOG_SOURCE.APP, `[pipeline] ${path.basename(folder)}: ${step} failed (po:resume takes it again)`, err, { step });
  }
};

/*
 * PIPELINE_LIMIT (testing): at most N emails per process start go into the chain, new intake and resume together.
 * 0 = no limit (production). Once the N are taken, intake STOPS (user, 2026-10-15: "everything for 5 emails and
 * stop"): no more emails are read from Gmail, stored or copied to S3; they stay unsent and the next start takes them.
 * (An email over the limit that still arrives, e.g. a manual upload, is only stored as files: no row, no OCR.)
 */
let taken = 0;
const limitReached = (): boolean => env.pipeline.limit > 0 && taken >= env.pipeline.limit;
/** True when PIPELINE_LIMIT places are all taken: intake stops reading and storing emails. */
export const pipelineFull = (): boolean => limitReached();

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
  // Fails closed (2026-10-23): any error here = no OCR now; the email has no row, so the next start's backlog takes it.
  let allowed = false;
  await safely(folder, 'emailStored', async () => {
    const { meta, messageId } = await messageIdOf(folder);
    if (!messageId || (await rowsOf(messageId)).length) { allowed = true; return; }
    // PO intake per channel (2026-10-23): OFF or over today's limit -> stored, row "held", no OCR. A person's manual
    // upload is never held.
    const detectedFirst = detectChannel(emailInfo(meta));
    const heldChannel = 'config' in detectedFirst && (meta as { provider?: string }).provider !== PROVIDERS.MANUAL ? detectedFirst.config.channel : null;
    if (heldChannel) {
      // Older than the channel's "process from" (an email stored before the start was set): no row, no OCR.
      const from = await processFromOf(heldChannel);
      const received = (meta as { receivedAt?: string }).receivedAt;
      if (from && received && !Number.isNaN(Date.parse(received)) && new Date(received) < from) {
        allowed = false;
        log(folder, `received before ${heldChannel}'s process-from (${from.toISOString()}): not taken`);
        return;
      }
      const config = 'config' in detectedFirst ? detectedFirst.config : null;
      const poNumber = config?.poNumber ? meta.subject?.match(config.poNumber)?.[1] : undefined;
      const body = await fs.readFile(path.join(folder, FILES.BODY_TEXT), 'utf8').catch(() => '');
      const have = poNumber && !PO_INTAKE.REVISED_HINT.test(`${meta.subject ?? ''} ${body}`) ? await alreadyHavePo(heldChannel, poNumber) : null;
      if (have) {
        allowed = false;
        log(folder, `PO ${poNumber} is already in POST_FG (${have}): no OCR, not taken again`);
        return;
      }
    }
    if (heldChannel && (await shouldHold(heldChannel))) {
      const master = await new MasterDataReader(AppDataSource).forChannel(heldChannel as ChannelName);
      const repo = AppDataSource.getRepository(PoUpload);
      const row = await repo.save(repo.create({ ...(await emailValues(folder, master?.channel.displayName ?? null)), status: UPLOAD_STATUS.HELD }));
      allowed = false;
      log(folder, `po_uploads ${row.id} held: ${heldChannel} is off or over its limit today`);
      return;
    }
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
    allowed = true;
  });
  return allowed;
};

/**
 * Start-up OCR backlog (stored emails with no OCR result): only an email POST_FG has no row for goes through
 * emailStored (process-from, duplicate, ON / OFF + limit -> held); an email with a row is resume's / release's job.
 */
export const admitToOcr = async (folder: string): Promise<boolean> => {
  if (!on()) return false;
  const read = await messageIdOf(folder).catch(() => null);
  if (!read?.messageId || (await rowsOf(read.messageId)).length) return false;
  // Channel OFF / before its start: no row either (user: "OFF channels never reach the DB"); switching the channel on
  // takes it then (the catch-up finds it stored and comes back here).
  const detected = detectChannel(emailInfo(read.meta));
  const received = (read.meta as { receivedAt?: string }).receivedAt;
  if ('config' in detected && (await intakeGate(detected.config.channel, received && !Number.isNaN(Date.parse(received)) ? new Date(received) : null)) !== 'take') return false;
  return emailStored(folder);
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

/** The po_uploads statuses of a stored email / API folder ([] when it has no row yet). For the PO jobs worker. */
export const statusesOf = async (folder: string): Promise<string[]> => {
  if (!on()) return [];
  const { messageId } = await messageIdOf(folder);
  return messageId ? (await rowsOf(messageId)).map((r) => r.status) : [];
};

/** A queued job failed on its last try (PO jobs worker): its rows are marked failed with the reason. */
export const jobFailed = (folder: string, reason: string): Promise<void> =>
  safely(folder, 'jobFailed', () => markFailed(folder, { step: PIPELINE_STEP.PROCESSING, reason }, false));

/** processed.json -> validation + po_issues (step 1) -> PO tables + sale order + CSV (step 2). */
export const runFromProcessing = (folder: string): Promise<void> =>
  safely(folder, 'processing', async () => {
    const p = await step('make processed.json', () => processPo(folder));
    if (p.status !== RESULT_STATUS.OK) {
      await markFailed(folder, { step: PIPELINE_STEP.PROCESSING, code: p.code ?? null, reason: p.reason ?? null }, false);
      return;
    }
    await chain(folder);
  });

/**
 * A folder that already has its processed.json (a channel API PO, 2026-10-16): the same chain from validation on.
 * Unlike runFromProcessing it throws, so the connector counts the shipment as failed and tries it again next run.
 */
export const runChainFor = async (folder: string): Promise<{ poNumber: string; status: string; saleOrder?: string; error?: string }[]> => {
  if (!on()) return [];
  return chain(folder);
};

/** Step 1 (po_uploads + po_issues) then step 2 (PO tables + sale order + CSV) for every PO of the folder. */
const chain = async (folder: string): Promise<{ poNumber: string; status: string; saleOrder?: string; error?: string }[]> => {
  const out: { poNumber: string; status: string; saleOrder?: string; error?: string }[] = [];
  {
    // steps (2026-10-27): the log shows which part of the chain a PO failed in
    const plan = await step('validate + po_issues', async () => {
      const p = await planEmail(AppDataSource, new MasterDataReader(AppDataSource), folder);
      await applyPlan(AppDataSource, p);
      return p;
    });
    for (const r of plan.rows) {
      log(folder, r.final ? `${r.poNumber}: already ${r.existing?.status}, unchanged` : `${r.poNumber}: ${r.status}${r.issues.create.length ? ` (${r.issues.create.length} new issue(s))` : ''}`);
      out.push({ poNumber: r.poNumber, status: r.final ? (r.existing?.status ?? r.status) : r.status });
    }

    // Step 2 reads the rows step 1 just wrote.
    const saved = await step('save PO + sale order + CSV', async () => {
      const fresh = await planEmail(AppDataSource, new MasterDataReader(AppDataSource), folder);
      return applySave(AppDataSource, folder, await planSave(AppDataSource, fresh));
    });
    for (const s of saved) {
      log(folder, s.error ? `${s.poNumber}: save FAILED: ${s.error}` : `${s.poNumber}: completed, sale order ${s.code}, CSV ${s.csvUrl}`);
      const o = out.find((x) => x.poNumber === s.poNumber);
      if (o) Object.assign(o, s.error ? { status: UPLOAD_STATUS.FAILED, error: s.error } : { status: UPLOAD_STATUS.COMPLETED, saleOrder: s.code });
    }
  }
  return out;
};

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
