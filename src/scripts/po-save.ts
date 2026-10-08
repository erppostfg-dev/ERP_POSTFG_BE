/*
 * Step 2 of saving POs: for every PO of an email whose po_uploads row passed validation (status processing):
 * sale order code + master/details_purchase_orders + Uniware CSV (local + S3) + po_uploads completed.
 * DRY RUN by default (reads only, prints what it would write and the CSV). --apply writes.
 *
 *   npm run po:save -- --folder storage/emails/po-intake/2026-10-03_01be8bd712f210b6
 *   npm run po:save -- --folder <folder> --apply
 */
import 'reflect-metadata';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { ERROR_CODES } from '../constants';
import { planEmail } from '../modules/po-pipeline/po-uploads.service';
import { applySave, planSave, uniwareCsv } from '../modules/po-pipeline/po-save.service';
import { MasterDataReader } from '../modules/po-validation/master-data';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');

const main = async (): Promise<void> => {
  const folderArg = arg('folder');
  if (!folderArg) throw appError(ERROR_CODES.CLI_USAGE, 'Give --folder <email folder> [--apply]');
  const folder = path.resolve(folderArg);

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  try {
    const plan = await planEmail(AppDataSource, new MasterDataReader(AppDataSource), folder);
    const saves = await planSave(AppDataSource, plan);
    for (const s of saves) {
      console.log(`\n${s.row.poNumber}  po_uploads ${s.upload?.id ?? '-'}  ${s.skip ? `SKIP: ${s.skip}` : `-> sale order ${s.nextCode}`}`);
      if (s.skip) continue;
      console.log('  master_purchase_orders:', JSON.stringify(s.master));
      console.log(`  details_purchase_orders: ${s.details.length} rows, first:`, JSON.stringify(s.details[0]));
      console.log(`  Uniware CSV ${s.csvRelPath}:`);
      console.log(uniwareCsv(s, s.nextCode).split('\r\n').slice(0, 4).map((l) => `    ${l}`).join('\n'), '\n    ...');
    }
    if (APPLY) {
      for (const r of await applySave(AppDataSource, folder, saves)) {
        console.log(
          r.error
            ? `\nFAILED ${r.poNumber} (po_uploads ${r.uploadId}): ${r.error}`
            : `\nSAVED ${r.poNumber}: po_uploads ${r.uploadId} completed, master_purchase_orders.uid ${r.poUid}, sale order ${r.code}, CSV ${r.csvUrl}`,
        );
      }
    }
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
