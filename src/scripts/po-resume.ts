/*
 * Resume unfinished POs after a restart, from po_uploads (no server needed).
 * DRY RUN by default: shows what each unfinished email would get. --apply does it (runs the OCR where needed,
 * writes to the DB and S3), one email at a time, within PIPELINE_LIMIT and --max.
 *
 *   npm run po:resume                            dry run: the to-do list
 *   npm run po:resume -- --apply --max 1         resume ONE email
 *   npm run po:resume -- --retry-failed          include failed rows (from the step they failed at)
 */
import 'reflect-metadata';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { RESUME_ACTION } from '../constants';
import { extractPo } from '../modules/ocr/extract-po.service';
import { applyResume, planResume } from '../modules/po-pipeline/resume.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');

const main = async (): Promise<void> => {
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  try {
    const items = await planResume(AppDataSource, process.argv.includes('--retry-failed'));
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.action, (counts.get(i.action) ?? 0) + 1);
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing done)'}: ${items.length} unfinished email(s) | ${[...counts].map(([a, n]) => `${a} ${n}`).join(', ')}`);
    for (const i of items) {
      const rows = i.rows.map((r) => `${r.id}${r.poNumber ? `:${r.poNumber}` : ''}=${r.status}`).join(' ');
      console.log(`  ${i.action.padEnd(9)} ${i.folder ? path.basename(i.folder) : '-'}  ${rows}  (${i.reason})`);
    }
    if (!APPLY) return;
    const max = Number(arg('max') ?? 0);
    const done = await applyResume(AppDataSource, items, {
      // The script waits for each OCR; the chain then runs from extractPo's hooks.
      runOcr: async (folder) => void (await extractPo(folder)),
      max,
    });
    console.log(`\nresumed ${done} email(s); ${items.filter((i) => i.action !== RESUME_ACTION.SKIP).length - done} left`);
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  process.exit(1);
});
