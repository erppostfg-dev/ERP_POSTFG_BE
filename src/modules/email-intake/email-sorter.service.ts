import fs from 'fs/promises';
import path from 'path';
import { FILES } from '../../constants';
import { detectChannel, emailInfo, NotPoCode, StoredMetadata } from '../ocr/channel-detector';
import { NOT_PO_SUFFIX } from './email-storage.service';
import { EmailMetadata, plannedS3Folder } from './s3-layout';
import { groupOfFolder, markLocal, notPoRows, recordEmail } from './intake-emails.service';
import { downloadS3Folder } from './s3-mirror.service';
import { INTAKE_EMAIL_KIND } from '../../constants';

const REASON_FILE = FILES.NOT_PO_REASON;
const REPORT_FILE = FILES.NOT_PO_REPORT;

export interface NotPoReason {
  code: NotPoCode;
  reason: string;
  from?: string;
  subject?: string;
  receivedAt?: string;
  files: string[];
  sortedAt: string;
}

export type SortResult =
  | { isPo: true; channel: string; folder: string }
  | { isPo: false; code: NotPoCode; reason: string; folder: string };

const readMeta = async (folder: string): Promise<StoredMetadata & { receivedAt?: string }> =>
  JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as StoredMetadata & { receivedAt?: string };

const csvCell = (v: string | undefined): string => `"${(v ?? '').replace(/"/g, '""')}"`;

/**
 * Rewrites <group>-not-po/report.csv from every reason.json in it, newest first:
 * one row per email, to see why non-PO mail reaches the label and tune the Gmail filter.
 */
export const writeNotPoReport = async (notPoDir: string): Promise<number> => {
  const rows: (NotPoReason & { folder: string; s3Folder: string })[] = [];
  for (const d of await fs.readdir(notPoDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    try {
      const dir = path.join(notPoDir, d.name);
      const r = JSON.parse(await fs.readFile(path.join(dir, REASON_FILE), 'utf8')) as NotPoReason;
      const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.METADATA), 'utf8')) as EmailMetadata;
      rows.push({ ...r, folder: d.name, s3Folder: `${meta.s3Folder ?? plannedS3Folder(dir, meta)}/` });
    } catch {
      // a folder without reason.json is not ours
    }
  }
  // Not-PO emails whose local copy was removed (files in S3) are still listed, from the DB (2026-10-23).
  const onDisk = new Set(rows.map((r) => r.folder));
  for (const r of await notPoRows(groupOfFolder(path.join(notPoDir, '_')).groupName)) {
    if (onDisk.has(r.folderName)) continue;
    rows.push({
      code: (r.notPoCode ?? '') as NotPoCode, reason: r.notPoReason ?? '', from: r.fromAddress ?? undefined, subject: r.subject ?? undefined,
      receivedAt: r.receivedAt?.toISOString(), files: r.files ?? [], sortedAt: '', folder: r.folderName, s3Folder: r.s3Folder ? `${r.s3Folder}/` : '',
    });
  }
  rows.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));

  const header = ['receivedAt', 'from', 'subject', 'code', 'reason', 'files', 'folder', 's3_folder'];
  const lines = rows.map((r) =>
    [r.receivedAt, r.from, r.subject, r.code, r.reason, r.files.join(' | '), r.folder, r.s3Folder].map(csvCell).join(','),
  );
  await fs.mkdir(notPoDir, { recursive: true });
  await fs.writeFile(path.join(notPoDir, REPORT_FILE), [header.join(','), ...lines].join('\r\n') + '\r\n', 'utf8');
  return rows.length;
};

/**
 * Checks one stored email (storage/emails/<group>/<folder>/) with the channel rules.
 * A PO stays where it is. Anything else moves to <group>-not-po/<folder>/ with a reason.json,
 * and that folder's report.csv is rewritten.
 */
export const sortStoredEmail = async (folder: string): Promise<SortResult> => {
  const dir = path.resolve(folder);
  const meta = await readMeta(dir);
  const info = emailInfo(meta);
  const detected = detectChannel(info);
  if ('config' in detected) return { isPo: true, channel: detected.config.channel, folder: dir };

  const notPoDir = `${path.dirname(dir)}${NOT_PO_SUFFIX}`;
  const target = path.join(notPoDir, path.basename(dir));
  const reason: NotPoReason = {
    code: detected.code,
    reason: detected.reason,
    from: info.from,
    subject: info.subject,
    receivedAt: meta.receivedAt,
    files: (meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename)),
    sortedAt: new Date().toISOString(),
  };

  await fs.mkdir(notPoDir, { recursive: true });
  await fs.writeFile(path.join(dir, REASON_FILE), JSON.stringify(reason, null, 2), 'utf8');
  await fs.rename(dir, target);
  await recordEmail(target);
  await writeNotPoReport(notPoDir);
  return { isPo: false, code: detected.code, reason: detected.reason, folder: target };
};

/**
 * Re-checks <group>-not-po/ with the current channel rules (e.g. after a channel was added)
 * and moves the emails that are POs now back to <group>/. Returns the folders moved back.
 */
export const recheckNotPo = async (groupDir: string): Promise<{ folder: string; channel: string }[]> => {
  const notPoDir = `${groupDir}${NOT_PO_SUFFIX}`;
  const moved: { folder: string; channel: string }[] = [];

  for (const d of await fs.readdir(notPoDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const from = path.join(notPoDir, d.name);
    const detected = detectChannel(emailInfo(await readMeta(from)));
    if (!('config' in detected)) continue;

    const to = path.join(groupDir, d.name);
    await fs.rm(path.join(from, REASON_FILE), { force: true });
    await fs.rename(from, to);
    moved.push({ folder: to, channel: detected.config.channel });
    await recordEmail(to);
  }
  // Not-PO emails whose local copy was removed: a PO now -> brought back from S3 into <group>/ (2026-10-23).
  for (const r of await notPoRows(path.basename(groupDir))) {
    if (!r.localRemovedAt || !r.s3Folder) continue;
    const detected = detectChannel({ from: r.fromAddress ?? '', subject: r.subject ?? '' });
    if (!('config' in detected)) continue;
    const to = path.join(groupDir, r.folderName);
    await downloadS3Folder(r.s3Folder, to);
    await fs.rm(path.join(to, REASON_FILE), { force: true });
    await markLocal(r.messageKey, false, INTAKE_EMAIL_KIND.PO);
    await recordEmail(to);
    moved.push({ folder: to, channel: detected.config.channel });
  }
  await writeNotPoReport(notPoDir);
  return moved;
};
