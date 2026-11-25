import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * POs punched in Uniware outside POST_FG (2026-11-25, constants/uniware-outside.ts): new table uniware_outside_orders,
 * one row per (Uniware sale order code, po_uploads row) found by the read-only search. Nothing else changes.
 * down() drops it.
 */

export class UniwareOutsideOrders1796700000000 implements MigrationInterface {
    name = 'UniwareOutsideOrders1796700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`uniware_outside_orders\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`uniware_code\` varchar(100) NOT NULL, \`uniware_channel\` varchar(100) NOT NULL, \`display_order_code\` varchar(255) NOT NULL, \`uniware_status\` varchar(50) NULL, \`uniware_created_at\` datetime NULL, \`upload_id\` bigint NOT NULL, \`kind\` enum ('review', 'rejected', 'processed') NOT NULL, \`state\` enum ('open', 'resolved') NOT NULL DEFAULT 'open', \`resolution\` enum ('reject', 'use_code', 'acknowledge', 'dismiss') NULL, \`remark\` varchar(500) NULL, \`resolved_by\` int NULL, \`resolved_at\` datetime NULL, \`first_seen_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, \`last_seen_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE INDEX \`uq_uniware_outside_code_upload\` (\`uniware_code\`, \`upload_id\`), INDEX \`idx_uniware_outside_upload\` (\`upload_id\`, \`state\`), INDEX \`idx_uniware_outside_state\` (\`state\`, \`kind\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`idx_uniware_outside_state\` ON \`uniware_outside_orders\``);
        await queryRunner.query(`DROP INDEX \`idx_uniware_outside_upload\` ON \`uniware_outside_orders\``);
        await queryRunner.query(`DROP INDEX \`uq_uniware_outside_code_upload\` ON \`uniware_outside_orders\``);
        await queryRunner.query(`DROP TABLE \`uniware_outside_orders\``);
    }

}
