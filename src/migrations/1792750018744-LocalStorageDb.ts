import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * intake_emails + app_state only (2026-10-23). The generator also listed DROP / ADD of intransit_* and final_pep_code
 * columns on master_skus / master_facilities / details_channels: those were added to the shared dev DB by other code
 * (not ours) and are left alone on purpose.
 */
export class LocalStorageDb1792750018744 implements MigrationInterface {
    name = 'LocalStorageDb1792750018744'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`intake_emails\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`message_key\` char(16) NOT NULL, \`message_id\` text NOT NULL, \`provider\` varchar(30) NULL, \`group_name\` varchar(100) NOT NULL, \`kind\` enum ('po', 'not_po') NOT NULL, \`channel\` varchar(50) NULL, \`from_address\` varchar(320) NULL, \`subject\` text NULL, \`received_at\` datetime NULL, \`stored_at\` datetime NOT NULL, \`folder_name\` varchar(200) NOT NULL, \`s3_folder\` varchar(500) NULL, \`files\` json NULL, \`not_po_code\` varchar(50) NULL, \`not_po_reason\` varchar(500) NULL, \`local_removed_at\` datetime NULL, \`updated_at\` datetime NOT NULL, INDEX \`idx_intake_emails_group_kind\` (\`group_name\`, \`kind\`), UNIQUE INDEX \`uq_intake_emails_message_key\` (\`message_key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`app_state\` (\`state_key\` varchar(100) NOT NULL, \`value\` json NOT NULL, \`updated_at\` datetime NOT NULL, PRIMARY KEY (\`state_key\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`app_state\``);
        await queryRunner.query(`DROP INDEX \`uq_intake_emails_message_key\` ON \`intake_emails\``);
        await queryRunner.query(`DROP INDEX \`idx_intake_emails_group_kind\` ON \`intake_emails\``);
        await queryRunner.query(`DROP TABLE \`intake_emails\``);
    }

}
