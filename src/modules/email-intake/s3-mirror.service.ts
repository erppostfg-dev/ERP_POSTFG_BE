import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';

/*
 * Keeps a copy of the local email storage in S3 with the same layout:
 *   storage/emails/<label>/<folder>/<file>  ->  s3://<bucket>/<prefix><label>/<folder>/<file>
 * Local storage is written first and stays; S3 failures are logged and never fail the intake.
 * Anything missed (S3 down, server stopped) is uploaded by syncTreeToS3 at startup or `npm run s3:sync`.
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

/** s3 key for a local path under EMAIL_STORAGE_DIR. */
export const s3KeyFor = (localPath: string): string => {
  const rel = path.relative(path.resolve(env.storage.emailDir), path.resolve(localPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${localPath} is not under ${env.storage.emailDir}`);
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

const putFile = async (file: string, key: string, body: Buffer): Promise<void> => {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    }),
  );
};

/**
 * Uploads every file under `dir` that is missing in S3 or differs (MD5 vs ETag; files are put in one part).
 * Returns how many were uploaded and how many were already there.
 */
export const syncTreeToS3 = async (dir: string): Promise<{ uploaded: number; same: number }> => {
  if (!env.s3.enabled) return { uploaded: 0, same: 0 };
  const remote = await listPrefix(`${s3KeyFor(dir)}/`);
  let uploaded = 0;
  let same = 0;
  for (const file of await localFiles(dir)) {
    const key = s3KeyFor(file);
    const body = await fs.readFile(file);
    if (remote.get(key) === crypto.createHash('md5').update(body).digest('hex')) {
      same++;
      continue;
    }
    await putFile(file, key, body);
    uploaded++;
  }
  return { uploaded, same };
};

/** Uploads one file (e.g. report.csv after it was rewritten). */
export const uploadFileToS3 = async (file: string): Promise<void> => {
  if (!env.s3.enabled) return;
  await putFile(file, s3KeyFor(file), await fs.readFile(file));
};

let deleteDenied = false;

/**
 * A folder was moved locally (e.g. back from <label>-not-po/ after a channel was added): uploads the new folder,
 * then deletes the old copy. Without s3:DeleteObject the old copy stays, with one warning.
 */
export const moveFolderInS3 = async (fromDir: string, toDir: string): Promise<void> => {
  if (!env.s3.enabled) return;
  await syncTreeToS3(toDir);
  if (deleteDenied) return;
  for (const key of (await listPrefix(`${s3KeyFor(fromDir)}/`)).keys()) {
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

