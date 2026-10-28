import { NextFunction, Request, Response } from 'express';
import { pipeline } from 'stream';
import { createGunzip, createGzip } from 'zlib';
import { StoredBlob, tableEtag } from './file-preview.service';

/**
 * A whole CSV for the browser's table viewer: as stored (a stored .csv.gz goes out as it is), gzip on the wire, never
 * parsed here. The ETag is the content version: a browser holding it gets 304 and reads its own copy.
 */
export const sendTable = async (req: Request, res: Response, next: NextFunction, blob: StoredBlob): Promise<void> => {
  const etag = tableEtag(blob);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('ETag', `"${etag}"`);
  res.setHeader('Last-Modified', blob.modified.toUTCString());
  res.setHeader('X-File-Size', String(blob.size));
  if ((req.header('if-none-match') ?? '').replace(/"/g, '') === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  const gzipOk = /\bgzip\b/.test(req.header('accept-encoding') ?? '');
  const body = (await blob.stream()) as NodeJS.ReadableStream;
  const done = (err: NodeJS.ErrnoException | null): void => {
    if (err && !res.headersSent) next(err);
  };
  if (gzipOk) res.setHeader('Content-Encoding', 'gzip');
  if (blob.gzip && gzipOk) pipeline(body, res, done);
  else if (blob.gzip) pipeline(body, createGunzip(), res, done);
  else if (gzipOk) pipeline(body, createGzip(), res, done);
  else pipeline(body, res, done);
};
