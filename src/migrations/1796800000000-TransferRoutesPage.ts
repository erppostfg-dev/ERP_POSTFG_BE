import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Transfer Routes gets its own page key /masters/transfer-routes (2026-11-26, user: "add transfer routes to the Roles
 * section; who has access to Masters, show it to them only"). It used the Warehouses page's access until now.
 * Starting level = each role's / each person's MASTERS level (the page's parent): one row per role that has a /masters
 * row (page_permissions) and per person with their own /masters override (user_page_permissions), so the Roles screen
 * shows the real value and nobody gains or loses access on the day. Roles / people without a /masters row keep falling
 * back to /masters by the usual parent rule. Admin / developer have full access anyway. Nothing else changes.
 * down() removes the page's rows (the code of the previous version reads Warehouses' access again).
 */

export class TransferRoutesPage1796800000000 implements MigrationInterface {
    name = 'TransferRoutesPage1796800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("INSERT IGNORE INTO `page_permissions` (`role`, `page_slug`, `access_level`) SELECT `role`, '/masters/transfer-routes', `access_level` FROM `page_permissions` WHERE `page_slug` = '/masters'");
        await queryRunner.query("INSERT IGNORE INTO `user_page_permissions` (`user_id`, `page_slug`, `access_level`) SELECT `user_id`, '/masters/transfer-routes', `access_level` FROM `user_page_permissions` WHERE `page_slug` = '/masters'");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `user_page_permissions` WHERE `page_slug` = '/masters/transfer-routes'");
        await queryRunner.query("DELETE FROM `page_permissions` WHERE `page_slug` = '/masters/transfer-routes'");
    }

}
