import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 5a, Institutional customer list (2026-11-24, user "GO"; PRD "Customers page"): the
 * customers an Institutional buyer orders for. NEW table bulk_institution_customers (company, GSTIN + who verified it,
 * billing address, contact, default discount %, active) and bulk_institution_customer_addresses (its shipping
 * addresses, active). bulk_orders + institution_customer_id (the customer an Institutional order was placed for; NULL =
 * typed by hand as before). Not the same as bulk_customers (our team's Uniware address book). Only new tables / a new
 * NULL column: down() drops them.
 */

export class BulkInstitutionCustomers1796300000000 implements MigrationInterface {
    name = 'BulkInstitutionCustomers1796300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("CREATE TABLE `bulk_institution_customers` (`id` bigint NOT NULL AUTO_INCREMENT, `company_name` varchar(200) NOT NULL, `gstin` varchar(15) NULL, `gstin_verified_by` int NULL, `gstin_verified_at` datetime(6) NULL, `billing_address_line` varchar(500) NOT NULL, `billing_city` varchar(100) NOT NULL, `billing_state` varchar(100) NOT NULL, `billing_pincode` varchar(10) NOT NULL, `contact_name` varchar(150) NOT NULL, `contact_phone` varchar(20) NOT NULL, `contact_email` varchar(150) NULL, `default_discount_pct` decimal(5,2) NOT NULL DEFAULT 0, `is_active` tinyint NOT NULL DEFAULT 1, `created_by` int NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `updated_by` int NULL, `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX `uq_bulk_inst_customers_gstin` (`gstin`), INDEX `idx_bulk_inst_customers_name` (`company_name`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
        await queryRunner.query("CREATE TABLE `bulk_institution_customer_addresses` (`id` bigint NOT NULL AUTO_INCREMENT, `customer_id` bigint NOT NULL, `label` varchar(100) NOT NULL, `address_line` varchar(500) NOT NULL, `city` varchar(100) NOT NULL, `state` varchar(100) NOT NULL, `pincode` varchar(10) NOT NULL, `is_active` tinyint NOT NULL DEFAULT 1, `created_by` int NOT NULL, `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX `idx_bulk_inst_customer_addresses_customer` (`customer_id`), PRIMARY KEY (`id`)) ENGINE=InnoDB");
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `institution_customer_id` bigint NULL");
        await queryRunner.query("CREATE INDEX `idx_bulk_orders_inst_customer` ON `bulk_orders` (`institution_customer_id`)");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP INDEX `idx_bulk_orders_inst_customer` ON `bulk_orders`");
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `institution_customer_id`");
        await queryRunner.query("DROP INDEX `idx_bulk_inst_customer_addresses_customer` ON `bulk_institution_customer_addresses`");
        await queryRunner.query("DROP TABLE `bulk_institution_customer_addresses`");
        await queryRunner.query("DROP INDEX `idx_bulk_inst_customers_name` ON `bulk_institution_customers`");
        await queryRunner.query("DROP INDEX `uq_bulk_inst_customers_gstin` ON `bulk_institution_customers`");
        await queryRunner.query("DROP TABLE `bulk_institution_customers`");
    }

}
