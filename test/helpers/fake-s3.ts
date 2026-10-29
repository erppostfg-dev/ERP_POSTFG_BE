import { Readable } from 'stream';
import { s3Client } from '../../src/config/s3';

/*
 * In-memory S3 for every test (2026-10-28): installed by test/setup/env.ts on the app's one S3 client, so code under
 * test reads and writes a pretend bucket that is gone when the test file ends. Nothing reaches AWS (and the network
 * guard would stop it anyway). Covers the commands the app uses: Put / Get / Head / List / Copy / Delete.
 * s3Objects() lets a test look at what was written; clearS3() empties it.
 */
interface Obj { body: Buffer; contentType?: string; etag: string; at: Date }
const store = new Map<string, Obj>();

const notFound = (name: 'NoSuchKey' | 'NotFound', key: string) => Object.assign(new Error(`${name}: ${key}`), { name, $metadata: { httpStatusCode: 404 } });
const toBuffer = async (body: unknown): Promise<Buffer> => {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const parts: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(parts);
  }
  throw new Error(`fake S3: unsupported Body type ${typeof body}`);
};
const bodyOf = (b: Buffer) => Object.assign(Readable.from([b]), {
  transformToString: async (enc: BufferEncoding = 'utf8') => b.toString(enc),
  transformToByteArray: async () => new Uint8Array(b),
});

const handle = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
  const key = typeof input.Key === 'string' ? input.Key : '';
  switch (name) {
    case 'PutObjectCommand': {
      const body = await toBuffer(input.Body);
      store.set(key, { body, contentType: input.ContentType as string | undefined, etag: `"${body.length.toString(16)}-${store.size}"`, at: new Date() });
      return { ETag: store.get(key)!.etag, $metadata: { httpStatusCode: 200 } };
    }
    case 'GetObjectCommand': {
      const o = store.get(key);
      if (!o) throw notFound('NoSuchKey', key);
      return { Body: bodyOf(o.body), ContentLength: o.body.length, ContentType: o.contentType, ETag: o.etag, LastModified: o.at, $metadata: { httpStatusCode: 200 } };
    }
    case 'HeadObjectCommand': {
      const o = store.get(key);
      if (!o) throw notFound('NotFound', key);
      return { ContentLength: o.body.length, ContentType: o.contentType, ETag: o.etag, LastModified: o.at, $metadata: { httpStatusCode: 200 } };
    }
    case 'ListObjectsV2Command': {
      const prefix = typeof input.Prefix === 'string' ? input.Prefix : '';
      const Contents = [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([Key, o]) => ({ Key, ETag: o.etag, Size: o.body.length, LastModified: o.at }));
      return { Contents, KeyCount: Contents.length, IsTruncated: false, $metadata: { httpStatusCode: 200 } };
    }
    case 'CopyObjectCommand': {
      const source = decodeURIComponent(String(input.CopySource)).replace(/^[^/]+\//, '');
      const o = store.get(source);
      if (!o) throw notFound('NoSuchKey', source);
      store.set(key, { ...o, at: new Date() });
      return { $metadata: { httpStatusCode: 200 } };
    }
    case 'DeleteObjectCommand':
      store.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    default:
      throw new Error(`fake S3: ${name} is not supported yet (add it to test/helpers/fake-s3.ts)`);
  }
};

export const installFakeS3 = (): void => {
  const client = s3Client();
  (client as unknown as { send: unknown }).send = (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
    handle(command.constructor.name, command.input);
};

export const s3Objects = (prefix = ''): Map<string, string> =>
  new Map([...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => [k, o.body.toString('utf8')]));
export const clearS3 = (): void => store.clear();
