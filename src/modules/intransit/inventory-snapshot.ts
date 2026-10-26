import fs from 'fs/promises';
import { Context } from './context';
import { pyStr } from './frame';

/*
 * The report's stock in the shape the Inventory Calculation page reads (2026-10-15, user): Combined_SOH_Intransit summed
 * per Final SKU Code x channel x channel type x location, with SOH and in-transit side by side. Written next to every
 * report (inventory.json) so the page never has to open the 40 MB workbook. Lines with 0 SOH and 0 in-transit are left out.
 */

export const INVENTORY_COLUMNS = ['sku', 'name', 'channel', 'type', 'location', 'soh', 'inTransit'] as const;

export interface InventorySnapshot {
  columns: typeof INVENTORY_COLUMNS;
  /** One array per row, in INVENTORY_COLUMNS order. */
  rows: [string, string, string, string, string, number, number][];
}

export const buildInventorySnapshot = (ctx: Context): InventorySnapshot => {
  const df = ctx.get('df_combined_soh');
  const text = (c: string): string[] => df.get(c).map((v) => (v === null || v === undefined ? '' : pyStr(v)));
  const sku = df.has('Final SKU Code') ? text('Final SKU Code') : text('SKU Code');
  const name = text('SKU Name');
  const channel = text('Channel Name');
  const type = text('Channel type');
  const location = text('Final Location');
  const stock = text('Stock Type');
  const units = df.get('Final Units').map((v) => Number(v) || 0);

  const byKey = new Map<string, InventorySnapshot['rows'][number]>();
  for (let i = 0; i < df.length; i++) {
    const key = `${sku[i]}\u0001${channel[i]}\u0001${type[i]}\u0001${location[i]}`;
    let row = byKey.get(key);
    if (!row) byKey.set(key, (row = [sku[i], name[i], channel[i], type[i], location[i], 0, 0]));
    if (!row[1] && name[i]) row[1] = name[i];
    if (stock[i] === 'Intransit') row[6] += units[i];
    else row[5] += units[i];
  }
  // A line with nothing on hand and nothing on the way says nothing on the page.
  return { columns: INVENTORY_COLUMNS, rows: [...byKey.values()].filter((r) => r[5] !== 0 || r[6] !== 0) };
};

export const writeInventorySnapshot = async (ctx: Context, file: string): Promise<void> => {
  const snap = buildInventorySnapshot(ctx);
  await fs.writeFile(`${file}.part`, JSON.stringify(snap));
  await fs.rename(`${file}.part`, file);
  ctx.log(`inventory snapshot: ${snap.rows.length.toLocaleString('en-US')} rows`);
};
