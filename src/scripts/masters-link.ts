/*
 * Fills the link columns (facility, location, transporter ids) from the text next to them; see
 * modules/masters/master-link.service.ts. DRY RUN by default; --apply writes in one transaction. Safe to run again.
 *
 *   npm run masters:link [-- --verbose] [-- --apply]
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { planLinks } from '../modules/masters/master-link.service';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const SHOW = 15;

const main = async (): Promise<void> => {
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : 'DRY RUN: nothing is written');
  try {
    const plan = await planLinks(AppDataSource);
    for (const t of plan.targets) {
      console.log(`\n== ${t.name}`);
      console.log(`   set ${t.changes.length} · already right ${t.same} · no text ${t.empty} · kept (text matches nothing now) ${t.kept} · unmatched ${[...t.unmatched.values()].reduce((a, b) => a + b, 0)}`);
      for (const c of t.changes.slice(0, VERBOSE ? undefined : SHOW)) console.log(`   ${c.id}: ${c.from ?? 'null'} -> ${c.to}  ("${c.text}")`);
      if (!VERBOSE && t.changes.length > SHOW) console.log(`   ... ${t.changes.length - SHOW} more (--verbose shows all)`);
      for (const [text, n] of t.unmatched) console.log(`   unmatched: ${text} x${n}`);
    }
    if (APPLY) {
      await AppDataSource.transaction((m) => plan.apply(m));
      console.log('\nDone.');
    } else console.log('\nDry run only. Add --apply to write.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
