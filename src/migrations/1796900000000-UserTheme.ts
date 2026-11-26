import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Light / dark mode per person (2026-11-26, user: "store which user uses dark and normal"): users.theme = 'light' |
 * 'dark', NULL = light (everyone today). Saved by the person (PUT /auth/me/preferences), sent in GET /auth/me so the
 * app opens in their mode on any device, shown to admins in Users & Roles > Users. down() drops the column.
 */

export class UserTheme1796900000000 implements MigrationInterface {
    name = 'UserTheme1796900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `users` ADD `theme` varchar(10) NULL");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `users` DROP COLUMN `theme`");
    }

}
