import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Users & Roles page (2026-10-15, user): `roles` (key, label, description, is_system, created_by) seeded with the two
 * built-in roles developer + admin (is_system = 1; their page grants already exist in page_permissions), and on
 * `users`: added_by (who added the person from the Users page) and welcome_error (why the welcome email failed;
 * welcome_sent_at already exists). Generated, plus the hand-added INSERT of the two built-in roles. down() removes
 * exactly this (custom roles' page_permissions rows stay; delete them by hand if ever needed).
 */

export class UsersAndRoles1792069373790 implements MigrationInterface {
    name = 'UsersAndRoles1792069373790'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`roles\` (\`role_key\` varchar(100) NOT NULL, \`label\` varchar(100) NOT NULL, \`description\` varchar(255) NULL, \`is_system\` tinyint NOT NULL DEFAULT 0, \`created_by\` int NULL, \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (\`role_key\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`added_by\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`welcome_error\` varchar(500) NULL`);
        await queryRunner.query(`ALTER TABLE \`users\` ADD CONSTRAINT \`fk_users_added_by\` FOREIGN KEY (\`added_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`roles\` ADD CONSTRAINT \`fk_roles_created_by\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query("INSERT INTO `roles` (`role_key`, `label`, `description`, `is_system`) VALUES ('developer', 'Developer', 'Built-in: full access', 1), ('admin', 'Admin', 'Built-in: full access', 1)");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`roles\` DROP FOREIGN KEY \`fk_roles_created_by\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP FOREIGN KEY \`fk_users_added_by\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`welcome_error\``);
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`added_by\``);
        await queryRunner.query(`DROP TABLE \`roles\``);
    }

}
