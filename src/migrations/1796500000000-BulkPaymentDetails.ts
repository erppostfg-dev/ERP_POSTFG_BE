import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders payment details (2026-11-24, user: "our team sends a Razorpay link generated somewhere, or a QR, or bank
 * details; they send the proof as screenshots"; "we give access to the payment details, we can change this"):
 *   - bulk_orders + payment_bank_details (text our team gives: account / IFSC / UPI ...). The link stays in
 *     payment_link; a QR is a document of kind payment_qr (no column).
 *   - the new special permission bulk-orders:payment-details (add / change payment details) switched ON for the role
 *     bulk-finance (admin / developer always; any other role = Users & Roles > Roles, no code).
 * down() drops the column and the permission rows.
 */

export class BulkPaymentDetails1796500000000 implements MigrationInterface {
    name = 'BulkPaymentDetails1796500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `payment_bank_details` varchar(1000) NULL");
        await queryRunner.query("INSERT IGNORE INTO `page_permissions` (`role`, `page_slug`, `access_level`) VALUES ('bulk-finance', 'bulk-orders:payment-details', 'editor')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `page_permissions` WHERE `page_slug` = 'bulk-orders:payment-details'");
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `payment_bank_details`");
    }

}
