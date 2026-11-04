import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Reopen a rejected PO (2026-11-03, user): 1 new table, nothing else changes. po_reopens = one row per rejected PO sent
 * back to In Review (who, when, why, and the rejection it undid). down() drops it (the POs themselves are not touched).
 */

export class PoReopens1793600000000 implements MigrationInterface {
    name = 'PoReopens1793600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`po_reopens\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`upload_id\` bigint NOT NULL, \`remark\` varchar(500) NOT NULL, \`reopened_by\` int NOT NULL, \`reopened_at\` datetime NOT NULL, \`rejected_reason\` varchar(500) NULL, \`rejected_from\` varchar(20) NULL, \`rejected_by\` int NULL, \`rejected_at\` datetime NULL, \`rejected_submission_id\` bigint NULL, INDEX \`idx_po_reopens_upload\` (\`upload_id\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`po_reopens\``);
    }

}
