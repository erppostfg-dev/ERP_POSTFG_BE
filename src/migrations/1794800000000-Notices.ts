import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Notices (2026-11-10, constants/notices.ts): one-way notes in the top-bar bell, kept 2 days.
 *   - notices: one row per notice (to_user_id NULL = everyone), deleted 2 days after created_at;
 *   - notice_seen: one row per person = the newest notice id they have seen.
 * New tables only; down() drops them.
 */

export class Notices1794800000000 implements MigrationInterface {
    name = 'Notices1794800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`notices\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`from_user_id\` int NOT NULL, \`to_user_id\` int NULL, \`text\` varchar(500) NOT NULL, \`link\` varchar(300) NULL, \`reply_to_id\` bigint NULL, \`reply_quote\` varchar(60) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_notices_created\` (\`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`notice_seen\` (\`user_id\` int NOT NULL, \`seen_id\` bigint NOT NULL, \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`user_id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`notice_seen\``);
        await queryRunner.query(`DROP INDEX \`idx_notices_created\` ON \`notices\``);
        await queryRunner.query(`DROP TABLE \`notices\``);
    }

}
