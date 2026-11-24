import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 4, courier tracking (2026-11-24; constants/bulk-orders.ts BULK_TRACKING). READ-ONLY on
 * Uniware: the sync fills these from saleorder/get. Only NEW columns; down() drops them.
 */

export class BulkOrderTracking1796000000000 implements MigrationInterface {
    name = 'BulkOrderTracking1796000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `awb` varchar(255) NULL, ADD `courier` varchar(255) NULL, ADD `courier_status` varchar(255) NULL, ADD `tracking_link` varchar(1000) NULL, ADD `dispatched_at` datetime(6) NULL, ADD `delivered_at` datetime(6) NULL, ADD `invoice_code` varchar(255) NULL, ADD `tracking_checked_at` datetime(6) NULL");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `tracking_checked_at`, DROP COLUMN `invoice_code`, DROP COLUMN `delivered_at`, DROP COLUMN `dispatched_at`, DROP COLUMN `tracking_link`, DROP COLUMN `courier_status`, DROP COLUMN `courier`, DROP COLUMN `awb`");
    }

}
