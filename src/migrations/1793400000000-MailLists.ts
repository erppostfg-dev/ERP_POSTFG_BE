import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Mailing lists (2026-10-30, user: an Email section on Users & Roles): mail_list_settings (a mail switched on / off)
 * and mail_recipients (who gets each mail: any address, to / cc / bcc, paused). The mails themselves are listed in
 * code (constants/mail-lists.ts). down() drops both tables.
 */

export class MailLists1793400000000 implements MigrationInterface {
    name = 'MailLists1793400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`mail_list_settings\` (\`list_key\` varchar(64) NOT NULL, \`enabled\` tinyint NOT NULL, \`updated_by\` int NOT NULL, \`updated_at\` datetime NOT NULL, PRIMARY KEY (\`list_key\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`mail_recipients\` (\`id\` int NOT NULL AUTO_INCREMENT, \`list_key\` varchar(64) NOT NULL, \`email\` varchar(254) NOT NULL, \`kind\` enum ('to', 'cc', 'bcc') NOT NULL DEFAULT 'to', \`paused\` tinyint NOT NULL DEFAULT 0, \`created_by\` int NOT NULL, \`created_at\` datetime NOT NULL, \`updated_by\` int NOT NULL, \`updated_at\` datetime NOT NULL, UNIQUE INDEX \`uq_mail_recipients_list_email\` (\`list_key\`, \`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`mail_list_settings\` ADD CONSTRAINT \`fk_mail_list_settings_user\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`mail_recipients\` ADD CONSTRAINT \`fk_mail_recipients_created_by\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`mail_recipients\` ADD CONSTRAINT \`fk_mail_recipients_updated_by\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`mail_recipients\` DROP FOREIGN KEY \`fk_mail_recipients_updated_by\``);
        await queryRunner.query(`ALTER TABLE \`mail_recipients\` DROP FOREIGN KEY \`fk_mail_recipients_created_by\``);
        await queryRunner.query(`ALTER TABLE \`mail_list_settings\` DROP FOREIGN KEY \`fk_mail_list_settings_user\``);
        await queryRunner.query(`DROP INDEX \`uq_mail_recipients_list_email\` ON \`mail_recipients\``);
        await queryRunner.query(`DROP TABLE \`mail_recipients\``);
        await queryRunner.query(`DROP TABLE \`mail_list_settings\``);
    }

}
