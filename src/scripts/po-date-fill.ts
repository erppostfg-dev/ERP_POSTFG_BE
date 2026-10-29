/*
 * Fills po_uploads.po_date for rows made before the column existed (2026-10-29, user: PO Date on the In Review tab).
 * Only rows with no saved PO (poUid empty: In Review, pending approval, rejected, ...) and no po_date yet: each one's
 * processed.json is read from S3 ONCE and its po_date (YYYY-MM-DD) written. New rows get it from the chain itself.
 * DRY RUN by default; --apply writes (one UPDATE per row, only po_date). Safe to run again (filled rows are skipped).
 *
 *   npm run po:po-date-fill [-- --apply]
 */
import 'reflect-metadata';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { PoUpload } from '../entities';
import { readS3Json } from '../modules/email-intake/s3-mirror.service';
import { dateOnly } from '../modules/po-pipeline/po-uploads.service';
import { ProcessedPo } from '../modules/po-processing/common/processed-po';

const APPLY = process.argv.includes('--apply');

const main = async (): Promise<void> => {
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  try {
    const repo = AppDataSource.getRepository(PoUpload);
    const rows = await repo.find({
      select: { id: true, poNumber: true, channel: true, status: true, ocrResult: true },
      where: { poDate: IsNull(), poUid: IsNull() },
      order: { id: 'ASC' },
    });
    const fills: { id: string; poDate: string }[] = [];
    let noFile = 0;
    let noDate = 0;
    for (const r of rows) {
      const url = r.ocrResult?.processed_json;
      if (typeof url !== 'string') { noFile++; continue; }
      const po = await readS3Json<ProcessedPo>(url);
      const d = dateOnly(po?.po_date);
      if (!d) { noDate++; console.log(`  ${r.id} ${r.poNumber ?? '-'} (${r.channel ?? '-'}, ${r.status}): no PO date in processed.json`); continue; }
      fills.push({ id: String(r.id), poDate: d });
      console.log(`  ${r.id} ${r.poNumber ?? '-'} (${r.channel ?? '-'}, ${r.status}): ${d}`);
    }
    console.log(`\n${rows.length} row(s) without a PO date and a saved PO: ${fills.length} to fill, ${noDate} with no date on the PO, ${noFile} not read yet (no processed.json).`);
    if (!APPLY) return console.log('Dry run only. Add --apply to write.');
    for (const f of fills) await repo.update({ id: f.id, poDate: IsNull() }, { poDate: f.poDate });
    console.log(`Done: ${fills.length} filled.`);
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
