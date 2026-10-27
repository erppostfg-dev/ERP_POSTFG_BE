/*
 * Compare a built in-transit report with a reference workbook, tab by tab (fix plan W6).
 *
 *   npm run intransit:compare -- --run <built xlsx> --reference <reference xlsx> [--out <folder>] [--sheets "A,B"]
 *                                [--key "Sheet=Col1+Col2"]... [--max-cells 500]
 *
 * Prints one line per tab (match / format-only / differs / missing) and writes to --out (default
 * storage/intransit/compare): compare_summary.csv, compare_cells.csv (differing cells, real and format) and
 * compare_rows.csv (rows only in one file). Exits 1 when any tab differs or is missing, so it can gate a regression test.
 */
import fs from 'fs';
import path from 'path';
import { compareWorkbooks, SheetResult } from '../modules/intransit/compare';
import { toCsv, writeAtomic } from '../modules/intransit/sources/files';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const args = (name: string): string[] => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));

const fmt = (n: number): string => n.toLocaleString('en-US');
const unitsCell = (s: SheetResult): string => Object.entries(s.unitTotals).map(([c, [a, b]]) => `${c}: ${a} vs ${b}`).join('; ');

const line = (s: SheetResult): string => {
  if (s.verdict === 'missing') return `${s.verdict.padEnd(11)} ${s.sheet}: only in the ${s.inRun ? 'run' : 'reference'}`;
  const parts = [`rows ${s.rowsRun} vs ${s.rowsRef}`, `key ${s.key ? s.key.join('+') : '(whole row)'}`];
  if (s.missingColumns.length) parts.push(`missing columns [${s.missingColumns.join(', ')}]`);
  if (s.extraColumns.length) parts.push(`extra columns [${s.extraColumns.join(', ')}]`);
  if (!s.columnOrderSame) parts.push('column order differs');
  if (s.onlyRun || s.onlyRef) parts.push(`only in run ${s.onlyRun}, only in reference ${s.onlyRef}`);
  if (s.realCells) {
    const top = Object.entries(s.realByColumn).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} ${n}`);
    parts.push(`real cells ${s.realCells} (${top.join(', ')})`);
  }
  if (s.formatCells) parts.push(`format-only cells ${s.formatCells}`);
  const units = Object.entries(s.unitTotals).map(([c, [a, b]]) => `${c} ${fmt(a)} vs ${fmt(b)}`);
  if (units.length) parts.push(`units: ${units.join(', ')}`);
  return `${s.verdict.padEnd(11)} ${s.sheet}: ${parts.join(' | ')}`;
};

const main = async (): Promise<void> => {
  const runFile = arg('run');
  const refFile = arg('reference');
  if (!runFile || !refFile) throw new Error('Give --run <built xlsx> and --reference <reference xlsx>');
  const keys = Object.fromEntries(args('key').map((k) => {
    const [sheet, cols] = k.split('=');
    if (!sheet || !cols) throw new Error(`--key must be "Sheet=Col1+Col2", got "${k}"`);
    return [sheet, cols.split('+').map((c) => c.trim())];
  }));
  const outDir = path.resolve(arg('out') ?? 'storage/intransit/compare');

  const res = compareWorkbooks(
    new Uint8Array(fs.readFileSync(path.resolve(runFile))),
    new Uint8Array(fs.readFileSync(path.resolve(refFile))),
    { sheets: arg('sheets')?.split(',').map((s) => s.trim()).filter(Boolean), keys, maxCells: Number(arg('max-cells') ?? 500) },
    (s) => console.log(line(s)),
  );
  if (!res.tabOrderSame) console.log('tab order differs from the reference');

  await writeAtomic(path.join(outDir, 'compare_summary.csv'), toCsv([
    ['Tab', 'Verdict', 'Rows run', 'Rows reference', 'Key', 'Matched', 'Only in run', 'Only in reference', 'Real cells', 'Format-only cells',
      'Missing columns', 'Extra columns', 'Column order same', 'Unit totals (run vs reference)'],
    ...res.sheets.map((s) => [s.sheet, s.verdict, String(s.rowsRun), String(s.rowsRef), s.key?.join('+') ?? '', String(s.matched), String(s.onlyRun),
      String(s.onlyRef), String(s.realCells), String(s.formatCells), s.missingColumns.join('; '), s.extraColumns.join('; '), String(s.columnOrderSame), unitsCell(s)]),
  ]));
  await writeAtomic(path.join(outDir, 'compare_cells.csv'), toCsv([['Tab', 'Key', 'Column', 'Run', 'Reference', 'Kind'], ...res.cells.map((c) => [c.sheet, c.key, c.column, c.run, c.ref, c.kind])]));
  await writeAtomic(path.join(outDir, 'compare_rows.csv'), toCsv([['Tab', 'Only in', 'Key'], ...res.rows.map((r) => [r.sheet, r.side === 'run' ? 'run' : 'reference', r.key])]));

  const bad = res.sheets.filter((s) => s.verdict === 'differs' || s.verdict === 'missing');
  console.log(`\n${res.sheets.length - bad.length} of ${res.sheets.length} tabs match (format-only allowed); details in ${outDir}`);
  if (bad.length || !res.tabOrderSame) process.exit(1);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
