/*
 * PEPIMS -> POST_FG import + sync (2026-11-16; modules/pepims-sync/import.service.ts, constants/pepims-sync.ts).
 * PEPIMS (mcaff_inv, or PEPIMS_SYNC_SOURCE_DB) is only READ. DRY RUN by default: reads everything, writes nothing, prints
 * what would happen. Writing needs BOTH --apply and --target <the database the app is connected to> (DB_NAME), so a run
 * can never write to another database than the one named on the command line.
 *   npm run pepims:sync                                     dry run against DB_NAME
 *   npm run pepims:sync -- --limit 200                      dry run on the first 200 PEPIMS POs
 *   npm run pepims:sync -- --apply --target mcaff_postfg_prod
 * Watermarks (app_state pepims-sync:state) move only after a full --apply run: the next run reads only what changed.
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { runPepimsSync, SyncReport } from '../modules/pepims-sync/import.service';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const LIMIT = arg('limit') ? Number(arg('limit')) : undefined;
const TOP = 25;

const top = (title: string, o: Record<string, number>) => {
  const e = Object.entries(o).sort((a, b) => b[1] - a[1]);
  if (!e.length) return;
  console.log(`\n${title} (${e.length}):`);
  for (const [k, n] of e.slice(0, TOP)) console.log(`  ${n}\t${k}`);
  if (e.length > TOP) console.log(`  ... ${e.length - TOP} more`);
};

const print = (r: SyncReport) => {
  console.log(`\n=== PEPIMS sync ${r.apply ? 'APPLIED' : 'DRY RUN'}: ${r.source} -> ${r.target} ===`);
  console.log(`read ${r.read} PEPIMS POs | new ${r.inserted} (other uid: ${r.newUid}) | linked to ours ${r.linked} | updated ${r.updated} | unchanged ${r.unchanged} | skipped ${r.skipped.length}`);
  console.log(`field changes ${r.fieldChanges} | lines: new ${r.linesInserted}, linked ${r.linesLinked}, updated ${r.linesUpdated}, ours without a PEPIMS line ${r.oursWithoutPepimsLine} | PEPIMS log lines -> History ${r.logsAdded}`);
  console.log(r.writeBack ? `POST_FG -> PEPIMS: ${r.writeBack.posUpdated} POs updated (${r.writeBack.fieldsWritten} fields), ${r.writeBack.posAdded} POs added (${r.writeBack.linesAdded} lines)` : 'POST_FG -> PEPIMS: off (PEPIMS_SYNC_WRITE_BACK not true)');
  if (r.noLinkTables) console.log('NOTE: this database has no PEPIMS link tables yet (migration PepimsMigration not run): read as a first import.');
  if (r.skipped.length) console.log(`skipped (user: skip): ${r.skipped.join(', ')}`);
  top('new POs by group', r.byGroup);
  top('new POs by channel', r.byChannel);
  top('channel changes (History notes)', r.channelNotes);
  top('facility not matched (text kept, no link)', r.unmatched.facility);
  top('transporter not matched (text kept, no link)', r.unmatched.transporter);
  top('location not linked (text kept)', r.unmatched.location);
  top('status not in the master (kept as is)', r.unmatched.status);
  top('junk dates left empty', r.junkDates);
  if (r.conflictsKeptOurs.length) {
    console.log(`\nchanged on both sides, ours newer (kept ours): ${r.conflictsKeptOurs.length}`);
    for (const c of r.conflictsKeptOurs.slice(0, TOP)) console.log(`  uid ${c.uid} ${c.field}: PEPIMS ${String(c.pepims)} / ours ${String(c.ours)}`);
  }
  console.log(r.apply ? `\nSaved watermarks: ${JSON.stringify(r.saved)}` : '\nDry run only: nothing written. Add --apply --target <DB_NAME> to write.');
};

const main = async () => {
  await AppDataSource.initialize(); // guarded: only the allowed databases
  const db = String(AppDataSource.options.database);
  if (APPLY && arg('target') !== db) {
    console.error(`--apply needs --target ${db} (the database this run would write to). Nothing written.`);
    await AppDataSource.destroy();
    process.exit(2);
  }
  try {
    print(await runPepimsSync({ apply: APPLY, limit: LIMIT, log: (s) => console.log(s) }));
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((e: unknown) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
