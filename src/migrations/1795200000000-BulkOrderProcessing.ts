import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders step 3b (2026-11-12, user; constants/bulk-orders.ts BULK_SALE / BULK_INSTITUTION):
 *   - bulk_orders + Institutional requester details (institution_name, gstin, contact_email, billing_*) and our team's
 *     sale order (facility_code, uniware_channel, customer_code, customer_id, processed_by / _at, upload_id, po_uid,
 *     sale_order_code, sale_order_count).
 *   - bulk_customers: the customer book (institution + Uniware channel / customer code), suggested on later orders.
 *   - po_uploads.source + 'bulk' (a processed bulk order in the Processed tab).
 *   - master_channels + 'Bulk Institutional' (9101) / 'Bulk Marketing' (9102), OFF: the saved PO's channel (FK). A masters
 *     file replace must keep them (PROD_CHECKLIST).
 * Only NEW columns / tables / enum value; down() removes them (down fails while po_uploads has 'bulk' rows: on purpose).
 */

export class BulkOrderProcessing1795200000000 implements MigrationInterface {
    name = 'BulkOrderProcessing1795200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`bulk_orders\` ADD \`institution_name\` varchar(200) NULL, ADD \`gstin\` varchar(15) NULL, ADD \`contact_email\` varchar(150) NULL, ADD \`billing_address_line\` varchar(500) NULL, ADD \`billing_city\` varchar(100) NULL, ADD \`billing_state\` varchar(100) NULL, ADD \`billing_pincode\` varchar(10) NULL, ADD \`facility_code\` varchar(100) NULL, ADD \`uniware_channel\` varchar(100) NULL, ADD \`customer_code\` varchar(100) NULL, ADD \`customer_id\` bigint NULL, ADD \`processed_by\` int NULL, ADD \`processed_at\` datetime(6) NULL, ADD \`upload_id\` bigint NULL, ADD \`po_uid\` bigint NULL, ADD \`sale_order_code\` varchar(30) NULL, ADD \`sale_order_count\` int NOT NULL DEFAULT '0'`);
        await queryRunner.query(`CREATE TABLE \`bulk_customers\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`name\` varchar(200) NOT NULL, \`gstin\` varchar(15) NULL, \`address_line\` varchar(500) NOT NULL, \`city\` varchar(100) NOT NULL, \`state\` varchar(100) NOT NULL, \`pincode\` varchar(10) NOT NULL, \`phone\` varchar(20) NULL, \`email\` varchar(150) NULL, \`uniware_channel\` varchar(100) NOT NULL, \`customer_code\` varchar(100) NOT NULL, \`used_count\` int NOT NULL DEFAULT '0', \`last_order_id\` bigint NULL, \`created_by\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_by\` int NULL, \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_bulk_customers_gstin\` (\`gstin\`), INDEX \`idx_bulk_customers_pincode\` (\`pincode\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query("ALTER TABLE `po_uploads` MODIFY `source` enum('email','manual','api','bulk') NOT NULL");
        // master_purchase_orders.channel must be a master_channels.display_name (fk_master_po_channel): one row per bulk
        // type, switched OFF (no channel list / intake / Verify switch shows it), fixed ids out of the masters' range.
        await queryRunner.query("INSERT INTO `master_channels` (`id`, `slug`, `display_name`, `db_aliases`, `has_processor`, `is_active`, `channel_type`) VALUES (9101, 'bulk-institutional', 'Bulk Institutional', JSON_ARRAY('Bulk Institutional'), 0, 0, 'B2B'), (9102, 'bulk-marketing', 'Bulk Marketing', JSON_ARRAY('Bulk Marketing'), 0, 0, 'B2B')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `master_channels` WHERE `id` IN (9101, 9102)");
        await queryRunner.query("ALTER TABLE `po_uploads` MODIFY `source` enum('email','manual','api') NOT NULL");
        await queryRunner.query(`DROP INDEX \`idx_bulk_customers_pincode\` ON \`bulk_customers\``);
        await queryRunner.query(`DROP INDEX \`idx_bulk_customers_gstin\` ON \`bulk_customers\``);
        await queryRunner.query(`DROP TABLE \`bulk_customers\``);
        await queryRunner.query(`ALTER TABLE \`bulk_orders\` DROP COLUMN \`sale_order_count\`, DROP COLUMN \`sale_order_code\`, DROP COLUMN \`po_uid\`, DROP COLUMN \`upload_id\`, DROP COLUMN \`processed_at\`, DROP COLUMN \`processed_by\`, DROP COLUMN \`customer_id\`, DROP COLUMN \`customer_code\`, DROP COLUMN \`uniware_channel\`, DROP COLUMN \`facility_code\`, DROP COLUMN \`billing_pincode\`, DROP COLUMN \`billing_state\`, DROP COLUMN \`billing_city\`, DROP COLUMN \`billing_address_line\`, DROP COLUMN \`contact_email\`, DROP COLUMN \`gstin\`, DROP COLUMN \`institution_name\``);
    }

}
