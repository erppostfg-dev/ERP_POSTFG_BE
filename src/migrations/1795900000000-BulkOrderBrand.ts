import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders Portal v2 piece 1f, brand (2026-11-24; constants/bulk-orders.ts BULK_ORDERS.NO_BRAND).
 *   - bulk_orders + brand (the PEP SKU master brand_name the order was placed for; one brand per order).
 *   - Orders already there: filled from their lines when all their SKUs have ONE brand in the master, else left NULL.
 * down() drops the column.
 */

export class BulkOrderBrand1795900000000 implements MigrationInterface {
    name = 'BulkOrderBrand1795900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` ADD `brand` varchar(100) NULL");
        await queryRunner.query(`UPDATE \`bulk_orders\` o JOIN (
            SELECT l.order_id, MIN(TRIM(s.brand_name)) b FROM \`bulk_order_lines\` l JOIN \`master_skus\` s ON s.pep_code = l.pep_code
            GROUP BY l.order_id
            HAVING COUNT(DISTINCT LOWER(TRIM(s.brand_name))) = 1 AND SUM(s.brand_name IS NULL OR TRIM(s.brand_name) IN ('', '0')) = 0
          ) x ON x.order_id = o.id SET o.brand = x.b`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `bulk_orders` DROP COLUMN `brand`");
    }

}
