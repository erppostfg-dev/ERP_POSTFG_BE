import { MigrationInterface, QueryRunner } from "typeorm";

export class PoVerifications1792647955762 implements MigrationInterface {
    name = 'PoVerifications1792647955762'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`po_verifications\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`upload_id\` bigint NOT NULL, \`po_uid\` bigint NULL, \`sale_order_code\` varchar(50) NULL, \`action\` enum ('verified', 'sent_back') NOT NULL, \`remark\` varchar(500) NULL, \`lines_checked\` int NULL, \`line_count\` int NULL, \`done_by\` int NOT NULL, \`done_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX \`idx_po_verifications_po\` (\`po_uid\`, \`action\`), INDEX \`idx_po_verifications_upload\` (\`upload_id\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`po_verifications\` ADD CONSTRAINT \`fk_po_verifications_upload\` FOREIGN KEY (\`upload_id\`) REFERENCES \`po_uploads\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`po_verifications\` ADD CONSTRAINT \`fk_po_verifications_user\` FOREIGN KEY (\`done_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_verifications\` DROP FOREIGN KEY \`fk_po_verifications_user\``);
        await queryRunner.query(`ALTER TABLE \`po_verifications\` DROP FOREIGN KEY \`fk_po_verifications_upload\``);
        await queryRunner.query(`DROP INDEX \`idx_po_verifications_upload\` ON \`po_verifications\``);
        await queryRunner.query(`DROP INDEX \`idx_po_verifications_po\` ON \`po_verifications\``);
        await queryRunner.query(`DROP TABLE \`po_verifications\``);
    }

}
