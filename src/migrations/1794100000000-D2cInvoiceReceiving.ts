import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Receiving facility of an inward PO on its invoice (2026-11-03; D2C internal transfers phase 7 follow-up):
 *   - po_invoices.receiving_facility_code varchar(100) NULL: the facility code the inward PO was requested at, written
 *     at reserve time and read by the reconcile, the GRN sync and a retry of the same code (a later Masters change of
 *     the location's receiving facility never sends us to another facility).
 *   - backfill: rows that already have an inward_po_requested shipment_logs row get the code from that row's remark
 *     ("receiving=<code> | ..."), the latest row of the invoice's transfer + inward PO code.
 * No index: the column is only read for one invoice at a time (by id). The log-based value stays as the fallback in
 * code while the column is NULL.
 * down() drops the column (the log remarks still hold every value).
 */

export class D2cInvoiceReceiving1794100000000 implements MigrationInterface {
    name = 'D2cInvoiceReceiving1794100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_invoices\` ADD \`receiving_facility_code\` varchar(100) NULL`);
        await queryRunner.query(`UPDATE \`po_invoices\` i
            JOIN \`shipment_logs\` l ON l.id = (
                SELECT MAX(x.id) FROM \`shipment_logs\` x
                WHERE x.shipment_uid = i.po_uid AND x.action = 'inward_po_requested' AND x.new_value = i.inward_po_code
            )
            SET i.receiving_facility_code = NULLIF(TRIM(SUBSTRING_INDEX(SUBSTRING(l.remark, 11), ' | ', 1)), '')
            WHERE i.inward_po_code IS NOT NULL AND i.receiving_facility_code IS NULL AND l.remark LIKE 'receiving=%'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_invoices\` DROP COLUMN \`receiving_facility_code\``);
    }

}
