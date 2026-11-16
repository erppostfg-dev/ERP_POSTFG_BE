/*
 * Dev -> prod copy (2026-11-16, step 2b; modules/pepims-sync/dev-copy.service.ts). Reads mcaff_postfg_dev, writes the
 * app's database. DRY RUN by default = the whole copy in one transaction, rolled back (exact counts, nothing kept).
 * Writing needs --apply AND --target <DB_NAME>. Run the PEPIMS import (npm run pepims:sync) FIRST: dev POs are matched
 * to the imported ones by channel + PO number.
 *   DB_NAME=mcaff_postfg_prod npm run dev:copy
 *   DB_NAME=mcaff_postfg_prod npm run dev:copy -- --apply --target mcaff_postfg_prod
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { runDevCopy } from '../modules/pepims-sync/dev-copy.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');

const main = async () => {
  await AppDataSource.initialize(); // guarded: only the allowed databases
  const db = String(AppDataSource.options.database);
  if (APPLY && arg('target') !== db) {
    console.error(`--apply needs --target ${db} (the database this run would write to). Nothing written.`);
    await AppDataSource.destroy();
    process.exit(2);
  }
  try {
    const r = await runDevCopy({ apply: APPLY, log: (s) => console.log(s) });
    console.log(`\n=== dev copy ${r.apply ? 'APPLIED' : 'DRY RUN (rolled back)'}: ${r.source} -> ${r.target} ===`);
    console.log(`users added: ${r.usersAdded.length ? r.usersAdded.join(', ') : 'none'}`);
    console.log(`POs: ${r.posLinked} matched to PEPIMS's, ${r.posAdded} only on dev (added, ${r.linesAdded} lines), ${r.posSkippedTransfers} D2C transfers left on dev`);
    console.log(`Uniware status filled from dev: ${r.uniwareStatusFilled} | sale order code notes: ${r.saleCodeNotes}`);
    for (const [t, n] of Object.entries(r.tables)) console.log(`  ${n}\t${t}`);
    if (!r.apply) console.log('\nDry run only: nothing kept. Add --apply --target <DB_NAME> to write.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((e: unknown) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
