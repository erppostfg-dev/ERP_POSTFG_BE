import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 1c, approval rules (2026-11-23; constants/bulk-orders.ts BULK_APPROVAL).
 *   - bulk_type_settings + approval_over_units (NULL = never by units): Marketing + Head office 100 (the Head office row
 *     is new; payment check off like Marketing), Institutional NULL (never needs approval in v2).
 * Orders already there keep their status (a pending one still waits for its approver). Only a NEW column + rows;
 * down() removes the column and the Head office row it added.
 */

export class BulkApprovalRules1795700000000 implements MigrationInterface {
    name = 'BulkApprovalRules1795700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_type_settings` ADD `approval_over_units` int NULL");
        await queryRunner.query("INSERT INTO `bulk_type_settings` (`order_type`, `payment_check`, `approval_over_units`) VALUES ('marketing', 0, 100), ('head_office', 0, 100) ON DUPLICATE KEY UPDATE `approval_over_units` = VALUES(`approval_over_units`)");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `bulk_type_settings` WHERE `order_type` = 'head_office' AND `payment_check` = 0");
        await queryRunner.query("ALTER TABLE `bulk_type_settings` DROP COLUMN `approval_over_units`");
    }

}
