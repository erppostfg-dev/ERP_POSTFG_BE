import { MigrationInterface, QueryRunner } from "typeorm";

export class PoVerifyChannelSettings1792650000999 implements MigrationInterface {
    name = 'PoVerifyChannelSettings1792650000999'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`po_verify_channel_settings\` (\`id\` int NOT NULL AUTO_INCREMENT, \`channel\` varchar(100) NOT NULL, \`required\` tinyint NOT NULL, \`updated_by\` int NOT NULL, \`updated_at\` datetime NOT NULL, UNIQUE INDEX \`uq_po_verify_channel_settings_channel\` (\`channel\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`po_verify_channel_settings\` ADD CONSTRAINT \`fk_po_verify_channel_settings_user\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_verify_channel_settings\` DROP FOREIGN KEY \`fk_po_verify_channel_settings_user\``);
        await queryRunner.query(`DROP INDEX \`uq_po_verify_channel_settings_channel\` ON \`po_verify_channel_settings\``);
        await queryRunner.query(`DROP TABLE \`po_verify_channel_settings\``);
    }

}
