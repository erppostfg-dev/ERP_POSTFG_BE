import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Channel pulls (2026-10-30, user: Flipkart scheduled consignments by our Seller Hub robot): 1 new table, nothing else
 * changes. channel_pull_items = one row per fetched consignment (status, warehouse, created date, the fetched row + CSV),
 * taken_at when it became a PO. down() drops it (rows go too; the robot fetches the consignments again).
 */

export class ChannelPullItems1793300000000 implements MigrationInterface {
    name = 'ChannelPullItems1793300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`channel_pull_items\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`source_system\` varchar(50) NOT NULL, \`external_id\` varchar(100) NOT NULL, \`status\` varchar(80) NULL, \`warehouse\` varchar(100) NULL, \`created_on\` date NULL, \`label\` varchar(300) NOT NULL DEFAULT '', \`data\` json NOT NULL, \`fetched_at\` datetime(6) NOT NULL, \`taken_at\` datetime(6) NULL, INDEX \`idx_channel_pull_items_fetched\` (\`source_system\`, \`fetched_at\`), UNIQUE INDEX \`uq_channel_pull_items_external\` (\`source_system\`, \`external_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`channel_pull_items\``);
    }

}
