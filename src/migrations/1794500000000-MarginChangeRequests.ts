import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Two-layer approval of margin changes (2026-11-06, user: layer 1 Operations Manager, layer 2 Admin; edits and new
 * channel SKU rows): one new table margin_change_requests (the change waiting, who asked, layer 1 / layer 2 decisions,
 * rejection). Nothing else changes. Generated from the entity by the schema check (test/meta/schema.test.ts). down()
 * drops it (its rows go too).
 */

export class MarginChangeRequests1794500000000 implements MigrationInterface {
    name = 'MarginChangeRequests1794500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`margin_change_requests\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`kind\` enum ('edit', 'add') NOT NULL, \`source\` enum ('masters', 'price_check') NOT NULL, \`status\` enum ('pending_l1', 'pending_l2', 'applied', 'rejected') NOT NULL DEFAULT 'pending_l1', \`channel_sku_id\` bigint NULL, \`channel_id\` int NOT NULL, \`channel_name\` varchar(100) NOT NULL, \`channel_code\` varchar(100) NOT NULL, \`pep_code\` varchar(100) NOT NULL, \`old_margin\` decimal(10,4) NULL, \`new_margin\` decimal(10,4) NULL, \`old_rate\` decimal(10,2) NULL, \`new_rate\` decimal(10,2) NULL, \`payload\` json NULL, \`remark\` varchar(500) NULL, \`requested_by\` int NOT NULL, \`requested_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`l1_by\` int NULL, \`l1_at\` datetime(6) NULL, \`l1_remark\` varchar(500) NULL, \`l2_by\` int NULL, \`l2_at\` datetime(6) NULL, \`l2_remark\` varchar(500) NULL, \`rejected_by\` int NULL, \`rejected_at\` datetime(6) NULL, \`reject_reason\` varchar(500) NULL, INDEX \`idx_margin_requests_sku\` (\`channel_sku_id\`, \`status\`), INDEX \`idx_margin_requests_status\` (\`status\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`margin_change_requests\` ADD CONSTRAINT \`fk_margin_requests_requested_by\` FOREIGN KEY (\`requested_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`margin_change_requests\` DROP FOREIGN KEY \`fk_margin_requests_requested_by\``);
        await queryRunner.query(`DROP TABLE \`margin_change_requests\``);
    }

}
