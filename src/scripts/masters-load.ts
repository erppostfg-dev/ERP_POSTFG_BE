/*
 * Loads the PO Overview masters, from PEPIMS's own tables (read-only) or from a CSV with the same columns
 * (constants/masters.ts MASTER_CSV_COLUMNS).
 * DRY RUN by default: prints what would be added / updated / skipped; --apply writes, one transaction per type.
 * Never deletes or switches anything off: active rows missing from the source are only listed.
 *
 *   npm run masters:load -- --all --pepims [--apply]                     every type from mcaff_inv, source "pepims"
 *   npm run masters:load -- --type facility --pepims [--apply]           one type
 *   npm run masters:load -- --type facility --file <path.csv> --source <uniware|manual|pepims> [--set-code] [--apply]
 *   options: --verbose (every row, not only changes)
 * After loading, run `npm run masters:link` so the link columns follow the new data.
 */
import 'reflect-metadata';
import fs from 'fs';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { ERROR_CODES, MASTER_LOAD_TYPES, MASTER_SOURCE, MasterLoadType, MasterSource } from '../constants';
import { LoadPlan, missingColumns, planMasterLoad } from '../modules/masters/master-load.service';
import { readPepimsMasters, SourceRows } from '../modules/masters/pepims-source';
import { csvRecords } from '../utils/csv';
import { appError } from '../utils/AppError';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const APPLY = flag('apply');
const VERBOSE = flag('verbose');
const SHOW = 15;

const USAGE = `masters:load -- (--all | --type <${MASTER_LOAD_TYPES.join('|')}>) (--pepims | --file <csv> --source <${Object.values(MASTER_SOURCE).join('|')}>) [--set-code] [--verbose] [--apply]`;

const print = (plan: LoadPlan, from: string) => {
  const count = (a: string) => plan.changes.filter((c) => c.action === a).length;
  console.log(`\n== ${plan.type}  (${from})`);
  console.log(`   add ${count('add')} · update ${count('update')} · same ${count('same')} · skip ${count('skip')} · active in DB but not in source ${plan.notInFile.length}`);
  // Adds / updates first (up to SHOW), then the skips grouped by reason with a few examples each.
  const shown = plan.changes.filter((c) => VERBOSE || (c.action !== 'same' && c.action !== 'skip'));
  for (const c of shown.slice(0, VERBOSE ? undefined : SHOW)) console.log(`   ${c.action.padEnd(6)} ${c.key}${c.detail ? `  [${c.detail}]` : ''}`);
  if (!VERBOSE && shown.length > SHOW) console.log(`   ... ${shown.length - SHOW} more (--verbose shows all)`);
  if (!VERBOSE) {
    const byReason = new Map<string, string[]>();
    for (const c of plan.changes.filter((x) => x.action === 'skip')) byReason.set(c.detail ?? '', [...(byReason.get(c.detail ?? '') ?? []), c.key]);
    for (const [reason, keys] of byReason) console.log(`   skip x${keys.length}: ${reason}  e.g. ${keys.slice(0, 5).join(' | ')}${keys.length > 5 ? ' ...' : ''}`);
  }
  if (plan.notInFile.length) {
    console.log(`   not in source (left as they are): ${plan.notInFile.slice(0, VERBOSE ? undefined : SHOW).join(', ')}${!VERBOSE && plan.notInFile.length > SHOW ? ` ... +${plan.notInFile.length - SHOW}` : ''}`);
  }
};

const main = async (): Promise<void> => {
  const types: MasterLoadType[] = flag('all') ? [...MASTER_LOAD_TYPES] : [arg('type') as MasterLoadType];
  if (types.some((t) => !MASTER_LOAD_TYPES.includes(t))) throw appError(ERROR_CODES.CLI_USAGE, USAGE);
  const pepims = flag('pepims');
  const file = arg('file');
  const source = (pepims ? MASTER_SOURCE.PEPIMS : arg('source')) as MasterSource;
  if (pepims === !!file || !Object.values(MASTER_SOURCE).includes(source) || (file && types.length > 1)) throw appError(ERROR_CODES.CLI_USAGE, USAGE);

  // Read every source before touching our DB.
  let inputs: (SourceRows & { type: MasterLoadType })[];
  if (pepims) {
    const rows = await readPepimsMasters(types);
    inputs = types.map((type) => ({ type, ...rows.get(type)! }));
  } else {
    const p = path.resolve(file!);
    inputs = [{ type: types[0], from: p, ...csvRecords(fs.readFileSync(p, 'utf8')) }];
  }
  for (const i of inputs) {
    const missing = missingColumns(i.type, i.header);
    if (missing.length) throw appError(ERROR_CODES.CLI_USAGE, `${i.from}: missing column(s) ${missing.join(', ')}`);
  }

  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database} (source "${source}")` : `DRY RUN: nothing is written (source "${source}")`);
  try {
    // One type at a time: rates need the partners an earlier type added, so each is planned after the one before is applied.
    for (const i of inputs) {
      const plan = () => planMasterLoad(AppDataSource, i.type, i.header, i.records, { source, setCode: flag('set-code') });
      if (APPLY) {
        await AppDataSource.transaction(async (m) => {
          const p = await plan();
          print(p, i.from);
          await p.apply(m);
        });
      } else print(await plan(), i.from);
    }
    if (!APPLY && inputs.length > 1) console.log('\nNote: in a dry run, types that depend on an earlier one (courier-rates on courier-partner, status on status-values) are checked against what is in our DB NOW.');
    console.log(APPLY ? '\nDone. Next: npm run masters:link' : '\nDry run only. Add --apply to write.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
