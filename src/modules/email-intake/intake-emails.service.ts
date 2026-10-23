import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { FILES, FOLDERS, INTAKE_EMAIL_KIND } from '../../constants';
import { IntakeEmail } from '../../entities';
import { LOG_SOURCE } from '../../constants/logging';
import { logError } from '../../utils/classify-error';
import { detectChannel, emailInfo } from '../ocr/channel-detector';
import type { EmailMetadata } from './s3-layout';

/*
 * intake_emails (2026-10-23): the DB memory of every stored email / API / manual PO folder, so the local folder can be
 * removed once the PO is finished and its files are in S3 (local-cleanup.service.ts). Written when an email is stored,
 * sorted and copied to S3, and by the cleanup's scan (which also fills rows for folders stored before this table).
 * Everything here is best effort: before the LocalStorageDb migration (no table) or without a DB nothing is recorded
 * and the local folders keep working as before.
 */

/** Short, stable key for a Message-ID (Message-IDs are long and full of <>@); local folder names end with it. */
export const messageKey = (messageId: string): string => crypto.createHash('sha1').update(messageId).digest('hex').slice(0, 16);

const ready = (): boolean => AppDataSource.isInitialized;
const repo = () => AppDataSource.getRepository(IntakeEmail);
const noTable = (err: unknown): boolean => (err as { code?: string }).code === 'ER_NO_SUCH_TABLE';

/** A folder's storage group without -not-po, and whether it sits in the not-PO folder. */
export const groupOfFolder = (folder: string): { groupName: string; notPo: boolean } => {
  const parent = path.basename(path.dirname(path.resolve(folder)));
  const notPo = parent.endsWith(FOLDERS.NOT_PO_SUFFIX);
  return { groupName: notPo ? parent.slice(0, -FOLDERS.NOT_PO_SUFFIX.length) : parent, notPo };
};

const asDate = (v?: string): Date | null => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/** Creates or updates the row of one stored folder from its metadata.json (+ reason.json when not a PO). */
export const recordEmail = async (folder: string): Promise<IntakeEmail | null> => {
  if (!ready()) return null;
  try {
    const dir = path.resolve(folder);
    const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.METADATA), 'utf8')) as EmailMetadata & { files?: ({ filename: string } | string)[] };
    if (!meta.messageId) return null;
    const { groupName, notPo } = groupOfFolder(dir);
    const reason = notPo
      ? (JSON.parse(await fs.readFile(path.join(dir, FILES.NOT_PO_REASON), 'utf8').catch(() => '{}')) as { code?: string; reason?: string })
      : {};
    const info = emailInfo(meta);
    const detected = detectChannel(info);
    const key = messageKey(meta.messageId);
    const row = (await repo().findOneBy({ messageKey: key })) ?? repo().create({ messageKey: key, localRemovedAt: null });
    return await repo().save({
      ...row,
      messageId: meta.messageId,
      provider: meta.provider ?? null,
      groupName,
      kind: notPo ? INTAKE_EMAIL_KIND.NOT_PO : INTAKE_EMAIL_KIND.PO,
      channel: meta.channel ?? ('config' in detected ? detected.config.channel : null),
      fromAddress: info.from ? info.from.slice(0, 320) : null,
      subject: info.subject ?? null,
      receivedAt: asDate(meta.receivedAt),
      storedAt: asDate(meta.storedAt) ?? row.storedAt ?? new Date(),
      folderName: path.basename(dir),
      s3Folder: meta.s3Folder ?? row.s3Folder ?? null,
      files: (meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename)),
      notPoCode: notPo ? (reason.code ?? null) : null,
      notPoReason: notPo ? (reason.reason ?? '').slice(0, 500) || null : null,
      updatedAt: new Date(),
    });
  } catch (err) {
    if (!noTable(err)) logError(LOG_SOURCE.APP, `[intake-emails] ${path.basename(folder)}: could not record (the next cleanup scan retries)`, err);
    return null;
  }
};

/** The row of an email by its Message-ID, or null (no row, no table, no DB). */
export const knownEmail = async (messageId: string): Promise<IntakeEmail | null> => {
  if (!ready()) return null;
  try {
    return await repo().findOneBy({ messageKey: messageKey(messageId) });
  } catch (err) {
    if (noTable(err)) return null;
    throw err;
  }
};

/** Not-PO rows of a group (the not-PO report and the re-check after a new channel use them). */
export const notPoRows = async (groupName: string): Promise<IntakeEmail[]> => {
  if (!ready()) return [];
  try {
    return await repo().findBy({ groupName, kind: INTAKE_EMAIL_KIND.NOT_PO });
  } catch (err) {
    if (noTable(err)) return [];
    throw err;
  }
};

/** The local folder of this row was removed (files in S3) or brought back (restored from S3). */
export const markLocal = async (messageKeyValue: string, removed: boolean, kind?: IntakeEmail['kind']): Promise<void> => {
  if (!ready()) return;
  await repo().update({ messageKey: messageKeyValue }, { localRemovedAt: removed ? new Date() : null, ...(kind ? { kind } : {}), updatedAt: new Date() });
};
