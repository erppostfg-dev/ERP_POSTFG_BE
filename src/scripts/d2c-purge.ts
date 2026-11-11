/*
 * Deletes every D2C internal transfer (2026-11-03; plan d2c-internal-transfers v3 section 2.12), so the D2cTransfers
 * migration can be undone (its down() refuses while any transfer exists). Transfers = master_purchase_orders rows with
 * transferCode NOT NULL. In foreign-key order, in ONE transaction: po_invoices, the transfers' shipment_logs rows,
 * their details_purchase_orders lines, the headers. Channel POs are never touched. Never run by a migration.
 * Nothing is deleted in Uniware: SOs / inward POs made there stay.
 * DRY RUN by default (counts + the transfer codes); --apply deletes.
 * --only-test (2026-11-03): only the TEST transfers: remarks (specialRemarksCOPT) starting 'TEST', or sent by / to a
 * test facility (TEST_FACILITY + d2c:settings.testFacilities); their po_invoices only. Real transfers stay.
 *
 *   npm run d2c:purge [-- --only-test] [-- --apply]
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data-source';
import { TABLES } from '../constants';
import { readSettings } from '../modules/d2c-transfers/settings';
import { testCodesOf } from '../modules/d2c-transfers/test-mode';

const APPLY = process.argv.includes('--apply');
const ONLY_TEST = process.argv.includes('--only-test');
/** The transfers to delete (alias p): every one, or (--only-test) the test ones; the codes are inlined as quoted literals. */
const scopeOf = (codes: string[]): string => {
  if (!ONLY_TEST) return 'p.transferCode IS NOT NULL';
  // facility codes are plain (letters, digits, _ -); anything else is left out rather than quoted
  const list = codes.filter((c) => /^[A-Za-z0-9_-]+$/.test(c)).map((c) => `'${c}'`).join(', ');
  return `p.transferCode IS NOT NULL AND (p.specialRemarksCOPT LIKE 'TEST%' OR p.facility IN (${list})
    OR EXISTS (SELECT 1 FROM ${TABLES.DETAILS_CHANNELS} d JOIN ${TABLES.MASTER_FACILITIES} f ON f.id = d.transfer_facility_id
               WHERE d.id = p.locationId AND f.code IN (${list})))`;
};

const count = async (sql: string): Promise<number> => Number((await AppDataSource.query<{ n: string }[]>(sql))[0]?.n ?? 0);

const main = async (): Promise<void> => {
  await AppDataSource.initialize(); // guarded: only the allowed databases
  console.log(`${APPLY ? `APPLY -> ${AppDataSource.options.database}` : `DRY RUN on ${AppDataSource.options.database}: nothing is deleted (add --apply)`}${ONLY_TEST ? ' | --only-test' : ' | ALL transfers'}`);
  try {
    const scope = scopeOf(testCodesOf(await readSettings()));
    const TRANSFERS = `SELECT p.uid FROM ${TABLES.MASTER_PURCHASE_ORDERS} p WHERE ${scope}`;
    const codes = await AppDataSource.query<{ code: string; ref: string | null; sender: string | null; receiving: string | null; remarks: string | null; stage: string | null; so: string | null }[]>(
      `SELECT p.transferCode code, p.poNumber ref, p.facility sender, rf.code receiving, p.specialRemarksCOPT remarks, p.transferStage stage, p.orderNo1 so
         FROM ${TABLES.MASTER_PURCHASE_ORDERS} p
         LEFT JOIN ${TABLES.DETAILS_CHANNELS} rd ON rd.id = p.locationId LEFT JOIN ${TABLES.MASTER_FACILITIES} rf ON rf.id = rd.transfer_facility_id
        WHERE ${scope} ORDER BY p.uid`,
    );
    const n = {
      invoices: await count(`SELECT COUNT(*) n FROM ${TABLES.PO_INVOICES}${ONLY_TEST ? ` WHERE po_uid IN (${TRANSFERS})` : ''}`),
      logs: await count(`SELECT COUNT(*) n FROM ${TABLES.SHIPMENT_LOGS} WHERE shipment_uid IN (${TRANSFERS})`),
      lines: await count(`SELECT COUNT(*) n FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE shipmentOrderId IN (${TRANSFERS})`),
      transfers: codes.length,
    };
    console.log(`  po_invoices              ${n.invoices}`);
    console.log(`  shipment_logs            ${n.logs}`);
    console.log(`  details_purchase_orders  ${n.lines}`);
    console.log(`  master_purchase_orders   ${n.transfers} transfer(s)`);
    for (const c of codes.slice(0, 50)) {
      console.log(`    ${c.code}  ${c.ref ?? ''}  ${c.sender ?? '-'} -> ${c.receiving ?? '-'}  stage=${c.stage ?? '-'} SO=${c.so ?? '-'}  remarks=${JSON.stringify((c.remarks ?? '').slice(0, 60))}`);
    }
    if (codes.length > 50) console.log(`    ... and ${codes.length - 50} more`);
    if (!n.invoices && !n.transfers) return console.log('Nothing to delete.');
    if (!APPLY) return;

    await AppDataSource.transaction(async (m) => {
      // MySQL cannot delete from a table it reads in the same statement's subquery: the uids are read first
      const uids = (await m.query<{ uid: string }[]>(`${TRANSFERS} FOR UPDATE`)).map((r) => String(r.uid));
      if (!ONLY_TEST) await m.query(`DELETE FROM ${TABLES.PO_INVOICES}`);
      if (uids.length) {
        const list = uids.map(() => '?').join(', ');
        if (ONLY_TEST) await m.query(`DELETE FROM ${TABLES.PO_INVOICES} WHERE po_uid IN (${list})`, uids);
        await m.query(`DELETE FROM ${TABLES.SHIPMENT_LOGS} WHERE shipment_uid IN (${list})`, uids);
        await m.query(`DELETE FROM ${TABLES.DETAILS_PURCHASE_ORDERS} WHERE shipmentOrderId IN (${list})`, uids);
        await m.query(`DELETE FROM ${TABLES.MASTER_PURCHASE_ORDERS} WHERE uid IN (${list}) AND transferCode IS NOT NULL`, uids);
      }
    });
    console.log('Deleted.');
  } finally {
    await AppDataSource.destroy();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
