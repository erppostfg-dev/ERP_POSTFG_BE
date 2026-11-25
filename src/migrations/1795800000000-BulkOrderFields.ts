import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 1d, order form fields (2026-11-23; constants/bulk-orders.ts BULK_PRIORITIES / BULK_DELIVERY_MODES).
 *   - bulk_orders.needed_by may be NULL (optional for a Normal order).
 *   - bulk_orders + fast_track_remarks (required for Fast-track) + purpose (Marketing, optional).
 *   - Old values renamed to the v2 words: priority Standard -> Normal; delivery mode Courier / Self pickup -> Regular.
 * down() puts the old words back (Normal -> Standard, Regular -> Courier), drops the 2 columns, and makes needed_by NOT NULL
 * again (orders without a date get today's date first).
 */

export class BulkOrderFields1795800000000 implements MigrationInterface {
    name = 'BulkOrderFields1795800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` MODIFY `needed_by` date NULL, ADD `fast_track_remarks` varchar(500) NULL, ADD `purpose` varchar(200) NULL");
        await queryRunner.query("UPDATE `bulk_orders` SET `priority` = 'Normal' WHERE `priority` = 'Standard'");
        await queryRunner.query("UPDATE `bulk_orders` SET `delivery_mode` = 'Regular' WHERE `delivery_mode` IN ('Courier', 'Self pickup')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("UPDATE `bulk_orders` SET `delivery_mode` = 'Courier' WHERE `delivery_mode` = 'Regular'");
        await queryRunner.query("UPDATE `bulk_orders` SET `priority` = 'Standard' WHERE `priority` = 'Normal'");
        await queryRunner.query("UPDATE `bulk_orders` SET `needed_by` = CURRENT_DATE WHERE `needed_by` IS NULL");
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `purpose`, DROP COLUMN `fast_track_remarks`, MODIFY `needed_by` date NOT NULL");
    }

}
