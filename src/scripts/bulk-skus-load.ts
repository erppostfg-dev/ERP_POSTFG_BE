/*
 * Loads the Bulk Orders SKU list (2026-11-24; modules/bulk-orders/bulk-skus-load.ts): the file's SKUs are shown in the
 * Bulk Orders portal, every other SKU hidden; empty brands filled from the file. DRY RUN by default.
 *
 *   npm run bulk:skus -- --file "<xlsx or csv>" [--sheet "final to consider"] [--apply] [--by <email>]
 * The sheet / CSV needs the columns pep_code and brand_name in row 1.
 */
import 'reflect-metadata';
import fs from 'fs';
import { AppDataSource } from '../config/data-source';
import { User } from '../entities';
import { loadBulkSkus } from '../modules/bulk-orders/bulk-skus-load';
import { readRows, readXlsxSheet } from '../modules/intransit/sources/files';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const SHEET = arg('sheet') ?? 'final to consider';

const main = async () => {
  const file = arg('file');
  if (!file || !fs.existsSync(file)) throw new Error('usage: npm run bulk:skus -- --file "<xlsx or csv>" [--sheet "final to consider"] [--apply] [--by <email>]');
  const raw = new Uint8Array(fs.readFileSync(file));
  const grid = /\.xlsx$/i.test(file) ? readXlsxSheet(raw, SHEET) : readRows(raw);
  if (!grid?.length) throw new Error(`sheet "${SHEET}" not found or empty in ${file}`);
  const head = grid[0].map((h) => h.trim().toLowerCase());
  const ci = head.indexOf('pep_code');
  const bi = head.indexOf('brand_name');
  if (ci < 0 || bi < 0) throw new Error(`columns pep_code and brand_name needed in row 1 (found: ${grid[0].join(', ')})`);
  const rows = grid.slice(1).map((r) => ({ pepCode: (r[ci] ?? '').trim(), brand: (r[bi] ?? '').trim() })).filter((r) => r.pepCode);
  await AppDataSource.initialize();
  const email = arg('by');
  const user = email ? await AppDataSource.getRepository(User).findOneBy({ email }) : null;
  if (email && !user) throw new Error(`no user ${email}`);
  const p = await loadBulkSkus(rows, APPLY, { id: user?.id ?? null });
  const few = (a: unknown[]) => (a.length ? `${a.length}: ${a.slice(0, 15).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}${a.length > 15 ? ' ...' : ''}` : '0');
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} on ${String(AppDataSource.options.database)}: ${rows.length} file rows, ${p.listed} SKUs listed`);
  console.log(`  switched ON  ${few(p.on)}`);
  console.log(`  switched OFF ${few(p.off)}`);
  console.log(`  brand filled ${few(p.brandFill)}`);
  console.log(`  brand differs (master kept) ${few(p.brandDiffers)}`);
  console.log(`  listed but inactive (hidden until active) ${few(p.inactiveListed)}`);
  console.log(`  not in the master (skipped) ${few(p.notInMaster)}`);
  console.log(`  duplicates in the file ${few(p.duplicates)}`);
  if (!APPLY) console.log('Nothing written. Add --apply to load.');
  await AppDataSource.destroy();
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
