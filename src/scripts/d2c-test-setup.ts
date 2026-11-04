/*
 * D2C internal transfers, test setup (2026-11-03; rework for local TEST ONLY mode, user: "while on local host everything
 * is made in test facility and everything is test so that real working doesn't change"). Uniware already has the test
 * side (facility TEST_FACILITY, channel mCaff_Test, customer Test_Channel, vendor Test_Vendor, SKU TEST_UNICOM1).
 *
 * Makes the test route FULLY test: TEST_FACILITY sends to itself, so neither the sale order (at the sender) nor the
 * inward PO (at the receiving facility) can ever touch a real warehouse in Uniware.
 *   1. master_facilities  TEST_FACILITY: is_active 1, allow_internal_transfer 1, uniware_export 0, intransit_group /
 *      intransit_type / intransit_feed / stock_formula NULL, source manual (added when missing; else only checked).
 *   2. details_channels   a transfer location of McaffeineB2C: channel_location_code 'TEST', transfer_facility_id =
 *      TEST_FACILITY, transfer_po_prefix 'TEST_FACILITY', intransit_location NULL (never in the in-transit Location
 *      Master / MyntraWHIDs exports or the report's location list), facility_code NULL, is_active 1 (added when missing).
 *   3. d2c_transfer_routes  TEST_FACILITY -> McaffeineB2C / TEST, uniware channel mCaff_Test, customer Test_Channel,
 *      vendor Test_Vendor (added when missing).
 *   4. d2c_transfer_routes  the OLD test route TEST_FACILITY -> McaffeineB2C / Nagpur (receiving Mcaff_Nagpur, a REAL
 *      warehouse): switched off (is_active 0), never deleted.
 * Each change has its master_change_logs row (History in Masters) with source script.
 * d2c:settings.testFacilities must hold TEST_FACILITY (migration default): checked, not changed.
 * DRY RUN by default; --apply writes, in one transaction. No Uniware call.
 *
 *   npx ts-node --transpile-only src/scripts/d2c-test-setup.ts [--apply] [--by <email>]
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { D2C_FINAL_STAGES, MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE, TABLES } from '../constants';
import { User } from '../entities';
import { addedWith, logMasterChanges, MasterLogEntry } from '../modules/masters/master-log';
import { readSettings } from '../modules/d2c-transfers/settings';

const APPLY = process.argv.includes('--apply');
const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const TEST_SETUP = {
  FACILITY: {
    code: 'TEST_FACILITY', name: 'TEST FACILITY (Uniware test warehouse, D2C transfer tests only)', is_active: 1, allow_internal_transfer: 1,
    uniware_export: 0, intransit_group: null, intransit_type: null, intransit_feed: null, stock_formula: null, source: 'manual',
    remarks: 'Uniware test facility for D2C internal transfer tests (2026-11-03). Not a real warehouse: never export / count it.',
  },
  CHANNEL: 'McaffeineB2C',
  LOCATION: { code: 'TEST', prefix: 'TEST_FACILITY' },
  ROUTE: { uniwareChannelCode: 'mCaff_Test', customerCode: 'Test_Channel', customerName: 'Test Channel (Uniware test)', vendorCode: 'Test_Vendor' },
  OLD_LOCATION: 'Nagpur',
} as const;

type Row = Record<string, unknown>;
const one = async <T extends Row>(sql: string, params: unknown[] = []): Promise<T | undefined> => (await AppDataSource.query<T[]>(sql, params))[0];

interface LocationRow {
  id: string; channel_id: number; channel_category: string | null; transfer_facility_id: number | null; receiving: string | null; transfer_po_prefix: string | null;
  intransit_location: string | null; facility_code: string | null; is_active: number;
}
const LOCATION_SQL = `SELECT d.id, d.channel_id, d.channel_category, d.transfer_facility_id, f.code receiving, d.transfer_po_prefix, d.intransit_location,
         d.facility_code, d.is_active
    FROM ${TABLES.DETAILS_CHANNELS} d LEFT JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id
   WHERE d.channel_name = ? AND d.channel_location_code = ? ORDER BY d.id`;
interface RouteRow { id: number; uniware_channel_code: string | null; customer_code: string | null; vendor_code: string | null; is_active: number }
const ROUTE_SQL = `SELECT id, uniware_channel_code, customer_code, vendor_code, is_active FROM ${TABLES.D2C_TRANSFER_ROUTES}
   WHERE dispatch_facility_id = ? AND location_id = ? ORDER BY id`;

const main = async (): Promise<void> => {
  await AppDataSource.initialize(); // guarded: only the allowed databases
  console.log(APPLY ? `APPLY -> ${AppDataSource.options.database}` : `DRY RUN on ${AppDataSource.options.database}: nothing is written (add --apply)`);
  console.log(`this machine: D2C local test mode ${env.d2c.testOnly ? 'ON' : 'OFF'} (env.d2c.testOnly)`);
  try {
    const F = TEST_SETUP.FACILITY;
    const L = TEST_SETUP.LOCATION;
    const R = TEST_SETUP.ROUTE;
    const C = TEST_SETUP.CHANNEL;
    const problems: string[] = [];
    const facility = await one<{ id: number; code: string; is_active: number; allow_internal_transfer: number; uniware_export: number; intransit_group: string | null }>(
      `SELECT id, code, is_active, allow_internal_transfer, uniware_export, intransit_group FROM ${TABLES.MASTER_FACILITIES} WHERE code = ?`, [F.code],
    );
    const channel = await one<{ id: number }>(`SELECT id FROM ${TABLES.MASTER_CHANNELS} WHERE display_name = ?`, [C]);
    if (!channel) throw new Error(`channel ${C} not found in master_channels`);
    // the channel_category most transfer locations of the channel have (D2C) is copied
    const sibling = await one<{ channel_category: string | null }>(
      `SELECT channel_category FROM ${TABLES.DETAILS_CHANNELS} WHERE channel_name = ? AND transfer_facility_id IS NOT NULL AND channel_category IS NOT NULL
        GROUP BY channel_category ORDER BY COUNT(*) DESC LIMIT 1`, [C],
    );
    const [location, ...extraLocations] = await AppDataSource.query<LocationRow[]>(LOCATION_SQL, [C, L.code]);
    const [oldLocation] = await AppDataSource.query<LocationRow[]>(LOCATION_SQL, [C, TEST_SETUP.OLD_LOCATION]);
    const route = facility && location ? (await AppDataSource.query<RouteRow[]>(ROUTE_SQL, [facility.id, location.id]))[0] : undefined;
    const oldRoutes = facility && oldLocation ? await AppDataSource.query<RouteRow[]>(ROUTE_SQL, [facility.id, oldLocation.id]) : [];
    const settings = await readSettings();

    console.log('\n1. master_facilities');
    if (facility) {
      console.log(`   exists: id ${facility.id} ${facility.code} active=${facility.is_active} allow_internal_transfer=${facility.allow_internal_transfer} uniware_export=${facility.uniware_export} intransit_group=${facility.intransit_group ?? 'NULL'}`);
      if (!Number(facility.allow_internal_transfer) || !Number(facility.is_active)) problems.push('TEST_FACILITY exists but is not active / not allowed: switch it on in Masters (not changed here)');
      if (Number(facility.uniware_export) || facility.intransit_group) problems.push('TEST_FACILITY exists WITH uniware_export / intransit_group: fix in Masters before testing');
    } else {
      console.log(`   INSERT ${Object.entries(F).map(([k, v]) => `${k}=${v === null ? 'NULL' : JSON.stringify(v)}`).join(', ')}`);
      console.log('   + master_change_logs: facility, created');
    }

    console.log(`\n2. details_channels  ${C} / ${L.code} (transfer location received by ${F.code})`);
    if (extraLocations.length) problems.push(`${extraLocations.length + 1} rows ${C} / ${L.code} in details_channels: keep one (not changed here)`);
    if (location) {
      console.log(`   exists: id ${location.id} receiving=${location.receiving ?? 'NULL'} prefix=${location.transfer_po_prefix ?? 'NULL'} intransit_location=${location.intransit_location ?? 'NULL'} facility_code=${location.facility_code ?? 'NULL'} active=${location.is_active}`);
      if (location.receiving !== F.code) problems.push(`location ${C} / ${L.code} exists with receiving ${location.receiving ?? 'NULL'}, not ${F.code}: fix in Masters (not changed here)`);
      if (location.intransit_location || location.facility_code) problems.push(`location ${C} / ${L.code} has intransit_location / facility_code set: clear them (it must never reach in-transit or PO matching)`);
      if (location.transfer_po_prefix !== L.prefix) problems.push(`location ${C} / ${L.code} has PO prefix ${location.transfer_po_prefix ?? 'NULL'}, expected ${L.prefix}`);
      if (!Number(location.is_active)) problems.push(`location ${C} / ${L.code} is switched off`);
    } else {
      console.log(`   INSERT channel_id=${channel.id}, channel_name=${C}, channel_location_code=${L.code}, channel_category=${sibling?.channel_category ?? 'NULL'}, transfer_facility_id=<${F.code} id${facility ? ` ${facility.id}` : ''}>, transfer_po_prefix=${L.prefix}, intransit_location=NULL, facility_code=NULL, is_active=1`);
      console.log('   + master_change_logs: location, created');
    }

    console.log(`\n3. d2c_transfer_routes  ${F.code} -> ${C} / ${L.code}`);
    if (route) {
      console.log(`   exists: id ${route.id} channel=${route.uniware_channel_code} customer=${route.customer_code} vendor=${route.vendor_code} active=${route.is_active}`);
      if (!Number(route.is_active)) problems.push(`route ${F.code} -> ${C} / ${L.code} exists but is switched off: switch it on in Masters`);
    } else {
      console.log(`   INSERT dispatch_facility_id=<${F.code} id>, location_id=<${C} / ${L.code} id>, uniware_channel_code=${R.uniwareChannelCode}, customer_code=${R.customerCode}, customer_name=${JSON.stringify(R.customerName)}, vendor_code=${R.vendorCode}, is_active=1`);
      console.log('   + master_change_logs: transfer_route, created');
    }

    console.log(`\n4. old test route  ${F.code} -> ${C} / ${TEST_SETUP.OLD_LOCATION}${oldLocation ? ` (details_channels id ${oldLocation.id}, receiving ${oldLocation.receiving ?? 'NULL'}: a REAL warehouse)` : ''}`);
    const toSwitchOff = oldRoutes.filter((r) => Number(r.is_active) === 1);
    if (!oldRoutes.length) console.log('   none: nothing to switch off');
    for (const r of oldRoutes) {
      console.log(`   id ${r.id} channel=${r.uniware_channel_code} customer=${r.customer_code} vendor=${r.vendor_code} active=${r.is_active}${Number(r.is_active) ? ' -> UPDATE is_active=0 (+ master_change_logs: transfer_route, deactivated)' : ' (already off)'}`);
    }
    if (oldLocation) {
      const open = await one<{ n: string }>(
        `SELECT COUNT(*) n FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE transferCode IS NOT NULL AND facility = ? AND locationId = ? AND (transferStage IS NULL OR transferStage NOT IN (?))`,
        [F.code, oldLocation.id, D2C_FINAL_STAGES],
      );
      console.log(`   transfers still open on it: ${open?.n ?? 0} (left as they are; the purge --only-test lists test transfers)`);
    }

    console.log(`\n5. app_state d2c:settings  live=${settings.live} testFacilities=${JSON.stringify(settings.testFacilities)} (not changed)`);
    if (!settings.testFacilities.includes(F.code)) problems.push(`d2c:settings.testFacilities does not hold ${F.code}: add it before the test`);
    if (settings.live) problems.push('d2c:settings.live is TRUE: every facility could be written (on a server not in test mode)');
    console.log('\nNothing else is written: no transfer, no SKU, no Uniware call. A test transfer is then made on the screen:');
    console.log(`   sender ${F.code}, channel ${C}, location ${L.code} (receiving ${F.code}), SKU TEST_UNICOM1, qty 1-3.`);
    if (problems.length) console.log(`\nPROBLEMS:\n${problems.map((p) => `   - ${p}`).join('\n')}`);
    const todo = !facility || !location || !route || toSwitchOff.length > 0;
    if (!todo) return console.log('\nNothing to change.');
    if (!APPLY) return;
    if (problems.length) throw new Error('not applied: fix the problems above first');

    const by = arg('by');
    const user = by ? await AppDataSource.getRepository(User).findOneBy({ email: by }) : null;
    if (by && !user) throw new Error(`--by ${by}: no such user`);
    await AppDataSource.transaction(async (m) => {
      const now = new Date();
      const logs: MasterLogEntry[] = [];
      let facilityId = facility?.id;
      if (!facilityId) {
        const r = await m.query(
          `INSERT INTO ${TABLES.MASTER_FACILITIES} (code, name, is_active, allow_internal_transfer, uniware_export, intransit_group, intransit_type, intransit_feed, stock_formula, source, remarks, created_at, updated_at)
           VALUES (?, ?, 1, 1, 0, NULL, NULL, NULL, NULL, 'manual', ?, ?, ?)`, [F.code, F.name, F.remarks, now, now]);
        facilityId = (r as { insertId: number }).insertId;
        logs.push({ type: MASTER_LOG_TYPE.FACILITY, recordId: facilityId, rowKey: F.code, action: MASTER_LOG_ACTION.CREATED,
          newValue: addedWith({ name: F.name, isActive: true, allowInternalTransfer: true, uniwareExport: false }) });
      }
      let locationId = location?.id;
      if (!locationId) {
        const r = await m.query(
          `INSERT INTO ${TABLES.DETAILS_CHANNELS} (channel_id, channel_name, channel_location_code, channel_category, transfer_facility_id, transfer_po_prefix, intransit_location, facility_code, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`, [channel.id, C, L.code, sibling?.channel_category ?? null, facilityId, L.prefix, now, now]);
        locationId = String((r as { insertId: number }).insertId);
        logs.push({ type: MASTER_LOG_TYPE.LOCATION, recordId: locationId, rowKey: `${C} | ${L.code}`, action: MASTER_LOG_ACTION.CREATED,
          newValue: addedWith({ channel: C, locationCode: L.code, transferFacility: F.code, transferPoPrefix: L.prefix, isActive: true }) });
      }
      if (!route) {
        const r = await m.query(
          `INSERT INTO ${TABLES.D2C_TRANSFER_ROUTES} (dispatch_facility_id, location_id, uniware_channel_code, customer_code, customer_name, vendor_code, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, [facilityId, locationId, R.uniwareChannelCode, R.customerCode, R.customerName, R.vendorCode, now, now]);
        logs.push({ type: MASTER_LOG_TYPE.TRANSFER_ROUTE, recordId: (r as { insertId: number }).insertId, rowKey: `${F.code} -> ${C} | ${L.code}`, action: MASTER_LOG_ACTION.CREATED,
          newValue: addedWith({ uniwareChannelCode: R.uniwareChannelCode, customerCode: R.customerCode, customerName: R.customerName, vendorCode: R.vendorCode, isActive: true }) });
      }
      for (const r of toSwitchOff) {
        await m.query(`UPDATE ${TABLES.D2C_TRANSFER_ROUTES} SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1`, [now, r.id]);
        logs.push({ type: MASTER_LOG_TYPE.TRANSFER_ROUTE, recordId: r.id, rowKey: `${F.code} -> ${C} | ${TEST_SETUP.OLD_LOCATION}`, action: MASTER_LOG_ACTION.DEACTIVATED,
          field: 'is_active', oldValue: 'Active', newValue: 'Inactive' });
      }
      await logMasterChanges(m, logs, { id: user?.id ?? null }, MASTER_LOG_SOURCE.SCRIPT, 'd2c-test-setup (fully test route TEST_FACILITY -> TEST)');
    });
    console.log('Applied.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
