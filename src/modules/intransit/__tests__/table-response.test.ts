import express from 'express';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
import { gunzipSync, gzipSync } from 'zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredBlob } from '../file-preview.service';
import { sendTable } from '../table-response';

/*
 * The table viewer's file (user, 2026-10-27: the browser keeps and pages the table, the server only passes the file
 * on): gzip on the wire, a stored .csv.gz sent as it is, ETag + 304.
 */

const CSV = 'SKU,Qty\nA1,3\nB2,5\n';
const blobOf = (key: string, gzip = false): StoredBlob => {
  const bytes = gzip ? gzipSync(CSV) : Buffer.from(CSV);
  return {
    name: 'x.csv', size: bytes.length, modified: new Date('2026-10-27T10:00:00Z'), key, gzip,
    read: async () => new Uint8Array(bytes), stream: async () => Readable.from([bytes]),
  };
};

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.get('/plain', (req, res, next) => void sendTable(req, res, next, blobOf('plain-v1')));
  app.get('/stored-gz', (req, res, next) => void sendTable(req, res, next, blobOf('gz-v1', true)));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The raw bytes and headers (no automatic decompression). */
const get = async (path: string, headers: Record<string, string>) => {
  const http = await import('http');
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    http.get(`${base}${path}`, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
};

describe('sendTable', () => {
  it('gzips a plain CSV for a browser that accepts gzip, with its ETag and size', async () => {
    const r = await get('/plain', { 'accept-encoding': 'gzip, deflate' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(r.headers['x-file-size']).toBe(String(CSV.length));
    expect(gunzipSync(r.body).toString()).toBe(CSV);
  });

  it('sends a stored .csv.gz as it is, or unzipped for a client without gzip', async () => {
    const zipped = await get('/stored-gz', { 'accept-encoding': 'gzip' });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(zipped.body).toString()).toBe(CSV);
    const plain = await get('/stored-gz', {});
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(CSV);
  });

  it('answers 304 with no body when the browser has this version', async () => {
    const first = await get('/plain', {});
    const again = await get('/plain', { 'if-none-match': first.headers.etag as string });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });
});
