import { MigrationInterface, QueryRunner } from "typeorm";

export class IntakeControl1792740124981 implements MigrationInterface {
    name = 'IntakeControl1792740124981'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`channel_intake_settings\` (\`id\` int NOT NULL AUTO_INCREMENT, \`channel\` varchar(50) NOT NULL, \`enabled\` tinyint NOT NULL DEFAULT 0, \`daily_limit\` int NULL, \`updated_by\` int NOT NULL, \`updated_at\` datetime NOT NULL, UNIQUE INDEX \`uq_channel_intake_settings_channel\` (\`channel\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`DROP INDEX \`idx_po_uploads_status\` ON \`po_uploads\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` CHANGE \`status\` \`status\` enum ('queued', 'extracting', 'needs_review', 'pending_approval', 'processing', 'completed', 'rejected', 'failed', 'held') NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`CREATE INDEX \`idx_po_uploads_status\` ON \`po_uploads\` (\`status\`, \`created_at\`)`);
        await queryRunner.query(`ALTER TABLE \`channel_intake_settings\` ADD CONSTRAINT \`fk_channel_intake_settings_user\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`channel_intake_settings\` DROP FOREIGN KEY \`fk_channel_intake_settings_user\``);
        await queryRunner.query(`DROP INDEX \`idx_po_uploads_status\` ON \`po_uploads\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` CHANGE \`status\` \`status\` enum ('queued', 'extracting', 'needs_review', 'pending_approval', 'processing', 'completed', 'rejected', 'failed') NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`CREATE INDEX \`idx_po_uploads_status\` ON \`po_uploads\` (\`status\`, \`created_at\`)`);
        await queryRunner.query(`DROP INDEX \`uq_channel_intake_settings_channel\` ON \`channel_intake_settings\``);
        await queryRunner.query(`DROP TABLE \`channel_intake_settings\``);
    }

}
