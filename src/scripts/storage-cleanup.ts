/*
 * Local disk cleanup (2026-10-23; modules/email-intake/local-cleanup.service.ts). Lists every local email folder and
 * whether it would be removed: finished (not a PO, or every PO of it completed / rejected) at least
 * LOCAL_CLEANUP.MIN_AGE_HOURS ago AND every file confirmed in S3. Dry run by default; --apply removes them (the DB
 * remembers each one first). S3 and Gmail are never touched.
 *
 *   npm run storage:cleanup                (dry run: summary + the folders it would remove)
 *   npm run storage:cleanup -- --all       (dry run, every folder with its reason)
 *   npm run storage:cleanup -- --apply
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { runLocalCleanup } from '../modules/email-intake/local-cleanup.service';

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  await AppDataSource.initialize();
  try {
    const items = await runLocalCleanup({ apply });
    const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
    const byReason = new Map<string, { n: number; bytes: number }>();
    for (const i of items) {
      const key = i.remove ? (apply ? 'removed' : 'WOULD REMOVE') : `keep: ${i.reason.replace(/\(\d+ file\(s\)\)|\d+ h/g, '…')}`;
      const v = byReason.get(key) ?? { n: 0, bytes: 0 };
      byReason.set(key, { n: v.n + 1, bytes: v.bytes + i.bytes });
    }
    console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (nothing removed)'}: ${items.length} local email folder(s)\n`);
    for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(v.n).padStart(5)}  ${mb(v.bytes).padStart(9)}  ${k}`);
    console.log('');
    for (const i of items.filter((x) => all || x.remove)) console.log(`  ${i.remove ? (apply ? 'removed ' : 'remove  ') : 'keep    '} ${i.folder}  (${i.reason})`);
    if (!apply) console.log('\nNothing was removed. Run with --apply to remove the folders marked "remove".');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
