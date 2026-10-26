import { MigrationInterface, QueryRunner } from "typeorm";

export class ManualUploads1792652593242 implements MigrationInterface {
    name = 'ManualUploads1792652593242'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`manual_uploads\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`channel\` varchar(50) NOT NULL, \`external_id\` varchar(64) NULL, \`files\` json NOT NULL, \`folder\` varchar(500) NOT NULL, \`s3_folder\` varchar(500) NULL, \`status\` enum ('uploaded', 'queued', 'processing', 'done', 'failed', 'cancelled') NOT NULL DEFAULT 'uploaded', \`note\` varchar(500) NULL, \`uploaded_by\` int NOT NULL, \`uploaded_at\` datetime NOT NULL, \`process_by\` int NULL, \`process_at\` datetime NULL, \`finished_at\` datetime NULL, INDEX \`idx_manual_uploads_status\` (\`status\`, \`id\`), INDEX \`idx_manual_uploads_external\` (\`channel\`, \`external_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`manual_uploads\` ADD CONSTRAINT \`fk_manual_uploads_uploaded_by\` FOREIGN KEY (\`uploaded_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`manual_uploads\` ADD CONSTRAINT \`fk_manual_uploads_process_by\` FOREIGN KEY (\`process_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`manual_uploads\` DROP FOREIGN KEY \`fk_manual_uploads_process_by\``);
        await queryRunner.query(`ALTER TABLE \`manual_uploads\` DROP FOREIGN KEY \`fk_manual_uploads_uploaded_by\``);
        await queryRunner.query(`DROP INDEX \`idx_manual_uploads_external\` ON \`manual_uploads\``);
        await queryRunner.query(`DROP INDEX \`idx_manual_uploads_status\` ON \`manual_uploads\``);
        await queryRunner.query(`DROP TABLE \`manual_uploads\``);
    }

}
