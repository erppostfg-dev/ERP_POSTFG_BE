import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders step 2 (2026-11-11, constants/bulk-orders.ts BULK_EVENT): bulk_order_events = the timeline of an order
 * (created, edited, cancelled, approved with each line change old -> new, rejected). NEW table only; down() drops it.
 * Orders created before this migration simply have no "created" row.
 */

export class BulkOrderEvents1795000000000 implements MigrationInterface {
    name = 'BulkOrderEvents1795000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`bulk_order_events\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`order_id\` bigint NOT NULL, \`action\` varchar(20) NOT NULL, \`by_user_id\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`note\` varchar(1000) NULL, \`changes\` json NULL, INDEX \`idx_bulk_order_events_order\` (\`order_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX \`idx_bulk_order_events_order\` ON \`bulk_order_events\``);
        await queryRunner.query(`DROP TABLE \`bulk_order_events\``);
    }

}
