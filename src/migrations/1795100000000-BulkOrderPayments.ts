import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders: payment check + documents (2026-11-12, user; constants/bulk-orders.ts BULK_PAYMENT_STATUS / BULK_DOC_KIND).
 *   - bulk_orders + payment_status / payment_by / payment_at / payment_note (NULL = no payment check on the order).
 *   - bulk_order_documents: proforma / invoice / proof of payment files (S3), never deleted (replaced_at).
 *   - bulk_type_settings: per order type, payment_check ON / OFF (admin). Seeded: Institutional ON, Marketing OFF.
 *   - Open Institutional orders already there (pending / approved) get awaiting_proof.
 * Only NEW columns / tables; down() removes them.
 */

export class BulkOrderPayments1795100000000 implements MigrationInterface {
    name = 'BulkOrderPayments1795100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`bulk_orders\` ADD \`payment_status\` varchar(20) NULL, ADD \`payment_by\` int NULL, ADD \`payment_at\` datetime(6) NULL, ADD \`payment_note\` varchar(1000) NULL`);
        await queryRunner.query(`CREATE TABLE \`bulk_order_documents\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`order_id\` bigint NOT NULL, \`kind\` varchar(30) NOT NULL, \`file_name\` varchar(255) NOT NULL, \`content_type\` varchar(100) NOT NULL, \`size_bytes\` int NOT NULL, \`s3_url\` varchar(1000) NOT NULL, \`uploaded_by\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`replaced_at\` datetime(6) NULL, INDEX \`idx_bulk_order_documents_order\` (\`order_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`bulk_type_settings\` (\`order_type\` varchar(20) NOT NULL, \`payment_check\` tinyint NOT NULL DEFAULT 0, \`updated_by\` int NULL, \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`order_type\`)) ENGINE=InnoDB`);
        await queryRunner.query("INSERT INTO `bulk_type_settings` (`order_type`, `payment_check`) VALUES ('institutional', 1), ('marketing', 0)");
        await queryRunner.query("UPDATE `bulk_orders` SET `payment_status` = 'awaiting_proof' WHERE `order_type` = 'institutional' AND `status` IN ('pending_approval', 'approved')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`bulk_type_settings\``);
        await queryRunner.query(`DROP INDEX \`idx_bulk_order_documents_order\` ON \`bulk_order_documents\``);
        await queryRunner.query(`DROP TABLE \`bulk_order_documents\``);
        await queryRunner.query(`ALTER TABLE \`bulk_orders\` DROP COLUMN \`payment_note\`, DROP COLUMN \`payment_at\`, DROP COLUMN \`payment_by\`, DROP COLUMN \`payment_status\``);
    }

}
