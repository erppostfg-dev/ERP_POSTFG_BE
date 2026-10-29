import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Gmail intake load (2026-10-29, user; backlog B1, constants/gmail-intake.ts): 2 new tables, nothing else changes.
 *   gmail_messages   each Po-Intake email's channel once read (a catch-up then needs no Gmail call for it)
 *   intake_catchups  one row per email channel: its catch-up, retried by itself when it fails
 * down() drops them (rows go too; the next catch-up reads Gmail again).
 */

export class GmailIntake1793290000000 implements MigrationInterface {
    name = 'GmailIntake1793290000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`gmail_messages\` (\`gmail_id\` varchar(32) NOT NULL, \`channel\` varchar(40) NULL, \`subject\` varchar(300) NOT NULL DEFAULT '', \`received_at\` datetime(6) NULL, \`done_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_gmail_messages_channel\` (\`channel\`, \`done_at\`, \`received_at\`), PRIMARY KEY (\`gmail_id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`intake_catchups\` (\`channel\` varchar(40) NOT NULL, \`from_at\` datetime(6) NOT NULL, \`status\` enum ('waiting', 'running', 'done', 'failed') NOT NULL DEFAULT 'waiting', \`attempts\` int NOT NULL DEFAULT '0', \`next_try_at\` datetime(6) NULL, \`last_error\` varchar(500) NULL, \`found\` int NULL, \`sent\` int NULL, \`requested_at\` datetime(6) NOT NULL, \`finished_at\` datetime(6) NULL, PRIMARY KEY (\`channel\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`intake_catchups\``);
        await queryRunner.query(`DROP TABLE \`gmail_messages\``);
    }

}
