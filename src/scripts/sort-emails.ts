/*
 * Sort stored emails into POs and not-POs by hand (no server needed). New emails are sorted on arrival.
 *
 *   npm run email:sort -- --label po-intake
 *
 * 1. Every email in storage/emails/<label>/ that is not a PO moves to <label>-not-po/ with a reason.json.
 * 2. Every email in <label>-not-po/ that is a PO now (e.g. after a channel was added) moves back.
 * 3. <label>-not-po/report.csv is rewritten: one row per email (date, sender, subject, reason).
 */
import fs from 'fs/promises';
import path from 'path';
import { recheckNotPo, sortStoredEmail, writeNotPoReport } from '../modules/email-intake/email-sorter.service';
import { groupDirFor, NOT_PO_SUFFIX } from '../modules/email-intake/email-storage.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const label = arg('label');
  if (!label) throw new Error('Give --label <label folder>, e.g. --label po-intake');
  const groupDir = groupDirFor(label);

  const back = await recheckNotPo(groupDir);
  for (const b of back) console.log(`back to ${label}: ${path.basename(b.folder)} -> ${b.channel}`);

  const perChannel: Record<string, number> = {};
  let notPo = 0;
  for (const d of await fs.readdir(groupDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const r = await sortStoredEmail(path.join(groupDir, d.name));
    if (r.isPo) {
      perChannel[r.channel] = (perChannel[r.channel] ?? 0) + 1;
    } else {
      notPo++;
      console.log(`not a PO: ${d.name}  ${r.code}: ${r.reason}`);
    }
  }

  const notPoDir = `${groupDir}${NOT_PO_SUFFIX}`;
  const total = await writeNotPoReport(notPoDir);
  console.log(`\nPOs in ${label}:`, perChannel);
  console.log(`moved now: ${notPo}, moved back: ${back.length}, total in ${path.basename(notPoDir)}: ${total}`);
  console.log(`report: ${path.join(notPoDir, 'report.csv')}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
