import { createHash } from 'crypto';
import { Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';

/*
 * A small in-memory S3 for the in-transit store's tests: Put (with the SHA-256 check S3 does), Head, Get (with
 * If-None-Match), ListObjectsV2 (paged, 3 keys a page so paging is always exercised), Copy (decoding CopySource like S3)
 * and Delete. `down = true` makes every call fail as if S3 could not be reached.
 */

interface Obj {
  bytes: Buffer;
  meta: Record<string, string>;
  contentType: string | undefined;
  etag: string;
  modified: Date;
}

const err = (name: string, status: number): Error => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

const bodyBytes = async (body: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

export class S3Fake {
  objects = new Map<string, Obj>();
  down = false;
  calls: string[] = [];
  copySources: string[] = [];
  private readonly page = 3;

  client(): S3Client {
    return { send: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => this.send(cmd) } as unknown as S3Client;
  }

  text(key: string): string | undefined {
    return this.objects.get(key)?.bytes.toString('utf8');
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = cmd.constructor.name.replace(/Command$/, '');
    const i = cmd.input;
    this.calls.push(name);
    if (this.down) throw Object.assign(new Error('connect ETIMEDOUT'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
    const key = i.Key as string;
    switch (name) {
      case 'PutObject': {
        const bytes = await bodyBytes(i.Body);
        if (i.ChecksumSHA256 && createHash('sha256').update(bytes).digest('base64') !== i.ChecksumSHA256) throw err('BadDigest', 400);
        this.objects.set(key, { bytes, meta: { ...(i.Metadata as Record<string, string>) }, contentType: i.ContentType as string, etag: createHash('md5').update(bytes).digest('hex'), modified: new Date() });
        return {};
      }
      case 'HeadObject': {
        const o = this.objects.get(key);
        if (!o) throw err('NotFound', 404);
        return { ContentLength: o.bytes.length, ETag: `"${o.etag}"`, Metadata: o.meta, LastModified: o.modified, ContentType: o.contentType };
      }
      case 'GetObject': {
        const o = this.objects.get(key);
        if (!o) throw err('NoSuchKey', 404);
        if (i.IfNoneMatch && String(i.IfNoneMatch).replace(/"/g, '') === o.etag) throw err('NotModified', 304);
        return { Body: Readable.from([o.bytes]), ContentLength: o.bytes.length, ETag: `"${o.etag}"`, Metadata: o.meta, ContentType: o.contentType };
      }
      case 'ListObjectsV2': {
        const all = this.keys(i.Prefix as string);
        const start = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
        const slice = all.slice(start, start + this.page);
        const more = start + this.page < all.length;
        return {
          Contents: slice.map((k) => ({ Key: k, Size: this.objects.get(k)?.bytes.length, ETag: `"${this.objects.get(k)?.etag}"`, LastModified: this.objects.get(k)?.modified })),
          IsTruncated: more, NextContinuationToken: more ? String(start + this.page) : undefined,
        };
      }
      case 'CopyObject': {
        const src = String(i.CopySource);
        this.copySources.push(src);
        const [, ...parts] = src.split('/');
        const from = parts.map(decodeURIComponent).join('/');
        const o = this.objects.get(from);
        if (!o) throw err('NoSuchKey', 404);
        const meta = i.MetadataDirective === 'REPLACE' ? { ...(i.Metadata as Record<string, string>) } : { ...o.meta };
        this.objects.set(key, { ...o, meta, contentType: (i.ContentType as string) ?? o.contentType, modified: new Date() });
        return {};
      }
      case 'DeleteObject':
        this.objects.delete(key);
        return {};
      default:
        throw new Error(`S3Fake: ${name} not supported`);
    }
  }
}
