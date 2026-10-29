import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { FILES, LOCAL_CLEANUP, UPLOAD_STATUS } from '../../constants';
import { PoUpload } from '../../entities';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { groupOfFolder, markLocal, messageKey, recordEmail } from './intake-emails.service';
import { mirrorLater, syncEmailToS3, verifyInS3 } from './s3-mirror.service';
import type { EmailMetadata } from './s3-layout';

/*
 * Local disk = short-term working area (user, 2026-10-23). Removes the local folder of a FINISHED email once every one
 * of its files is confirmed in S3 and it finished at least LOCAL_CLEANUP.MIN_AGE_HOURS ago; the DB (intake_emails)
 * remembers it, so it is never downloaded again and the not-PO report still lists it. Finished = not a PO, or every
 * po_uploads row of it completed / rejected. Everything else keeps its folder (held, queued, reading, in review,
 * waiting for approval, failed, not in the chain yet). Only files under EMAIL_STORAGE_DIR; S3 and Gmail never touched.
 * Dry run by default (npm run storage:cleanup); the server runs it with apply when LOCAL_CLEANUP_ENABLED=true.
 */

const FINISHED: string[] = [UPLOAD_STATUS.COMPLETED, UPLOAD_STATUS.REJECTED];

export interface CleanupItem {
  folder: string;
  remove: boolean;
  reason: string;
  bytes: number;
}

const sizeOf = async (dir: string): Promise<number> => {
  let total = 0;
  for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name);
    total += d.isDirectory() ? await sizeOf(p) : (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
};

/** Every email folder (has metadata.json) one level under each storage group. */
const emailFolders = async (): Promise<string[]> => {
  const root = path.resolve(env.storage.emailDir);
  const out: string[] = [];
  for (const g of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!g.isDirectory()) continue;
    for (const d of await fs.readdir(path.join(root, g.name), { withFileTypes: true }).catch(() => [])) {
      const dir = path.join(root, g.name, d.name);
      if (d.isDirectory() && (await fs.access(path.join(dir, FILES.METADATA)).then(() => true, () => false))) out.push(dir);
    }
  }
  return out.sort();
};

/** Why this folder must stay, or null when it may go (finished long enough ago). Reads only. */
const keepReason = async (dir: string, meta: EmailMetadata): Promise<{ keep: string | null; finishedAt: Date | null }> => {
  if (!meta.messageId) return { keep: 'no message id', finishedAt: null };
  if (groupOfFolder(dir).notPo) return { keep: null, finishedAt: meta.storedAt ? new Date(meta.storedAt) : (await fs.stat(dir)).mtime };
  const rows = await AppDataSource.getRepository(PoUpload).find({ where: { emailMessageId: meta.messageId }, select: ['id', 'status', 'updatedAt'] });
  if (!rows.length) return { keep: 'not in the chain yet (no po_uploads row)', finishedAt: null };
  const open = rows.filter((r) => !FINISHED.includes(r.status));
  if (open.length) return { keep: `PO still ${[...new Set(open.map((r) => r.status))].join(' / ')}`, finishedAt: null };
  return { keep: null, finishedAt: new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))) };
};

/**
 * Decides (and with apply, removes) every local email folder. Returns one item per folder. A folder whose S3 copy is
 * not complete is kept and, with apply, uploaded again (removed on a later run).
 */
export const runLocalCleanup = async (opts: { apply: boolean }): Promise<CleanupItem[]> => {
  if (!AppDataSource.isInitialized) throw new Error('database not connected');
  if (!env.s3.enabled) throw new Error('S3_ENABLED is false: nothing is removed without a confirmed S3 copy');
  const minAgeMs = LOCAL_CLEANUP.MIN_AGE_HOURS * 3_600_000;
  const items: CleanupItem[] = [];
  for (const dir of await emailFolders()) {
    const name = path.relative(path.resolve(env.storage.emailDir), dir);
    const bytes = await sizeOf(dir);
    const item = (remove: boolean, reason: string) => items.push({ folder: name, remove, reason, bytes });
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.METADATA), 'utf8')) as EmailMetadata;
      // Every folder gets its DB row (also the kept ones), so the DB knows every email even if the disk is wiped.
      if (opts.apply) await recordEmail(dir);
      const { keep, finishedAt } = await keepReason(dir, meta);
      if (keep) { item(false, keep); continue; }
      if (finishedAt && Date.now() - finishedAt.getTime() < minAgeMs) { item(false, `finished less than ${LOCAL_CLEANUP.MIN_AGE_HOURS} h ago`); continue; }
      const s3 = await verifyInS3(dir);
      if (s3.missing.length) {
        item(false, `S3 copy not complete (${s3.missing.length} file(s))`);
        if (opts.apply) mirrorLater(`cleanup re-upload ${name}`, () => syncEmailToS3(dir));
        continue;
      }
      if (!opts.apply) { item(true, `finished, all files in ${s3.s3Folder}/`); continue; }
      // The DB must remember it before the folder goes (never downloaded again, still in the not-PO report).
      if (!(await recordEmail(dir))) { item(false, 'could not record it in the DB (intake_emails)'); continue; }
      await fs.rm(dir, { recursive: true, force: true });
      await markLocal(messageKey(meta.messageId!), true);
      item(true, `removed (files in ${s3.s3Folder}/)`);
    } catch (err) {
      item(false, `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }
  const removed = items.filter((i) => i.remove);
  log.info(LOG_SOURCE.APP, `[cleanup] ${opts.apply ? 'removed' : 'would remove'} ${removed.length} of ${items.length} local folder(s), ${(removed.reduce((n, i) => n + i.bytes, 0) / 1_048_576).toFixed(1)} MB`);
  return items;
};

