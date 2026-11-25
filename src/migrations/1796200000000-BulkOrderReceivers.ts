import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 2, several receivers per order (2026-11-24, user "go"; constants/bulk-orders.ts
 * BULK_RECEIVERS). A Marketing / Head office order may go to many receivers, each its own SKU lines and (piece 2b) its
 * own Uniware sale order + courier tracking.
 *   NEW table bulk_order_receivers: one row per receiver (receiver 1 = the receiver kept on bulk_orders too, so lists,
 *   search and older code keep working), with its sale order + tracking columns (filled by processing / the sync).
 *   bulk_order_lines + receiver_no (1 for every existing line); the "one SKU once per order" key becomes once per receiver.
 *   bulk_orders + receiver_count (1 for every existing order: lists need no extra query).
 * Every existing order gets its receiver 1 row (copied from bulk_orders, incl. its sale order + tracking). down() drops
 * the new table / columns and puts the old key back (fails only if an order then has one SKU for two receivers).
 */

export class BulkOrderReceivers1796200000000 implements MigrationInterface {
    name = 'BulkOrderReceivers1796200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("CREATE TABLE `bulk_order_receivers` (`id` bigint NOT NULL AUTO_INCREMENT, `order_id` bigint NOT NULL, `receiver_no` int NOT NULL, `receiver_name` varchar(150) NOT NULL, `receiver_phone` varchar(20) NOT NULL, `location_id` bigint NULL, `location_label` varchar(100) NULL, `address_line` varchar(500) NOT NULL, `city` varchar(100) NOT NULL, `state` varchar(100) NOT NULL, `pincode` varchar(10) NOT NULL, `total_units` int NOT NULL DEFAULT 0, `receiver_status` varchar(30) NULL, `customer_code` varchar(100) NULL, `customer_id` bigint NULL, `processed_by` int NULL, `processed_at` datetime(6) NULL, `upload_id` bigint NULL, `po_uid` bigint NULL, `sale_order_code` varchar(30) NULL, `sale_order_count` int NOT NULL DEFAULT 0, `awb` varchar(255) NULL, `courier` varchar(255) NULL, `courier_status` varchar(255) NULL, `tracking_link` varchar(1000) NULL, `dispatched_at` datetime(6) NULL, `delivered_at` datetime(6) NULL, `invoice_code` varchar(255) NULL, `tracking_checked_at` datetime(6) NULL, UNIQUE INDEX `uq_bulk_order_receivers_no` (`order_id`, `receiver_no`), INDEX `idx_bulk_order_receivers_po_uid` (`po_uid`), INDEX `idx_bulk_order_receivers_upload` (`upload_id`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
        await queryRunner.query("ALTER TABLE `bulk_order_lines` ADD `receiver_no` int NOT NULL DEFAULT 1");
        await queryRunner.query("ALTER TABLE `bulk_order_lines` DROP INDEX `uq_bulk_order_lines_sku`, ADD UNIQUE INDEX `uq_bulk_order_lines_sku` (`order_id`, `receiver_no`, `pep_code`)");
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `receiver_count` int NOT NULL DEFAULT 1");
        // receiver 1 of every existing order (drafts too), with what processing / the sync already wrote on the order
        await queryRunner.query(
            "INSERT INTO `bulk_order_receivers` (`order_id`, `receiver_no`, `receiver_name`, `receiver_phone`, `location_id`, `location_label`, `address_line`, `city`, `state`, `pincode`, `total_units`, "
            + "`receiver_status`, `customer_code`, `customer_id`, `processed_by`, `processed_at`, `upload_id`, `po_uid`, `sale_order_code`, `sale_order_count`, "
            + "`awb`, `courier`, `courier_status`, `tracking_link`, `dispatched_at`, `delivered_at`, `invoice_code`, `tracking_checked_at`) "
            + "SELECT `id`, 1, `receiver_name`, `receiver_phone`, `location_id`, `location_label`, `address_line`, `city`, `state`, `pincode`, `total_units`, "
            + "CASE WHEN `status` IN ('processing', 'dispatched', 'delivered') THEN `status` ELSE NULL END, `customer_code`, `customer_id`, `processed_by`, `processed_at`, `upload_id`, `po_uid`, `sale_order_code`, `sale_order_count`, "
            + "`awb`, `courier`, `courier_status`, `tracking_link`, `dispatched_at`, `delivered_at`, `invoice_code`, `tracking_checked_at` FROM `bulk_orders`",
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `receiver_count`");
        await queryRunner.query("ALTER TABLE `bulk_order_lines` DROP INDEX `uq_bulk_order_lines_sku`, ADD UNIQUE INDEX `uq_bulk_order_lines_sku` (`order_id`, `pep_code`)");
        await queryRunner.query("ALTER TABLE `bulk_order_lines` DROP COLUMN `receiver_no`");
        await queryRunner.query("DROP INDEX `idx_bulk_order_receivers_upload` ON `bulk_order_receivers`");
        await queryRunner.query("DROP INDEX `idx_bulk_order_receivers_po_uid` ON `bulk_order_receivers`");
        await queryRunner.query("DROP INDEX `uq_bulk_order_receivers_no` ON `bulk_order_receivers`");
        await queryRunner.query("DROP TABLE `bulk_order_receivers`");
    }

}
