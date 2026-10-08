/*
 * Sort stored emails into POs and not-POs by hand (no server needed). New emails are sorted on arrival.
 *
 *   npm run email:sort -- --label po-intake
 *
 * 1. Every email in storage/emails/<label>/ that is not a PO moves to <label>-not-po/ with a reason.json.
 * 2. Every email in <label>-not-po/ that is a PO now (e.g. after a channel was added) moves back.
 * 3. <label>-not-po/report.csv is rewritten: one row per email (date, sender, subject, reason).
 * With S3_ENABLED, each move is done in S3 too and the report is uploaded.
 */
import fs from 'fs/promises';
import path from 'path';
import { recheckNotPo, sortStoredEmail, writeNotPoReport } from '../modules/email-intake/email-sorter.service';
import { groupDirFor, NOT_PO_SUFFIX } from '../modules/email-intake/email-storage.service';
import { moveEmailInS3, uploadFileToS3 } from '../modules/email-intake/s3-mirror.service';
import { ERROR_CODES, FILES } from '../constants';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const label = arg('label');
  if (!label) throw appError(ERROR_CODES.CLI_USAGE, 'Give --label <label folder>, e.g. --label po-intake');
  const groupDir = groupDirFor(label);

  const notPoDir = `${groupDir}${NOT_PO_SUFFIX}`;
  const back = await recheckNotPo(groupDir);
  for (const b of back) {
    console.log(`back to ${label}: ${path.basename(b.folder)} -> ${b.channel}`);
    await moveEmailInS3(b.folder);
  }

  const perChannel: Record<string, number> = {};
  let notPo = 0;
  for (const d of await fs.readdir(groupDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const from = path.join(groupDir, d.name);
    const r = await sortStoredEmail(from);
    if (r.isPo) {
      perChannel[r.channel] = (perChannel[r.channel] ?? 0) + 1;
    } else {
      notPo++;
      console.log(`not a PO: ${d.name}  ${r.code}: ${r.reason}`);
      await moveEmailInS3(r.folder);
    }
  }

  const total = await writeNotPoReport(notPoDir);
  await uploadFileToS3(path.join(notPoDir, FILES.NOT_PO_REPORT));
  console.log(`\nPOs in ${label}:`, perChannel);
  console.log(`moved now: ${notPo}, moved back: ${back.length}, total in ${path.basename(notPoDir)}: ${total}`);
  console.log(`report: ${path.join(notPoDir, FILES.NOT_PO_REPORT)}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
