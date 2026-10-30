import fs from 'fs';
import { Context } from '../context';
import { Frame } from '../frame';

/*
 * Shelfwise_Inventory (user, 2026-10-29): Uniware's Shelfwise Inventory export of the stock facilities, every row and
 * column as it came (shelf, section, batch, expiry, quantities). No other sheet reads it. It is an optional input: with
 * no copy the sheet holds one line saying so and the build warns, instead of the build being blocked.
 */

export const SHELFWISE_FILE = 'Export-Shelfwise Inventory.csv';

export const run = async (ctx: Context): Promise<void> => {
  if (!fs.existsSync(ctx.inputPath(SHELFWISE_FILE))) {
    ctx.warn(`${SHELFWISE_FILE}: no copy for this day or before, so the Shelfwise_Inventory sheet is empty - fetch Uniware (Shelfwise Inventory only) and build again`);
    ctx.set('df_shelfwise', Frame.fromRows(['Note'], [[`No ${SHELFWISE_FILE} for this build: fetch it from Uniware and build again`]]));
    return;
  }
  const df = await ctx.readInput(SHELFWISE_FILE);
  ctx.set('df_shelfwise', df);
  ctx.log(`  Shelfwise_Inventory: ${df.length.toLocaleString('en-US')} rows`);
};
