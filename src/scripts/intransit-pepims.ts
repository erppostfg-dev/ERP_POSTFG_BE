/*
 * Build Shipment_Status.csv and PO_Format.csv from PEPIMS (read only), as the in-transit report's build does.
 *
 *   npm run intransit:pepims -- [--date YYYY-MM-DD] [--days 90] [--out <folder>]
 *
 * Defaults: today (IST), PEPIMS_TRACKER_DAYS (90), output storage/intransit/manual/pepims. Nothing in INTRANSIT_DIR's
 * inputs is touched.
 */
import path from 'path';
import { env } from '../config/env';
import { PEPIMS_TRACKER_DAYS } from '../constants';
import { checkDate } from '../modules/intransit/input-store';
import { fetchPepimsTracker } from '../modules/intransit/sources/pepims';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  const asOf = checkDate(arg('date'));
  const days = Number(arg('days') ?? PEPIMS_TRACKER_DAYS);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days');
  const out = path.resolve(arg('out') ?? 'storage/intransit/manual/pepims');
  const r = await fetchPepimsTracker(env.db, out, asOf, (m) => console.log(m), days);
  console.log(`written to ${out}: ${r.files.join(', ')}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
