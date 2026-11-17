import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * PEPIMS + dev -> prod migration, step 1 (2026-11-16, user; constants/po-group.ts):
 *   - master_purchase_orders.poGroup (Channel / D2C / Marketing / Institutional / Internal Transfer / Others, NOT NULL,
 *     default Channel) + partyName (the buyer's own name when the channel is only a bucket) + importedFrom ('pepims' =
 *     imported, PO Overview shows it) + their indexes. Existing rows get their group from the channel (as poGroupOf).
 *   - pepims_sync_links / pepims_sync_line_links: our PO / line <-> PEPIMS's, with the values of the last sync.
 *   - master_channels + 'Others' (9103), OFF: the channel of group Others (FK). A masters file replace must keep it.
 * Only NEW columns / tables / one channel row; down() removes them (fails while a PO uses channel Others: on purpose).
 */

export class PepimsMigration1795500000000 implements MigrationInterface {
    name = 'PepimsMigration1795500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `master_purchase_orders` ADD `poGroup` enum ('Channel', 'D2C', 'Marketing', 'Institutional', 'Internal Transfer', 'Others') NOT NULL DEFAULT 'Channel', ADD `partyName` varchar(255) NULL, ADD `importedFrom` varchar(20) NULL");
        await queryRunner.query("CREATE INDEX `idx_master_po_group` ON `master_purchase_orders` (`poGroup`)");
        await queryRunner.query("CREATE INDEX `idx_master_po_imported_from` ON `master_purchase_orders` (`importedFrom`)");
        // the rows that exist: group from the channel (constants/po-group.ts; names compared as MySQL does, case-insensitive)
        await queryRunner.query("UPDATE `master_purchase_orders` SET `poGroup` = CASE TRIM(`channel`) WHEN 'Bulk Marketing' THEN 'Marketing' WHEN 'Bulk Institutional' THEN 'Institutional' WHEN 'Others' THEN 'Others' WHEN 'McaffeineB2C' THEN 'D2C' WHEN 'HYP_Website' THEN 'D2C' WHEN 'GGN_WAREHOUSE' THEN 'Internal Transfer' WHEN 'MUM_WAREHOUSE2' THEN 'Internal Transfer' WHEN 'KOL_WAREHOUSE' THEN 'Internal Transfer' ELSE 'Channel' END");
        await queryRunner.query("CREATE TABLE `pepims_sync_links` (`id` bigint NOT NULL AUTO_INCREMENT, `po_uid` bigint NOT NULL, `pepims_uid` int NOT NULL, `synced_values` json NULL, `pepims_updated_at` datetime NULL, `synced_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_pepims_sync_links_po` (`po_uid`), UNIQUE INDEX `uq_pepims_sync_links_pepims` (`pepims_uid`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
        await queryRunner.query("CREATE TABLE `pepims_sync_line_links` (`id` bigint NOT NULL AUTO_INCREMENT, `line_id` bigint NOT NULL, `pepims_line_id` int NOT NULL, `po_uid` bigint NOT NULL, `synced_values` json NULL, `synced_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_pepims_sync_line_links_line` (`line_id`), UNIQUE INDEX `uq_pepims_sync_line_links_pepims` (`pepims_line_id`), INDEX `idx_pepims_sync_line_links_po` (`po_uid`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
        await queryRunner.query("ALTER TABLE `pepims_sync_links` ADD CONSTRAINT `fk_pepims_sync_links_po` FOREIGN KEY (`po_uid`) REFERENCES `master_purchase_orders`(`uid`) ON DELETE RESTRICT ON UPDATE CASCADE");
        await queryRunner.query("ALTER TABLE `pepims_sync_line_links` ADD CONSTRAINT `fk_pepims_sync_line_links_line` FOREIGN KEY (`line_id`) REFERENCES `details_purchase_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE");
        // the channel of group Others: OFF (no channel list / intake / Verify switch shows it), id next to the bulk ones
        await queryRunner.query("INSERT INTO `master_channels` (`id`, `slug`, `display_name`, `db_aliases`, `has_processor`, `is_active`, `channel_type`) VALUES (9103, 'others', 'Others', JSON_ARRAY('Others'), 0, 0, 'B2B')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `master_channels` WHERE `id` = 9103");
        await queryRunner.query("ALTER TABLE `pepims_sync_line_links` DROP FOREIGN KEY `fk_pepims_sync_line_links_line`");
        await queryRunner.query("ALTER TABLE `pepims_sync_links` DROP FOREIGN KEY `fk_pepims_sync_links_po`");
        await queryRunner.query("DROP TABLE `pepims_sync_line_links`");
        await queryRunner.query("DROP TABLE `pepims_sync_links`");
        await queryRunner.query("DROP INDEX `idx_master_po_imported_from` ON `master_purchase_orders`");
        await queryRunner.query("DROP INDEX `idx_master_po_group` ON `master_purchase_orders`");
        await queryRunner.query("ALTER TABLE `master_purchase_orders` DROP COLUMN `importedFrom`, DROP COLUMN `partyName`, DROP COLUMN `poGroup`");
    }

}
