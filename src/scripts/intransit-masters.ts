/*
 * Move the in-transit masters into the database (Final SKU Mapping, Split1/2, Sheet35(2), SKU-Not To Consider,
 * Location Master, MyntraWHIDs, warehouse buckets, Channel SKU Mapping -> temporary table). See
 * modules/intransit/masters-import.ts for the rules.
 *
 *   npm run intransit:masters                 DRY RUN: prints the plan, writes the change log, writes NOTHING
 *   npm run intransit:masters -- --apply      writes everything in one transaction
 *   ... --no-uniware                          without Uniware's checks (combos as in the files, missing SKUs code-only)
 *
 * The change log (an xlsx, every cell text) goes to storage/intransit/import/.
 */
import 'reflect-metadata';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { importIntransitMasters } from '../modules/intransit/masters-import';

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  await AppDataSource.initialize();
  try {
    const r = await importIntransitMasters({
      apply, log: (m) => console.log(m), outDir: path.join(path.resolve(env.intransit.dir), 'import'), uniware: !process.argv.includes('--no-uniware'),
    });
    console.log('');
    for (const [k, v] of r.summary) console.log(`${k.padEnd(58)} ${v}`);
    console.log(`\nchange log: ${r.logFile}`);
    if (!r.applied) console.log('Dry run only. Add --apply to write.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
