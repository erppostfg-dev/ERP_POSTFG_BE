/*
 * Step 1 of saving POs: po_uploads (one row per PO) + po_issues, from the processed.json files of stored emails.
 * DRY RUN by default: reads the DB and prints what it would write. --apply writes it (one transaction per email).
 *
 *   npm run po:record -- --folder storage/emails/po-intake/2026-10-01_1461bdc39c715719
 *   npm run po:record -- --label po-intake --channel zepto
 *   npm run po:record -- --folder <folder> --apply
 */
import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { ERROR_CODES } from '../constants';
import { applyPlan, planEmail, readFolderPos } from '../modules/po-pipeline/po-uploads.service';
import { MasterDataReader } from '../modules/po-validation/master-data';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');

const main = async (): Promise<void> => {
  const folder = arg('folder');
  const label = arg('label');
  const channel = arg('channel');
  if (!folder && !label) {
    throw appError(ERROR_CODES.CLI_USAGE, 'Give --folder <email folder> or --label <label folder> [--channel <name>] [--apply]');
  }
  const root = label ? path.resolve(env.storage.emailDir, label) : '';
  const folders = folder
    ? [path.resolve(folder)]
    : (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  const reader = new MasterDataReader(AppDataSource);
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  try {
    for (const f of folders) {
      const pos = await readFolderPos(f);
      if (!pos.length || (channel && pos[0].po.channel_name !== channel)) continue;
      const plan = await planEmail(AppDataSource, reader, f);
      console.log(`\n${path.basename(f)}  ${pos[0].po.channel_name}  ${plan.rows.length} PO(s)  message ${plan.messageId ?? '-'}`);
      for (const r of plan.rows) {
        const row = r.final ? `final (${r.existing?.status}), unchanged` : r.existing ? `update row ${r.existing.id}` : 'new row';
        console.log(
          `  ${r.poNumber.padEnd(20)} ${row.padEnd(18)} status ${r.status.padEnd(12)} ocr ${String(r.values.ocrStatus).padEnd(8)} ` +
            `issues: +${r.issues.create.length} new, ${r.issues.keep.length} still open, ${r.issues.close.length} closed | file ${r.values.fileName}`,
        );
        for (const c of r.issues.create) console.log(`      + [${c.issueType}] ${c.fieldName} ${c.lineNo ?? ''} ${JSON.stringify(c.originalValues)}`);
      }
      if (APPLY) {
        const ids = await applyPlan(AppDataSource, plan);
        console.log(`  written: ${[...ids].map(([po, id]) => `${po}=po_uploads.${id}`).join(', ')}`);
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
