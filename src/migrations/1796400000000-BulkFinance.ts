import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 5b, finance (2026-11-24, user "GO": Finance + admin / developer verify payments; PRD
 * "Invoices and payments"):
 *   - payment status as the PRD: unbilled -> invoiced -> payment_submitted -> paid (+ not_needed). Old values renamed:
 *     awaiting_proof / refused -> invoiced when the order has an invoice (not replaced), else unbilled;
 *     proof_uploaded -> payment_submitted; verified -> paid.
 *   - bulk_orders + payment_link (the Razorpay link finance pastes; the buyer sees "Pay now"), payment_link_by / _at.
 *   - NEW fixed role bulk-finance (portal only): Institutional orders viewer + the special permission
 *     bulk-orders:verify-payment (invoices, payment links, verify payments, verify customer GSTINs).
 * down() puts the old status names back (unbilled / invoiced -> awaiting_proof, payment_submitted -> proof_uploaded,
 * paid -> verified), drops the columns and the role.
 */

const HAS_INVOICE = "EXISTS (SELECT 1 FROM `bulk_order_documents` d WHERE d.`order_id` = o.`id` AND d.`kind` = 'invoice' AND d.`replaced_at` IS NULL)";

export class BulkFinance1796400000000 implements MigrationInterface {
    name = 'BulkFinance1796400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `payment_link` varchar(1000) NULL, ADD `payment_link_by` int NULL, ADD `payment_link_at` datetime(6) NULL");
        await queryRunner.query(
            "UPDATE `bulk_orders` o SET o.`payment_status` = CASE"
            + " WHEN o.`payment_status` = 'proof_uploaded' THEN 'payment_submitted'"
            + " WHEN o.`payment_status` = 'verified' THEN 'paid'"
            + ` WHEN ${HAS_INVOICE} THEN 'invoiced' ELSE 'unbilled' END`
            + " WHERE o.`payment_status` IN ('awaiting_proof', 'refused', 'proof_uploaded', 'verified')",
        );
        await queryRunner.query("INSERT INTO `roles` (`role_key`, `label`, `description`, `is_system`) VALUES ('bulk-finance', 'Bulk Orders: Finance', 'Uploads invoices and payment links, verifies payments and customer GSTINs in the Bulk Orders portal only', 0)");
        await queryRunner.query("INSERT INTO `page_permissions` (`role`, `page_slug`, `access_level`) VALUES ('bulk-finance', '/bulk-orders/institutional', 'viewer'), ('bulk-finance', 'bulk-orders:verify-payment', 'editor')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `user_roles` WHERE `role` = 'bulk-finance'");
        await queryRunner.query("DELETE FROM `page_permissions` WHERE `role` = 'bulk-finance'");
        await queryRunner.query("DELETE FROM `roles` WHERE `role_key` = 'bulk-finance'");
        await queryRunner.query(
            "UPDATE `bulk_orders` SET `payment_status` = CASE `payment_status` WHEN 'payment_submitted' THEN 'proof_uploaded' WHEN 'paid' THEN 'verified' ELSE 'awaiting_proof' END"
            + " WHERE `payment_status` IN ('unbilled', 'invoiced', 'payment_submitted', 'paid')",
        );
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `payment_link_at`, DROP COLUMN `payment_link_by`, DROP COLUMN `payment_link`");
    }

}
