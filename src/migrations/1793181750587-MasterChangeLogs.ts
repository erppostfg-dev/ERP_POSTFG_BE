import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * master_change_logs (2026-10-28, user: log every Masters change so the History button shows who changed what): one
 * new table, nothing else changes. Generated from the entity (MasterChangeLog). down() drops it (its rows go too).
 */

export class MasterChangeLogs1793181750587 implements MigrationInterface {
    name = 'MasterChangeLogs1793181750587'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`master_change_logs\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`master_type\` enum ('pep_sku', 'channel_sku', 'channel', 'location', 'facility') NOT NULL, \`record_id\` bigint NULL, \`row_key\` varchar(255) NOT NULL, \`action\` enum ('created', 'field_changed', 'deactivated', 'activated', 'replaced') NOT NULL, \`source\` enum ('screen', 'script') NOT NULL, \`field_name\` varchar(100) NULL, \`old_value\` text NULL, \`new_value\` text NULL, \`remark\` text NULL, \`batch_id\` char(36) NOT NULL, \`user_id\` int NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_master_change_logs_created\` (\`created_at\`), INDEX \`idx_master_change_logs_row\` (\`master_type\`, \`record_id\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`master_change_logs\` ADD CONSTRAINT \`fk_master_change_logs_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_change_logs\` DROP FOREIGN KEY \`fk_master_change_logs_user\``);
        await queryRunner.query(`DROP INDEX \`idx_master_change_logs_row\` ON \`master_change_logs\``);
        await queryRunner.query(`DROP INDEX \`idx_master_change_logs_created\` ON \`master_change_logs\``);
        await queryRunner.query(`DROP TABLE \`master_change_logs\``);
    }

}
