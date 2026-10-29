import { env } from '../../../config/env';
import { s3Bucket } from '../../../config/s3';
import { drainOnce, queuedBytes, queuedItems } from './queue';
import { rootOf, storageProblems, writeScope } from './scope';
import { lastS3Error } from './store';

/* GET /intransit/storage/status and POST /intransit/storage/retry: how this machine's in-transit S3 store is doing. */

export interface StorageStatus {
  setUp: boolean;
  missing: string[];
  scope: string;
  /** Where this machine writes: s3://<bucket>/<root> */
  root: string;
  host: string;
  queued: { files: number; bytes: number; limitMb: number; oldest: string | null; refused: { key: string; error: string }[] };
  /** The last S3 failure seen (cleared once S3 answers again). */
  lastError: ReturnType<typeof lastS3Error>;
}

export const storageStatus = async (): Promise<StorageStatus> => {
  const missing = storageProblems();
  const items = await queuedItems();
  return {
    setUp: !missing.length, missing, scope: writeScope(), root: `s3://${s3Bucket()}/${rootOf(writeScope())}`, host: env.intransit.hostId,
    queued: {
      files: items.length, bytes: queuedBytes(), limitMb: env.intransit.spoolMaxMb, oldest: items[0]?.queuedAt ?? null,
      refused: items.filter((i) => i.lastError).map((i) => ({ key: i.key, error: i.lastError as string })),
    },
    lastError: lastS3Error(),
  };
};

/** Send the queued files now. */
export const retryStorage = async (): Promise<{ retried: number; left: number }> => {
  const r = await drainOnce();
  return { retried: r.sent, left: r.left };
};
