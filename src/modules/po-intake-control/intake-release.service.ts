import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { In } from 'typeorm';
import { FOLDERS, LABELS, UPLOAD_SOURCE, UPLOAD_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { PoUpload } from '../../entities';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { storedFolderOf } from '../email-intake/email-storage.service';
import { extractPo } from '../ocr/extract-po.service';
import { runChainFor } from '../po-pipeline/pipeline.service';
import type { ResumeItem } from '../po-pipeline/resume.service';
import { channelOfDisplayName, processFromOf, shouldHold } from './intake-settings.service';

/*
 * Held POs go on (user, 2026-10-23: "when switched back on, process all one by one"). Oldest received first, ONE at a time,
 * only those received on / after the channel's "process from",
 * the channel's switch and today's limit checked again before each: a channel ON with room today releases its next
 * held PO; the rest wait (a new day frees the limit). Email: OCR -> chain (only when OCR_ENABLED, else it is queued for
 * resume); API: its folder already has processed.json -> the chain. Called after a switch / limit change, every
 * RELEASE_EVERY_MINUTES and at server start; never two runs at once.
 */

let running = false;

/** The email / API folder of a held row (written when it arrived). */
const folderOf = async (u: PoUpload): Promise<string | null> => {
  if (u.source === UPLOAD_SOURCE.API) {
    if (!u.externalId || !u.emailReceivedAt) return null;
    return path.resolve(env.storage.emailDir, FOLDERS.CHANNEL_API, `${u.emailReceivedAt.toISOString().slice(0, 10)}_${u.externalId.replace(/[^A-Za-z0-9._-]+/g, '_')}`);
  }
  return u.emailMessageId ? ((await storedFolderOf(LABELS.PO_INTAKE, u.emailMessageId)) ?? null) : null;
};

const releaseOne = async (u: PoUpload): Promise<void> => {
  const repo = AppDataSource.getRepository(PoUpload);
  const folder = await folderOf(u);
  if (!folder) {
    await repo.update({ id: u.id }, { status: UPLOAD_STATUS.FAILED, errorDetails: { step: 'release', reason: 'held PO: its stored folder was not found' } });
    return;
  }
  // released_at: it counts against TODAY's limit (it arrived on an earlier day, or while the channel was off).
  await repo.update({ id: u.id }, { status: UPLOAD_STATUS.QUEUED, releasedAt: new Date() });
  if (u.source === UPLOAD_SOURCE.API) await runChainFor(folder);
  else if (env.ocr.enabled) await extractPo(folder);
  else log.info(LOG_SOURCE.OCR, `[intake] ${u.poNumber ?? u.id} released; OCR_ENABLED=false: it waits as queued for resume`);
};

const release = async (): Promise<number> => {
  let n = 0;
  for (;;) {
    // Oldest PO first (the day it was received), so a channel works through its days in order.
    const held = await AppDataSource.getRepository(PoUpload).find({ where: { status: UPLOAD_STATUS.HELD }, order: { emailReceivedAt: 'ASC', id: 'ASC' } });
    let next: PoUpload | undefined;
    for (const u of held) {
      const channel = await channelOfDisplayName(u.channel);
      if (!channel || (await shouldHold(channel))) continue;
      // Received before the channel's "process from" (user, 2026-10-23): stays held, untouched, until the date is
      // moved back to include it.
      const from = await processFromOf(channel);
      if (from && (u.emailReceivedAt ?? u.createdAt) < from) continue;
      next = u;
      break;
    }
    if (!next) return n;
    try {
      await releaseOne(next);
    } catch (err) {
      // One PO that fails never stops the others; the chain records its failure on the row.
      logError(LOG_SOURCE.APP, `[intake] held PO ${next.id} could not be processed`, err);
      await AppDataSource.getRepository(PoUpload).update({ id: next.id, status: UPLOAD_STATUS.QUEUED }, { status: UPLOAD_STATUS.FAILED }).catch(() => undefined);
    }
    n++;
  }
};

/**
 * Server start: an email waiting for OCR (queued, or OCR interrupted) is put on hold instead of being read at once, so
 * the admin's switch + today's limit decide when (kickRelease). An email whose channel is not known is left as it is
 * and NOT read (po:resume by hand). Returns true = handled here.
 */
export const holdForIntake = async (item: ResumeItem): Promise<boolean> => {
  const channel = await channelOfDisplayName(item.rows[0]?.channel ?? null);
  if (!channel) {
    log.info(LOG_SOURCE.APP, `[intake] ${path.basename(item.folder ?? item.messageId)}: channel unknown, not read (npm run po:resume)`);
    return true;
  }
  await AppDataSource.getRepository(PoUpload).update(
    { id: In(item.rows.map((r) => r.id)), status: In([UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.EXTRACTING]) },
    { status: UPLOAD_STATUS.HELD },
  );
  return true;
};

/** Releases what can go now, one PO at a time. Safe to call any time. */
export const kickRelease = (): void => {
  if (running || !AppDataSource.isInitialized) return;
  running = true;
  void runJob('intake-release', async () => {
    const n = await release();
    if (n) log.info(LOG_SOURCE.APP, `[intake] ${n} held PO(s) processed`);
  })
    .catch((err) => {
      // Before the IntakeControl migration nothing is held; the next tick tries again.
      if ((err as { code?: string }).code !== 'ER_NO_SUCH_TABLE') logError(LOG_SOURCE.APP, '[intake] release stopped (continues at the next tick)', err);
    })
    .finally(() => { running = false; });
};
