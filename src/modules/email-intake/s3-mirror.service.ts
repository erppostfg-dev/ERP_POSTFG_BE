import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { emailInfo } from '../ocr/channel-detector';
import { EmailMetadata, plannedS3Folder } from './s3-layout';

/*
 * Copies the local email storage to S3 in the folder layout of s3-layout.ts:
 *   PO:      <label>/FY2627/october/zepto/P5727174/<files>
 *   not PO:  <label>-not-po/reliance/<date>_<id>/<files>
 * Each email's S3 folder is decided on its first upload and kept in its metadata.json (s3Folder), so later
 * uploads (startup sync, OCR result) always go to the same place. A PO folder already used by another
 * email gets _2, _3, with a duplicate.json in it and a row in <label>/duplicates.csv.
 * Local storage is written first and stays; S3 failures are logged and never fail the intake.
 * Anything missed (S3 down, server stopped) is uploaded at startup or by `npm run s3:sync`.
 */

let client: S3Client | undefined;
const s3 = (): S3Client => (client ??= new S3Client({ region: env.s3.region }));

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const METADATA = 'metadata.json';
const DUPLICATE_FILE = 'duplicate.json';
const DUPLICATES_CSV = 'duplicates.csv';
/** Files that describe the email or our processing, not the attachments (left out of the re-send check). */
const OWN_FILES = /^(metadata\.json|body\.(txt|html)|reason\.json|duplicate\.json|links\.json|ocr-.*)$/;

/** S3 key of a file kept directly in a label folder (report.csv, duplicates.csv). */
const labelFileKey = (localFile: string): string => {
  const rel = path.relative(path.resolve(env.storage.emailDir), path.resolve(localFile));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${localFile} is not under ${env.storage.emailDir}`);
  return `${env.s3.prefix}${rel.split(path.sep).join('/')}`;
};

/** key -> ETag (without quotes) of every object under a prefix. */
const listPrefix = async (prefix: string): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({ Bucket: env.s3.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) if (o.Key) found.set(o.Key, (o.ETag ?? '').replace(/"/g, ''));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return found;
};

/** A text object, or undefined when it doesn't exist. */
const getText = async (key: string): Promise<string | undefined> => {
  try {
    return await (await s3().send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }))).Body?.transformToString();
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return undefined;
    throw err;
  }
};

/** Every file under a local folder (recursive). */
const localFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await localFiles(p)));
    else if (d.isFile() && !d.name.endsWith('.tmp')) out.push(p);
  }
  return out;
};

const putBody = async (key: string, body: Buffer | string, fileName: string): Promise<void> => {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream',
    }),
  );
};

const md5 = (body: Buffer): string => crypto.createHash('md5').update(body).digest('hex');

const readMeta = async (dir: string): Promise<EmailMetadata> =>
  JSON.parse(await fs.readFile(path.join(dir, METADATA), 'utf8')) as EmailMetadata;

const writeMeta = async (dir: string, meta: EmailMetadata): Promise<void> => {
  const file = path.join(dir, METADATA);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(meta, null, 2), 'utf8');
  await fs.rename(`${file}.tmp`, file);
};

/**
 * The S3 folder of a local email folder. Kept from metadata.json when it still fits (same place, e.g. not moved
 * between <label>/ and <label>-not-po/); otherwise decided now: the planned folder, or _2, _3 when another email
 * (another Message-ID) already has it. The choice is saved in metadata.json.
 */
const s3FolderFor = async (dir: string): Promise<{ s3Folder: string; duplicateOf?: string; meta: EmailMetadata }> => {
  const meta = await readMeta(dir);
  const planned = plannedS3Folder(dir, meta);
  if (meta.s3Folder && (meta.s3Folder === planned || meta.s3Folder.startsWith(`${planned}_`))) {
    return { s3Folder: meta.s3Folder, meta };
  }

  let s3Folder = planned;
  for (let n = 2; ; n++) {
    const owner = await getText(`${s3Folder}/${METADATA}`);
    if (owner === undefined || (JSON.parse(owner) as EmailMetadata).messageId === meta.messageId) break;
    s3Folder = `${planned}_${n}`;
  }
  const updated = { ...meta, s3Folder };
  await writeMeta(dir, updated);
  return { s3Folder, duplicateOf: s3Folder === planned ? undefined : planned, meta: updated };
};

/**
 * A PO arrived again under a number that already has a folder: writes duplicate.json into the new folder (why it
 * happened), adds a row to <label>/duplicates.csv (local and S3) and logs it.
 */
const recordDuplicate = async (dir: string, s3Folder: string, firstFolder: string, meta: EmailMetadata): Promise<void> => {
  const first = JSON.parse((await getText(`${firstFolder}/${METADATA}`)) ?? '{}') as EmailMetadata;
  const firstInfo = emailInfo(first);
  const thisInfo = emailInfo(meta);

  // Same attachments (names and MD5) = a plain re-send; different = probably an amended PO.
  const firstFiles = [...(await listPrefix(`${firstFolder}/`)).entries()]
    .map(([k, etag]) => [k.slice(firstFolder.length + 1), etag])
    .filter(([name]) => !OWN_FILES.test(name))
    .map(([name, etag]) => `${name}:${etag}`)
    .sort();
  const thisFiles: string[] = [];
  for (const f of await localFiles(dir)) {
    const name = path.relative(dir, f).split(path.sep).join('/');
    if (!OWN_FILES.test(name)) thisFiles.push(`${name}:${md5(await fs.readFile(f))}`);
  }
  thisFiles.sort();
  const sameAttachments = JSON.stringify(firstFiles) === JSON.stringify(thisFiles);
  const kind = sameAttachments ? 're-send (same attachments)' : 'changed attachments (amended PO?)';

  const record = {
    folder: `${s3Folder}/`,
    duplicateOf: `${firstFolder}/`,
    kind,
    sameAttachments,
    first: { messageId: first.messageId, from: firstInfo.from, subject: firstInfo.subject, receivedAt: first.receivedAt, files: firstFiles },
    this: { messageId: meta.messageId, from: thisInfo.from, subject: thisInfo.subject, receivedAt: meta.receivedAt, files: thisFiles },
    recordedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dir, DUPLICATE_FILE), JSON.stringify(record, null, 2), 'utf8');

  // <label>/duplicates.csv: S3 is the source (S3 can't append: read, add the row, write back), the local copy follows.
  const labelDir = path.dirname(path.resolve(dir));
  const csvKey = labelFileKey(path.join(labelDir, DUPLICATES_CSV));
  const cell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'recordedAt,receivedAt,channel_folder,first_folder,new_folder,kind,first_message_id,new_message_id,subject';
  const existing = (await getText(csvKey))?.trimEnd() || header;
  const row = [record.recordedAt, meta.receivedAt, path.posix.dirname(s3Folder), record.duplicateOf, record.folder, kind,
    first.messageId, meta.messageId, thisInfo.subject].map(cell).join(',');
  const csv = `${existing}\r\n${row}\r\n`;
  await putBody(csvKey, csv, DUPLICATES_CSV);
  await fs.writeFile(path.join(labelDir, DUPLICATES_CSV), csv, 'utf8');

  console.log(`[duplicate] ${path.posix.basename(firstFolder)} arrived again -> ${s3Folder}/ (${kind})`);
};

/**
 * Uploads one email folder to its S3 folder: every file missing in S3 or different (MD5 vs ETag).
 * Returns the S3 folder and how many files were uploaded / already there.
 */
export const syncEmailToS3 = async (dir: string): Promise<{ s3Folder: string; uploaded: number; same: number }> => {
  if (!env.s3.enabled) return { s3Folder: '', uploaded: 0, same: 0 };
  const { s3Folder, duplicateOf, meta } = await s3FolderFor(dir);
  if (duplicateOf) await recordDuplicate(dir, s3Folder, duplicateOf, meta);

  const remote = await listPrefix(`${s3Folder}/`);
  let uploaded = 0;
  let same = 0;
  for (const file of await localFiles(dir)) {
    const key = `${s3Folder}/${path.relative(dir, file).split(path.sep).join('/')}`;
    const body = await fs.readFile(file);
    if (remote.get(key) === md5(body)) {
      same++;
      continue;
    }
    await putBody(key, body, file);
    uploaded++;
  }
  return { s3Folder, uploaded, same };
};

/** Uploads one file kept directly in a label folder (report.csv, duplicates.csv). */
export const uploadFileToS3 = async (file: string): Promise<void> => {
  if (!env.s3.enabled) return;
  await putBody(labelFileKey(file), await fs.readFile(file), file);
};

/** Uploads every email folder of a label folder, plus its own files (report.csv, duplicates.csv). */
export const syncLabelToS3 = async (labelDir: string): Promise<{ emails: number; uploaded: number; same: number }> => {
  const total = { emails: 0, uploaded: 0, same: 0 };
  if (!env.s3.enabled) return total;
  for (const d of await fs.readdir(labelDir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(labelDir, d.name);
    if (d.isDirectory()) {
      const r = await syncEmailToS3(p);
      total.emails++;
      total.uploaded += r.uploaded;
      total.same += r.same;
    } else if (d.isFile() && !d.name.endsWith('.tmp')) {
      const body = await fs.readFile(p);
      const remote = await listPrefix(labelFileKey(p));
      if (remote.get(labelFileKey(p)) === md5(body)) total.same++;
      else {
        await putBody(labelFileKey(p), body, p);
        total.uploaded++;
      }
    }
  }
  return total;
};

let deleteDenied = false;

/**
 * An email folder was moved locally (between <label>/ and <label>-not-po/): uploads it to its new S3 folder,
 * then deletes the old S3 copy. Without s3:DeleteObject the old copy stays, with one warning.
 */
export const moveEmailInS3 = async (newDir: string): Promise<void> => {
  if (!env.s3.enabled) return;
  const oldFolder = (await readMeta(newDir)).s3Folder;
  const { s3Folder } = await syncEmailToS3(newDir);
  if (!oldFolder || oldFolder === s3Folder || deleteDenied) return;
  for (const key of (await listPrefix(`${oldFolder}/`)).keys()) {
    try {
      await s3().send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'AccessDenied') throw err;
      deleteDenied = true;
      console.warn(`[s3] no s3:DeleteObject permission: old copies stay in S3 (first one: ${key})`);
      return;
    }
  }
};

/** Runs an S3 step without blocking or failing the caller; errors are logged (the next sync retries). */
export const mirrorLater = (what: string, step: () => Promise<unknown>): void => {
  if (!env.s3.enabled) return;
  step().catch((err) => console.error(`[s3] ${what} failed (retried by the next sync):`, (err as Error).message ?? err));
};
