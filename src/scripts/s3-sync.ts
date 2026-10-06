/*
 * Upload to S3 everything stored locally for a label that is not in S3 yet (or differs). Local files stay.
 * Needs S3_ENABLED=true. The server does the same at startup, and uploads each new email as it arrives.
 *
 *   npm run s3:sync -- --label po-intake      (storage/emails/po-intake/ and po-intake-not-po/)
 */
import { env } from '../config/env';
import { groupDirFor, NOT_PO_SUFFIX } from '../modules/email-intake/email-storage.service';
import { syncTreeToS3 } from '../modules/email-intake/s3-mirror.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const label = arg('label');
  if (!label) throw new Error('Give --label <label folder>, e.g. --label po-intake');
  if (!env.s3.enabled) throw new Error('S3_ENABLED is not true in .env');

  for (const dir of [groupDirFor(label), `${groupDirFor(label)}${NOT_PO_SUFFIX}`]) {
    const r = await syncTreeToS3(dir);
    console.log(`${dir} -> s3://${env.s3.bucket}/${env.s3.prefix}: ${r.uploaded} uploaded, ${r.same} already in S3`);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
