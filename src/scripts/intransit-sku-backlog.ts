/*
 * The new-SKU backlog (user, 2026-11-02): builds now ask Consider / Don't consider for every new SKU or marketplace
 * code - but those already missing today would make the first build ask about hundreds. This marks today's ones as
 * answered "Consider" (what the report has always done with them) and writes them to an Excel list to review; only SKUs
 * new from then on are asked.
 *
 *   npm run intransit:sku-backlog                    dry run: the list only (from the latest succeeded build)
 *   npm run intransit:sku-backlog -- --run 123       from build 123
 *   npm run intransit:sku-backlog -- --apply         also mark them answered (live server's masters: INTRANSIT_TEST=false)
 *
 * The list: storage/intransit/import/sku-backlog-<date>.xlsx (or --out <file>).
 */
import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import { gunzipSync } from 'zlib';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS } from '../constants';
import { Context } from '../modules/intransit/context';
import { reportSheetBlob } from '../modules/intransit/file-preview.service';
import { parseCsvFrame } from '../modules/intransit/io';
import { listRuns } from '../modules/intransit/runs.service';
import { findNewSkus } from '../modules/intransit/sku-fill';
import { applyIssueAnswers, reviewSettings } from '../modules/intransit/sku-review';
import { textXlsx } from '../modules/intransit/sources/files';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

/** The build's sheets the new-SKU check reads (label -> frame). */
const SHEETS: [string, string][] = [
  ['Sheet35(2)', 'df_sheet35'],
  ['SKU not available in Sheet35(2)', 'df_gap_sheet35'],
  ['Final SKU Not Mapped', 'df_final_sku_not_mapped'],
  ['Missing_Items_Report', 'df_missing_items'],
];

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  await AppDataSource.initialize();
  try {
    const id = arg('run') ?? (await listRuns(INTRANSIT_RUN_KIND.REPORT, 50)).find((r) => r.status === INTRANSIT_RUN_STATUS.SUCCEEDED)?.id;
    if (!id) throw new Error('no succeeded build to read: build one first, or pass --run <id>');
    const ctx = new Context({ inputDir: '.', templateXlsx: '', outputDir: '.', asOf: '' }, (l) => console.log(l));
    for (const [sheet, frame] of SHEETS) {
      const blob = await reportSheetBlob(id, sheet);
      const raw = await blob.read();
      ctx.set(frame, parseCsvFrame(Buffer.from(blob.gzip ? gunzipSync(raw) : raw).toString('utf8'), sheet));
    }
    const items = findNewSkus(ctx, ctx.get('df_sheet35'), await reviewSettings(null, '.'));
    const day = new Date().toISOString().slice(0, 10);
    const out = arg('out') ?? path.join(env.intransit.dir, 'import', `sku-backlog-${day}.xlsx`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, textXlsx([{
      name: 'New SKUs (backlog)',
      rows: [
        ['Kind', 'SKU', 'Channel', 'Listing code', 'Name', 'MRP', 'COGS', 'Units', 'Why', 'Channel types'],
        ...items.map((n) => [n.kind === 'code' ? 'Marketplace code' : 'SKU', n.sku, n.channel ?? '', n.code ?? '', n.name, n.mrp === null ? '' : String(n.mrp), n.cogs === null ? '' : String(n.cogs), String(n.units), n.reasons.join('; '), n.channelTypes]),
      ],
      widths: [16, 22, 12, 22, 40, 10, 10, 10, 40, 18],
    }]));
    const skus = items.filter((n) => n.kind === 'sku').length;
    console.log(`build ${id}: ${skus} SKU(s) and ${items.length - skus} marketplace code(s) not answered yet - list: ${out}`);
    if (!apply) {
      console.log('dry run: nothing marked. Run again with --apply to mark them answered (Consider).');
      return;
    }
    // SKUs and codes: Consider (as the report has counted them); combos / _S codes / locations can only be fixed, so
    // they stay in the list and are asked at the builds
    const sku = (n: (typeof items)[number]) => n.kind === 'sku' || n.kind === 'code';
    const r = await applyIssueAnswers(items, items.map((n) => ({ kind: n.kind, sku: n.sku, channel: n.channel, code: n.code, action: sku(n) ? 'consider' as const : 'ignore' as const })), { id: null, name: 'sku backlog (script)' });
    console.log(`marked answered: ${r.fixed} SKU(s) / code(s) (Consider). Still asked at builds until fixed: ${r.ignored} combo / location / _S code issue(s).`);
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
