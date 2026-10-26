import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env';

/*
 * The one S3 client of the app (the email copy and the in-transit store share it; user, 2026-10-26). Credentials come
 * from AWS_* (later the EC2 IAM role). Calls retry 5 times and give up after 10 minutes.
 */

let client: S3Client | undefined;

export const s3Client = (): S3Client =>
  (client ??= new S3Client({
    region: env.s3.region,
    maxAttempts: 5,
    requestHandler: { requestTimeout: 10 * 60_000, connectionTimeout: 15_000 },
  }));

export const s3Bucket = (): string => env.s3.bucket;
