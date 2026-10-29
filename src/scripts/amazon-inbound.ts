/*
 * Amazon inbound plan + shipment tracking by hand (2026-10-19). Reads Amazon (GET only) and our DB; writes only with --apply.
 *
 *   npm run amazon:inbound                       DRY RUN: new plans (last 90 days on the first run), shipments changed
 *                                                since the check point, what would change, and the calls an apply adds.
 *   npm run amazon:inbound -- --days 90 --apply  first load: plans of the last 90 days read once + 90 days of changes.
 *   npm run amazon:inbound -- --apply            a normal run (what the scheduler does every 2 hours).
 *   npm run amazon:inbound -- --sweep [--apply]  also the daily check of every open shipment now.
 *   npm run amazon:inbound -- --refresh FBA15XXXX one shipment now, lines included (always applies).
 * The scheduler (CHANNEL_API_ENABLED) runs the same thing by itself.
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { ERROR_CODES, INBOUND_EVENT_SOURCE } from '../constants';
import { spapiConfigured } from '../modules/channel-api/amazon/spapi.client';
import { InboundReport, refreshShipment, runInboundSync } from '../modules/channel-api/amazon/inbound-sync.service';
import { appError } from '../utils/AppError';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');

const print = (r: InboundReport) => {
  console.log(`window ${r.since} -> ${r.until}`);
  console.log(`plans: ${r.plans.new} new, ${r.plans.rechecked} re-checked (not split yet), ${r.plans.stillUnsplit} still not split`);
  const s = r.shipments;
  console.log(`shipments: ${s.fromPlans} from new plans, ${s.new} in the change list but not in our DB${r.apply ? '' : ' (most are shipments of the new plans above)'}, ${s.statusChanged} status changed, ` +
    `${s.linesChanged} lines changed, ${s.receivedUpdated} received updated, ${s.unchanged} unchanged, ${s.attention} need attention, ` +
    `${s.linked} linked to a PO${s.swept ? `, ${s.swept} checked by the daily check` : ''}`);
  const show = r.changes.slice(0, 60);
  for (const c of show) console.log(`  ${c}`);
  if (r.changes.length > show.length) console.log(`  … +${r.changes.length - show.length} more`);
  for (const e of r.errors.slice(0, 20)) console.log(`  ERROR ${e}`);
  console.log(`Amazon calls used: ${r.calls}${r.estimatedApplyCalls !== undefined ? ` · an apply would add about ${r.estimatedApplyCalls} more` : ''}`);
};

const main = async () => {
  if (!spapiConfigured()) throw appError(ERROR_CODES.SPAPI_NOT_CONFIGURED);
  await AppDataSource.initialize(); // guarded: only mcaff_postfg_dev
  try {
    const refresh = arg('refresh');
    if (refresh) {
      console.log(`REFRESH ${refresh} (applies) -> ${AppDataSource.options.database}`);
      print(await refreshShipment(refresh));
      return;
    }
    const days = arg('days') ? Number(arg('days')) : undefined;
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing is written)'} -> ${AppDataSource.options.database}`);
    print(await runInboundSync({ apply: APPLY, source: INBOUND_EVENT_SOURCE.SCRIPT, lookbackDays: days, sweep: process.argv.includes('--sweep') }));
    if (!APPLY) console.log('Add --apply to write.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
