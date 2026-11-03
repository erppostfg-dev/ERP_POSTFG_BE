import fs from 'fs';
import path from 'path';
import { INTRANSIT_INVENTORY_FILE, INTRANSIT_REPORT_NAME, REQUIRED_INPUTS, SHEET_FRAMES } from '../../constants';
import { Context, IntransitSettings } from './context';
import { writeReport } from './excel';
import { writeInventorySnapshot } from './inventory-snapshot';
import { writeMailFiles } from './mail-files';
import { Cell } from './frame';
import * as b2bOrders from './stages/b2b-orders';
import * as combinedIntransit from './stages/combined-intransit';
import * as duplicates from './stages/duplicates';
import * as entity from './stages/entity';
import * as finalSku from './stages/final-sku';
import * as inventory from './stages/inventory';
import * as lookups from './stages/lookups';
import * as quantities from './stages/quantities';
import * as shelfwise from './stages/shelfwise';
import * as shipments from './stages/shipments';
import * as whSummary from './stages/wh-summary';
import type { WhSummaryRow } from './stages/wh-summary';

/*
 * The in-transit stock pipeline (pipeline.py): every stage in order, then the workbook. Each stage only reads frames
 * written earlier:
 *   lookups             Export-B2B qty lookups + status
 *   shipments           df_full_shipment, df_intransit_stock, df_summary (Summary_Dashboard)
 *   quantities          df_full_shipment_v2 (Full_Shipment_Enhanced), df_intransit_stock_v2 (Intransit_Stock)
 *   duplicates          df_dup_report
 *   b2b_orders          df_po_not_found, df_b2b_intransit
 *   combined_intransit  df_combined_intransit
 *   inventory           df_current_inventory, df_combined_soh, df_channel_location_master, df_missing_items
 *   final_sku           adds Final SKU Code to the SKU-level frames; splits, Sheet35, gap sheets
 *   shelfwise           df_shelfwise (Shelfwise_Inventory: Uniware's Shelfwise Inventory export as it came)
 *   entity              Entity (Kreative: SKU code has HYP, else Pep) after Split2 SKU on Sheet35(2), Final Sheet35(2)
 *   wh_summary          df_wh_summary (WH_Summary, the mail's table: GMV / Units / COGS per warehouse row)
 */

export const STAGES: [string, (ctx: Context) => Promise<void>][] = [
  ['lookups', lookups.run],
  ['shipments', shipments.run],
  ['quantities', quantities.run],
  ['duplicates', duplicates.run],
  ['b2b_orders', b2bOrders.run],
  ['combined_intransit', combinedIntransit.run],
  ['inventory', inventory.run],
  ['final_sku', finalSku.run],
  ['shelfwise', shelfwise.run],
  ['entity', entity.run],
  ['wh_summary', whSummary.run],
];

/** One Summary_Dashboard row. */
export type SummaryRow = Record<string, Cell>;

export interface PipelineResult {
  reportPath: string | null;
  timings: Record<string, number>;
  summary: SummaryRow[];
  /** Row count per sheet, in workbook order. */
  sheetRows: Record<string, number>;
  /** What a person should see about this build (ctx.warn). */
  warnings: string[];
  /** GMV / Units / COGS per warehouse row (the in-transit mail's table). */
  whSummary: WhSummaryRow[];
}

export const reportPathFor = (settings: IntransitSettings): string => path.join(settings.outputDir, INTRANSIT_REPORT_NAME);

/** The inputs (and template) not found where the settings point. */
export const missingInputs = (settings: IntransitSettings): string[] => {
  const missing = REQUIRED_INPUTS.filter((n) => !fs.existsSync(path.join(settings.inputDir, n)));
  if (!fs.existsSync(settings.templateXlsx)) missing.push(`template (${settings.templateXlsx})`);
  return missing;
};

export const runPipeline = async (
  settings: IntransitSettings,
  onLog?: (line: string) => void,
  opts: { writeReport?: boolean } = {},
): Promise<{ ctx: Context; result: PipelineResult }> => {
  const missing = missingInputs(settings);
  if (missing.length) throw new Error(`missing inputs in ${settings.inputDir}: ${missing.join(', ')}`);

  const ctx = new Context(settings, onLog);
  ctx.log(`as-of ${settings.asOf}${settings.fromDate ? ` | from ${settings.fromDate}` : ''} | inputs ${settings.inputDir}`);
  for (const [name, stage] of STAGES) {
    const t = Date.now();
    ctx.log(`=== ${name} ===`);
    await stage(ctx);
    ctx.timings[name] = Math.round((Date.now() - t) / 10) / 100;
  }

  let reportPath: string | null = null;
  if (opts.writeReport !== false) {
    const t = Date.now();
    reportPath = await writeReport(ctx, reportPathFor(settings));
    await writeInventorySnapshot(ctx, path.join(settings.outputDir, INTRANSIT_INVENTORY_FILE));
    // the in-transit mail's attachments (2026-10-30)
    await writeMailFiles(ctx, settings.outputDir);
    ctx.timings.excel = Math.round((Date.now() - t) / 10) / 100;
  }

  const summary = ctx.get('df_summary');
  return {
    ctx,
    result: {
      reportPath,
      timings: ctx.timings,
      summary: Array.from({ length: summary.length }, (_, i) => Object.fromEntries(summary.columns.map((c) => [c, summary.get(c)[i]]))),
      sheetRows: Object.fromEntries(SHEET_FRAMES.map(([label, frame]) => [label, ctx.get(frame).length])),
      warnings: ctx.warnings,
      whSummary: ctx.whSummary ?? [],
    },
  };
};
