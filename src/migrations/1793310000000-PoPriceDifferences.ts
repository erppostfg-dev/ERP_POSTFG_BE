import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Price check in PO review (2026-10-30, user): 1 new table, nothing else changes. po_price_differences = one row per
 * approved PO line where the reviewer kept our price / MRP although the PO said otherwise; the Price differences tab
 * lists them (per PO / channel, email draft) and marks them sent. down() drops it (the list is lost; the POs are not).
 */

export class PoPriceDifferences1793310000000 implements MigrationInterface {
    name = 'PoPriceDifferences1793310000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`po_price_differences\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`upload_id\` bigint NOT NULL, \`submission_id\` bigint NULL, \`po_uid\` bigint NULL, \`po_number\` varchar(100) NOT NULL, \`po_date\` date NULL, \`channel\` varchar(100) NOT NULL, \`line_no\` varchar(20) NOT NULL, \`channel_sku_code\` varchar(100) NOT NULL DEFAULT '', \`pep_code\` varchar(100) NOT NULL DEFAULT '', \`product_name\` varchar(255) NOT NULL DEFAULT '', \`field\` enum ('price', 'mrp') NOT NULL, \`qty\` decimal(12,2) NULL, \`po_value\` decimal(12,2) NOT NULL, \`our_value\` decimal(12,2) NOT NULL, \`difference\` decimal(12,2) NOT NULL, \`reviewed_by\` int NULL, \`approved_by\` int NULL, \`approved_at\` datetime NOT NULL, \`sent_at\` datetime NULL, \`sent_by\` int NULL, \`sent_batch\` varchar(40) NULL, INDEX \`idx_po_price_differences_channel\` (\`channel\`, \`sent_at\`, \`approved_at\`), INDEX \`idx_po_price_differences_upload\` (\`upload_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`po_price_differences\``);
    }

}