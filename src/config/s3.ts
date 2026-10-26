import { S3Client } from '@aws-sdk/client-s3';
import { LOG_SOURCE } from '../constants/logging';
import { logCall } from '../utils/log-call';
import { env } from './env';

/*
 * The one S3 client of the app (the email copy and the in-transit store share it; 2026-10-26). Credentials come from
 * AWS_* (later the EC2 IAM role). Calls retry 5 times and give up after 10 minutes.
 * Every command is timed and logged (2026-10-19): S3_CALL (debug), S3_SLOW, or S3_<FAILURE> with the reason (e.g.
 * S3_ACCESS_DENIED: the key / role lacks the permission). A missing file is normal (the email copy checks for
 * corrected.json, the in-transit store for a version), so NOT_FOUND is only a debug line. The same key read many times
 * in one request is flagged.
 */

let client: S3Client | undefined;

export const s3Client = (): S3Client => {
  if (client) return client;
  client = new S3Client({
    region: env.s3.region,
    maxAttempts: 5,
    requestHandler: { requestTimeout: 10 * 60_000, connectionTimeout: 15_000 },
  });
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const key = (args.input as { Key?: string; Prefix?: string }).Key ?? (args.input as { Prefix?: string }).Prefix;
      return logCall(LOG_SOURCE.S3, String(context.commandName ?? 'S3Command'), () => next(args), {
        key, fields: { key, bucket: env.s3.bucket }, expected: ['NOT_FOUND'],
      });
    },
    { step: 'initialize', name: 'postfgLogCall' },
  );
  return client;
};

export const s3Bucket = (): string => env.s3.bucket;
