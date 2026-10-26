import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Channel API connectors (2026-10-16, user: Amazon SP-API now, Flipkart and others later, all through the same chain):
 *   channel_api_sync: one row per connector, its check point (synced_until), last run / success, failures, last error
 *                     and result (incl. the ids to retry).
 *   po_uploads + source_system (e.g. amazon_spapi) + external_id (the channel's id, Amazon: the FBA shipment id),
 *                     unique together, so a channel PO is never taken twice. Both NULL for every email / manual row
 *                     (MySQL allows many NULLs in a unique index), so nothing existing changes.
 * Generated; down() removes exactly this.
 */

export class ChannelApi1792137169820 implements MigrationInterface {
    name = 'ChannelApi1792137169820'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`channel_api_sync\` (\`connector\` varchar(50) NOT NULL, \`synced_until\` datetime NULL, \`last_run_at\` datetime NULL, \`last_success_at\` datetime NULL, \`failures\` int NOT NULL DEFAULT '0', \`last_error\` varchar(500) NULL, \`last_result\` json NULL, \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (\`connector\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`source_system\` varchar(50) NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`external_id\` varchar(100) NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX \`uq_po_uploads_source_external\` ON \`po_uploads\` (\`source_system\`, \`external_id\`)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`uq_po_uploads_source_external\` ON \`po_uploads\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`external_id\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`source_system\``);
        await queryRunner.query(`DROP TABLE \`channel_api_sync\``);
    }

}
