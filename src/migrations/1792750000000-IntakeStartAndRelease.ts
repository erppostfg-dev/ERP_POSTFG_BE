import { MigrationInterface, QueryRunner } from "typeorm";

/** After IntakeControl (2026-10-23): "process from" per channel + when a held PO was let go (counts against that day's limit). */
export class IntakeStartAndRelease1792750000000 implements MigrationInterface {
    name = 'IntakeStartAndRelease1792750000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`channel_intake_settings\` ADD \`process_from\` datetime NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`released_at\` datetime NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`released_at\``);
        await queryRunner.query(`ALTER TABLE \`channel_intake_settings\` DROP COLUMN \`process_from\``);
    }

}
