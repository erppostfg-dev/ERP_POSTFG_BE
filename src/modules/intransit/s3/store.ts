import { createHash } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { s3Bucket, s3Client } from '../../../config/s3';
import { assertStorageSetUp, assertWritable } from './scope';

/*
 * The in-transit store's S3 calls (user, 2026-10-26: every file in S3, nothing about them in the database).
 *   - Keys never change once written, except a day's _build.json and the weekly/monthly copies; so what HeadObject says
 *     about a key is kept for good (in memory).
 *   - Who and how are the object's metadata (x-amz-meta-*): sha256, by-id, by-name, source, run-id, day, orig-name,
 *     problems (the column check's result, at save).
 *   - A PUT carries its SHA-256 (S3 refuses a damaged upload) and is checked with a HeadObject afterwards.
 *   - S3 unreachable: put() hands the file to the queue (queue.ts), which sends it once S3 answers again.
 * Tests swap the client (useS3).
 */

let override: S3Client | null = null;
/** Tests: use this client instead of the real one (null = back to the real one). */
export const useS3 = (client: S3Client | null): void => {
  override = client;
  heads.clear();
};
const s3 = (): S3Client => override ?? s3Client();
const Bucket = (): string => s3Bucket();

export interface ObjMeta {
  sha256: string;
  byId?: number | null;
  byName?: string | null;
  /** upload | amazon | uniware | flipkart | pepims | build | restore | period | migrated | delete ... */
  source: string;
  runId?: string | null;
  day?: string | null;
  origName?: string | null;
  problems?: string[] | null;
}

export interface Head {
  key: string;
  size: number;
  etag: string;
  modified: Date;
  contentType: string | null;
  meta: ObjMeta;
}

const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
};
export const contentTypeOf = (key: string): string => CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';

/** S3 metadata is ASCII only and 2 KB in all: names are URI-encoded, the problems cut short. */
const toS3Meta = (m: ObjMeta): Record<string, string> => {
  const out: Record<string, string> = { sha256: m.sha256, source: m.source };
  if (m.byId !== undefined && m.byId !== null) out['by-id'] = String(m.byId);
  if (m.byName) out['by-name'] = encodeURIComponent(m.byName).slice(0, 300);
  if (m.runId) out['run-id'] = m.runId;
  if (m.day) out.day = m.day;
  if (m.origName) out['orig-name'] = encodeURIComponent(m.origName).slice(0, 300);
  if (m.problems?.length) out.problems = encodeURIComponent(JSON.stringify(m.problems)).slice(0, 1200);
  return out;
};

const dec = (v: string | undefined): string | null => {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

const fromS3Meta = (r: Record<string, string> | undefined): ObjMeta => {
  const m = r ?? {};
  let problems: string[] | null = null;
  try {
    problems = m.problems ? (JSON.parse(dec(m.problems) as string) as string[]) : null;
  } catch {
    problems = [String(dec(m.problems))];
  }
  return {
    sha256: m.sha256 ?? '', source: m.source ?? '', byId: m['by-id'] ? Number(m['by-id']) : null, byName: dec(m['by-name']),
    runId: m['run-id'] ?? null, day: m.day ?? null, origName: dec(m['orig-name']), problems,
  };
};

/** sha256 (hex and base64) and size of bytes or a file (streamed). */
export const digest = async (from: Buffer | string): Promise<{ sha256: string; sha256b64: string; size: number }> => {
  const h = createHash('sha256');
  let size = 0;
  if (typeof from !== 'string') {
    h.update(from);
    size = from.length;
  } else {
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(from).on('data', (c) => { h.update(c); size += c.length; }).on('error', reject).on('end', () => resolve());
    });
  }
  const buf = h.digest();
  return { sha256: buf.toString('hex'), sha256b64: buf.toString('base64'), size };
};

// ---- errors ----------------------------------------------------------------------------------------------------

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']);
const NETWORK_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'NetworkingError', 'ServiceUnavailable', 'SlowDown', 'InternalError', 'AbortError']);

/** S3 could not be reached (or is failing on its side): worth waiting and trying again. */
export const isUnreachable = (err: unknown): boolean => {
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; cause?: { code?: string } };
  if (e?.name && NETWORK_NAMES.has(e.name)) return true;
  if ((e?.code && NETWORK_CODES.has(e.code)) || (e?.cause?.code && NETWORK_CODES.has(e.cause.code))) return true;
  const status = e?.$metadata?.httpStatusCode;
  return status !== undefined && status >= 500;
};

const isMissing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
};

let lastError: { at: string; message: string; unreachable: boolean } | null = null;
/** The last S3 failure, for the status page. */
export const lastS3Error = (): typeof lastError => lastError;
const noteError = (err: unknown): void => {
  lastError = { at: new Date().toISOString(), message: err instanceof Error ? `${err.name}: ${err.message}` : String(err), unreachable: isUnreachable(err) };
};
export const noteSuccess = (): void => {
  if (lastError?.unreachable) lastError = null;
};

// ---- reading ---------------------------------------------------------------------------------------------------

const heads = new Map<string, Head>();
const HEADS_MAX = 5000;

/** What S3 knows of a key (null when it is not there). Immutable keys are remembered. */
export const head = async (key: string, opts: { fresh?: boolean } = {}): Promise<Head | null> => {
  if (!opts.fresh) {
    const hit = heads.get(key);
    if (hit) return hit;
  }
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key: key }));
    const h: Head = {
      key, size: r.ContentLength ?? 0, etag: (r.ETag ?? '').replace(/"/g, ''), modified: r.LastModified ?? new Date(0),
      contentType: r.ContentType ?? null, meta: fromS3Meta(r.Metadata),
    };
    if (!opts.fresh) {
      if (heads.size >= HEADS_MAX) heads.delete(heads.keys().next().value as string);
      heads.set(key, h);
    }
    return h;
  } catch (err) {
    if (isMissing(err)) return null;
    noteError(err);
    throw err;
  }
};

/** Forget what was remembered of a key (it was rewritten). */
export const forgetHead = (key: string): void => {
  heads.delete(key);
};

export interface Listed {
  key: string;
  size: number;
  etag: string;
  modified: Date;
}

/** Every object under a prefix (all pages). */
export const list = async (prefix: string): Promise<Listed[]> => {
  const out: Listed[] = [];
  let token: string | undefined;
  try {
    do {
      const r = await s3().send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, etag: (o.ETag ?? '').replace(/"/g, ''), modified: o.LastModified ?? new Date(0) });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  } catch (err) {
    noteError(err);
    throw err;
  }
  noteSuccess();
  return out;
};

export interface Opened {
  body: Readable;
  size: number;
  etag: string;
  contentType: string | null;
  meta: ObjMeta;
}

/** An object to read (null when it is not there; 'not-modified' when its ETag is `ifNoneMatch`). */
export const open = async (key: string, opts: { ifNoneMatch?: string } = {}): Promise<Opened | 'not-modified' | null> => {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key, IfNoneMatch: opts.ifNoneMatch ? `"${opts.ifNoneMatch.replace(/"/g, '')}"` : undefined }));
    return {
      body: r.Body as Readable, size: r.ContentLength ?? 0, etag: (r.ETag ?? '').replace(/"/g, ''), contentType: r.ContentType ?? null, meta: fromS3Meta(r.Metadata),
    };
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 304 || (err as { name?: string })?.name === 'NotModified') return 'not-modified';
    if (isMissing(err)) return null;
    noteError(err);
    throw err;
  }
};

const collect = async (s: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

/** An object's bytes (null when it is not there). */
export const getBytes = async (key: string): Promise<Buffer | null> => {
  const o = await open(key);
  return o && o !== 'not-modified' ? collect(o.body) : null;
};

/** Download an object into `file`, checked against its sha256 (twice at most); null when it is not there. */
export const getToFile = async (key: string, file: string, sha256?: string): Promise<string | null> => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const o = await open(key);
    if (!o || o === 'not-modified') return null;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(`${file}.part`);
      o.body.on('error', reject);
      out.on('error', reject).on('finish', () => resolve());
      o.body.pipe(out);
    });
    const want = sha256 ?? o.meta.sha256;
    const got = await digest(`${file}.part`);
    if (!want || got.sha256 === want) {
      await fsp.rename(`${file}.part`, file);
      return file;
    }
    await fsp.rm(`${file}.part`, { force: true });
    if (attempt >= 2) throw new Error(`${key} from S3 does not match what was stored (sha256)`);
  }
};

// ---- writing ---------------------------------------------------------------------------------------------------

/** Called after every write of this machine (the input listings are cached for a few seconds). */
const writeListeners: ((key: string) => void)[] = [];
export const onWrite = (fn: (key: string) => void): void => {
  writeListeners.push(fn);
};
const wrote = (key: string): void => {
  for (const fn of writeListeners) fn(key);
};

/** The queue's hook (set by queue.ts): takes a file S3 could not take now. */
let queueHook: ((key: string, from: Buffer | string, meta: ObjMeta, contentType: string) => Promise<void>) | null = null;
export const setQueueHook = (fn: typeof queueHook): void => {
  queueHook = fn;
};

export interface PutResult {
  key: string;
  stored: 's3' | 'queued';
  sha256: string;
  size: number;
}

/**
 * Write `from` (bytes or a file) to `key` with its metadata, checked by S3 (SHA-256) and by a HeadObject afterwards.
 * Only this machine's own area. S3 unreachable: the file waits in the queue (noQueue: the error is thrown instead).
 */
export const put = async (key: string, from: Buffer | string, meta: Omit<ObjMeta, 'sha256'> & { sha256?: string }, opts: { noQueue?: boolean; contentType?: string } = {}): Promise<PutResult> => {
  assertStorageSetUp();
  assertWritable(key);
  const d = await digest(from);
  if (meta.sha256 && meta.sha256 !== d.sha256) throw new Error(`${key}: the file changed while it was being saved`);
  const full: ObjMeta = { ...meta, sha256: d.sha256 };
  const contentType = opts.contentType ?? contentTypeOf(key);
  try {
    await s3().send(new PutObjectCommand({
      Bucket: Bucket(), Key: key, Body: typeof from === 'string' ? fs.createReadStream(from) : from, ContentLength: d.size,
      ContentType: contentType, ChecksumSHA256: d.sha256b64, Metadata: toS3Meta(full),
    }));
    const h = await head(key, { fresh: true });
    if (!h || h.size !== d.size || h.meta.sha256 !== d.sha256) throw new Error(`S3's copy of ${key} does not match (size ${h?.size ?? 'none'})`);
    forgetHead(key);
    noteSuccess();
    wrote(key);
    return { key, stored: 's3', sha256: d.sha256, size: d.size };
  } catch (err) {
    noteError(err);
    if (opts.noQueue || !queueHook || !isUnreachable(err)) throw err;
    await queueHook(key, from, full, contentType);
    wrote(key);
    return { key, stored: 'queued', sha256: d.sha256, size: d.size };
  }
};

/** A JSON object (small: _build.json, run.json, a tombstone). */
export const putJson = (key: string, value: unknown, meta: Omit<ObjMeta, 'sha256'>, opts: { noQueue?: boolean } = {}): Promise<PutResult> =>
  put(key, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), meta, { ...opts, contentType: 'application/json' });

/** CopySource: bucket/key with each path part URI-encoded (keys have spaces, '(', '+'). */
const copySource = (key: string): string => `${Bucket()}/${key.split('/').map(encodeURIComponent).join('/')}`;

/** Copy an object to `to` within the bucket, with all its metadata (some replaced by `meta`), checked by sha256. */
export const copy = async (from: string, to: string, meta: Partial<ObjMeta> = {}): Promise<Head> => {
  assertStorageSetUp();
  assertWritable(to);
  const src = await head(from, { fresh: true });
  if (!src) throw Object.assign(new Error(`${from} is not in S3 (expired?)`), { name: 'NoSuchKey' });
  const full: ObjMeta = { ...src.meta, ...meta, sha256: src.meta.sha256 };
  try {
    await s3().send(new CopyObjectCommand({
      Bucket: Bucket(), Key: to, CopySource: copySource(from), MetadataDirective: 'REPLACE', Metadata: toS3Meta(full),
      ContentType: src.contentType ?? contentTypeOf(to),
    }));
  } catch (err) {
    noteError(err);
    throw err;
  }
  forgetHead(to);
  const h = await head(to, { fresh: true });
  if (!h || h.size !== src.size || h.meta.sha256 !== src.meta.sha256) throw new Error(`the copy ${to} does not match ${from}`);
  noteSuccess();
  wrote(to);
  return h;
};

/** Remove an object of this machine's area (a _build.json repointed away, a test file). */
export const remove = async (key: string): Promise<void> => {
  assertStorageSetUp();
  assertWritable(key);
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: Bucket(), Key: key }));
  } catch (err) {
    noteError(err);
    throw err;
  }
  forgetHead(key);
  wrote(key);
};
