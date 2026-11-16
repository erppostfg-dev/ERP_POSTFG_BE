import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders portal step 1 (2026-11-11, constants/bulk-orders.ts, entities/bulk-order.entities.ts):
 *   - bulk_orders, bulk_order_lines, bulk_locations, bulk_order_counters: NEW tables only;
 *   - 3 fixed roles (constants/users.ts ROLE_CATALOG) with grants on the Bulk Orders pages only:
 *     bulk-marketing (Marketing editor), bulk-institutional (Institutional editor), bulk-approver (Approve editor +
 *     both types viewer);
 *   - admin / developer: editor on /bulk-orders (as on every other top-level page; INSERT IGNORE = no change if there).
 * No existing table or row is changed. down() removes exactly these (people given a bulk role keep a user_roles row
 * that then grants nothing: remove those roles in Users & Roles first).
 */

const BULK_ROLES = "'bulk-marketing', 'bulk-institutional', 'bulk-approver'";

export class BulkOrders1794900000000 implements MigrationInterface {
    name = 'BulkOrders1794900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`bulk_orders\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`po_number\` varchar(30) NOT NULL, \`order_type\` varchar(20) NOT NULL, \`status\` varchar(30) NOT NULL, \`ordered_by\` varchar(150) NOT NULL, \`receiver_name\` varchar(150) NOT NULL, \`receiver_phone\` varchar(20) NOT NULL, \`location_id\` bigint NULL, \`location_label\` varchar(100) NULL, \`address_line\` varchar(500) NOT NULL, \`city\` varchar(100) NOT NULL, \`state\` varchar(100) NOT NULL, \`pincode\` varchar(10) NOT NULL, \`needed_by\` date NOT NULL, \`delivery_mode\` varchar(20) NULL, \`priority\` varchar(20) NOT NULL, \`note\` varchar(1000) NULL, \`line_count\` int NOT NULL, \`total_units\` int NOT NULL, \`total_mrp\` decimal(14,2) NOT NULL, \`total_value\` decimal(14,2) NOT NULL, \`created_by\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`decided_by\` int NULL, \`decided_at\` datetime(6) NULL, \`decision_note\` varchar(1000) NULL, INDEX \`idx_bulk_orders_type_status\` (\`order_type\`, \`status\`, \`created_at\`), UNIQUE INDEX \`uq_bulk_orders_po_number\` (\`po_number\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`bulk_order_lines\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`order_id\` bigint NOT NULL, \`line_no\` int NOT NULL, \`pep_code\` varchar(100) NOT NULL, \`product_name\` varchar(500) NULL, \`mrp\` decimal(10,2) NOT NULL, \`requested_qty\` int NOT NULL, \`requested_discount_pct\` decimal(5,2) NOT NULL, \`qty\` int NOT NULL, \`discount_pct\` decimal(5,2) NOT NULL, \`unit_price\` decimal(10,2) NOT NULL, \`line_total\` decimal(14,2) NOT NULL, UNIQUE INDEX \`uq_bulk_order_lines_line\` (\`order_id\`, \`line_no\`), UNIQUE INDEX \`uq_bulk_order_lines_sku\` (\`order_id\`, \`pep_code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`bulk_locations\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`order_type\` varchar(20) NOT NULL, \`label\` varchar(100) NOT NULL, \`address_line\` varchar(500) NOT NULL, \`city\` varchar(100) NOT NULL, \`state\` varchar(100) NOT NULL, \`pincode\` varchar(10) NOT NULL, \`created_by\` int NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_bulk_locations_label\` (\`order_type\`, \`label\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`bulk_order_counters\` (\`order_type\` varchar(20) NOT NULL, \`order_year\` int NOT NULL, \`last_serial\` int NOT NULL, PRIMARY KEY (\`order_type\`, \`order_year\`)) ENGINE=InnoDB`);

        await queryRunner.query("INSERT INTO `roles` (`role_key`, `label`, `description`, `is_system`) VALUES ('bulk-marketing', 'Bulk Orders: Marketing', 'Creates and sees Marketing bulk orders in the Bulk Orders portal only', 0), ('bulk-institutional', 'Bulk Orders: Institutional', 'Creates and sees Institutional bulk orders in the Bulk Orders portal only', 0), ('bulk-approver', 'Bulk Orders: Approver', 'Sees every bulk order and approves or rejects them in the Bulk Orders portal only', 0)");
        await queryRunner.query("INSERT INTO `page_permissions` (`role`, `page_slug`, `access_level`) VALUES ('bulk-marketing', '/bulk-orders/marketing', 'editor'), ('bulk-institutional', '/bulk-orders/institutional', 'editor'), ('bulk-approver', '/bulk-orders/approve', 'editor'), ('bulk-approver', '/bulk-orders/marketing', 'viewer'), ('bulk-approver', '/bulk-orders/institutional', 'viewer')");
        await queryRunner.query("INSERT IGNORE INTO `page_permissions` (`role`, `page_slug`, `access_level`) VALUES ('admin', '/bulk-orders', 'editor'), ('developer', '/bulk-orders', 'editor')");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DELETE FROM `page_permissions` WHERE `page_slug` LIKE '/bulk-orders%'");
        await queryRunner.query(`DELETE FROM \`roles\` WHERE \`role_key\` IN (${BULK_ROLES})`);
        await queryRunner.query(`DROP TABLE \`bulk_order_counters\``);
        await queryRunner.query(`DROP TABLE \`bulk_locations\``);
        await queryRunner.query(`DROP TABLE \`bulk_order_lines\``);
        await queryRunner.query(`DROP TABLE \`bulk_orders\``);
    }

}
