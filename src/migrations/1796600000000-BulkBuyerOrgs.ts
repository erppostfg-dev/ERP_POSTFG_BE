import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders buyer organisations (2026-11-24, user "yes do this too"; PRD "Institutional buyer: outside organisation,
 * sees its organisation's orders + its customer list"). NEW tables bulk_buyer_orgs (name, active) and
 * bulk_buyer_org_users (a person belongs to at most one organisation); bulk_orders + buyer_org_id and
 * bulk_institution_customers + buyer_org_id (NULL = ours / no organisation, as before). Existing rows stay NULL:
 * nothing changes until an admin creates an organisation and adds people to it. down() drops them.
 */

export class BulkBuyerOrgs1796600000000 implements MigrationInterface {
    name = 'BulkBuyerOrgs1796600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("CREATE TABLE `bulk_buyer_orgs` (`id` bigint NOT NULL AUTO_INCREMENT, `name` varchar(200) NOT NULL, `is_active` tinyint NOT NULL DEFAULT 1, `created_by` int NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_bulk_buyer_orgs_name` (`name`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
        await queryRunner.query("CREATE TABLE `bulk_buyer_org_users` (`user_id` int NOT NULL, `org_id` bigint NOT NULL, `added_by` int NOT NULL, `added_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX `idx_bulk_buyer_org_users_org` (`org_id`), PRIMARY KEY (`user_id`)) ENGINE=InnoDB");
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `buyer_org_id` bigint NULL");
        await queryRunner.query("CREATE INDEX `idx_bulk_orders_buyer_org` ON `bulk_orders` (`buyer_org_id`)");
        await queryRunner.query("ALTER TABLE `bulk_institution_customers` ADD `buyer_org_id` bigint NULL");
        await queryRunner.query("CREATE INDEX `idx_bulk_inst_customers_org` ON `bulk_institution_customers` (`buyer_org_id`)");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP INDEX `idx_bulk_inst_customers_org` ON `bulk_institution_customers`");
        await queryRunner.query("ALTER TABLE `bulk_institution_customers` DROP COLUMN `buyer_org_id`");
        await queryRunner.query("DROP INDEX `idx_bulk_orders_buyer_org` ON `bulk_orders`");
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `buyer_org_id`");
        await queryRunner.query("DROP INDEX `idx_bulk_buyer_org_users_org` ON `bulk_buyer_org_users`");
        await queryRunner.query("DROP TABLE `bulk_buyer_org_users`");
        await queryRunner.query("DROP INDEX `uq_bulk_buyer_orgs_name` ON `bulk_buyer_orgs`");
        await queryRunner.query("DROP TABLE `bulk_buyer_orgs`");
    }

}
