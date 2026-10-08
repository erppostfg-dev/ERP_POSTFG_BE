/*
 * The chain after the OCR, by hand, for one stored email (no OCR run): processed.json -> validation + po_issues ->
 * PO tables + sale order + Uniware CSV, with po_uploads updated at each step. WRITES to the database.
 *
 *   npm run po:pipeline -- --folder storage/emails/po-intake/2026-10-03_01be8bd712f210b6
 */
import 'reflect-metadata';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { ERROR_CODES } from '../constants';
import { emailStored, runFromProcessing } from '../modules/po-pipeline/pipeline.service';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const folderArg = arg('folder');
  if (!folderArg) throw appError(ERROR_CODES.CLI_USAGE, 'Give --folder <email folder>');
  const folder = path.resolve(folderArg);
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  try {
    await emailStored(folder); // the email's row, if intake never made one (emails stored before the chain existed)
    await runFromProcessing(folder);
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
