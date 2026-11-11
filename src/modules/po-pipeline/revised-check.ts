import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ChannelName, REVISED_CHECK, UPLOAD_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { PoUpload } from '../../entities';
import { logError } from '../../utils/classify-error';
import { readS3Bytes, s3FolderFileUrls } from '../email-intake/s3-mirror.service';
import { channelConfigs } from '../ocr/channels.config';
import { excelRows } from '../ocr/excel-rows';

/*
 * A "revised" PO email for a PO we already have (backlog B7 part B, 2026-11-05): Blinkit re-sends POs as "This Purchase
 * Order has been REVISED" although (5 Nov check of all 69 copies on dev) 64 changed nothing in the lines (50 identical,
 * 13 expiry date only, 1 created time only) and 5 corrected one MRP; every line change showed in the PO's sheet, every
 * no-change copy had an identical sheet. So: the new email's sheet is compared with the sheet of the copy already in
 * POST_FG (completed / in review / waiting for approval) BEFORE any OCR. Identical -> the email is not taken (no row, no
 * OCR), like a known PO; different, or anything that cannot be compared -> it goes on as today (OCR -> review as a
 * revised PO). Only for REVISED_CHECK.CHANNELS.
 */

const LIVE: readonly string[] = [UPLOAD_STATUS.COMPLETED, UPLOAD_STATUS.NEEDS_REVIEW, UPLOAD_STATUS.PENDING_APPROVAL];

/** Cells as compared: trimmed, spaces collapsed, case ignored; blank rows dropped. */
const norm = (rows: string[][]): string => JSON.stringify(
  rows.map((r) => r.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim().toLowerCase()))
    .map((r) => { while (r.length && r[r.length - 1] === '') r.pop(); return r; })
    .filter((r) => r.length),
);

const sheetRe = (channel: ChannelName): RegExp | undefined => channelConfigs.find((c) => c.channel === channel)?.files.sheet;

/**
 * The copy already in POST_FG whose sheet is IDENTICAL to this email's, else null (no copy, no sheet on either side,
 * a different sheet, or a read error: the email then goes on as today).
 */
export const unchangedRevision = async (
  channel: ChannelName, displayName: string, poNumber: string, folder: string, messageId: string,
): Promise<{ id: string; status: string } | null> => {
  if (!REVISED_CHECK.CHANNELS.includes(channel)) return null;
  const re = sheetRe(channel);
  if (!re) return null;
  const earlier = await AppDataSource.getRepository(PoUpload).find({
    select: ['id', 'status', 'fileUrl', 'emailMessageId'],
    where: { channel: displayName, poNumber, status: In(LIVE) },
    order: { id: 'DESC' },
  });
  const copy = earlier.find((u) => u.emailMessageId !== messageId && u.fileUrl);
  if (!copy) return null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'revised-'));
  try {
    const mine = (await fs.readdir(folder)).filter((f) => re.test(f));
    const theirs = (await s3FolderFileUrls(copy.fileUrl)).filter((u) => re.test(path.posix.basename(u)));
    if (mine.length !== 1 || theirs.length !== 1) return null;
    const bytes = await readS3Bytes(theirs[0]);
    if (!bytes) return null;
    const theirFile = path.join(tmp, path.posix.basename(theirs[0]));
    await fs.writeFile(theirFile, bytes);
    const [a, b] = await Promise.all([excelRows(path.join(folder, mine[0])), excelRows(theirFile)]);
    return a.length && norm(a) === norm(b) ? { id: String(copy.id), status: copy.status } : null;
  } catch (err) {
    logError(LOG_SOURCE.APP, `[revised-check] ${channel} PO ${poNumber}: sheets could not be compared (goes on as today)`, err);
    return null;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};
