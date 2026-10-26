import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Inbound plan + shipment tracking (user, 2026-10-19; constants/inbound.ts, entities/inbound.entities.ts). Generated from
 * the entities, then the default "stuck" limits added at the end of up() (WORKING 7, IN_TRANSIT 10, RECEIVING 15 days,
 * no courier = the default row; editable later, per courier for IN_TRANSIT).
 * Only NEW tables: nothing existing is changed. down() drops them again (and their rows).
 */

export class InboundTracking1792412490547 implements MigrationInterface {
    name = 'InboundTracking1792412490547'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`inbound_plans\` (\`id\` int NOT NULL AUTO_INCREMENT, \`source_system\` varchar(50) NOT NULL, \`plan_id\` varchar(64) NOT NULL, \`name\` varchar(200) NULL, \`status\` varchar(30) NULL, \`ship_from_name\` varchar(200) NULL, \`ship_from_pincode\` varchar(10) NULL, \`facility_id\` int NULL, \`created_at_channel\` datetime NULL, \`updated_at_channel\` datetime NULL, \`plan_sku_count\` int NULL, \`plan_units\` int NULL, \`shipment_count\` int NOT NULL DEFAULT '0', \`first_seen_at\` datetime NOT NULL, \`last_checked_at\` datetime NOT NULL, INDEX \`idx_inbound_plans_created\` (\`created_at_channel\`), UNIQUE INDEX \`uq_inbound_plans_plan\` (\`source_system\`, \`plan_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`inbound_shipments\` (\`id\` int NOT NULL AUTO_INCREMENT, \`source_system\` varchar(50) NOT NULL, \`external_id\` varchar(40) NOT NULL, \`plan_row_id\` int NULL, \`channel_shipment_id\` varchar(64) NULL, \`name\` varchar(200) NULL, \`fc_code\` varchar(20) NULL, \`fc_city\` varchar(100) NULL, \`fc_pincode\` varchar(10) NULL, \`status\` varchar(30) NOT NULL, \`status_since\` datetime NOT NULL, \`sku_count\` int NULL, \`units_planned\` int NULL, \`units_received\` int NULL, \`lines_fingerprint\` char(40) NULL, \`lines_checked_at\` datetime NULL, \`received_checked_at\` datetime NULL, \`po_upload_id\` bigint NULL, \`attention\` varchar(200) NULL, \`first_seen_at\` datetime NOT NULL, \`last_seen_at\` datetime NOT NULL, INDEX \`idx_inbound_shipments_status\` (\`status\`, \`status_since\`), INDEX \`idx_inbound_shipments_plan\` (\`plan_row_id\`), UNIQUE INDEX \`uq_inbound_shipments_ext\` (\`source_system\`, \`external_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`inbound_shipment_lines\` (\`id\` int NOT NULL AUTO_INCREMENT, \`shipment_id\` int NOT NULL, \`seller_sku\` varchar(100) NOT NULL, \`fnsku\` varchar(40) NULL, \`asin\` varchar(20) NULL, \`qty_planned\` int NOT NULL, \`qty_received\` int NULL, \`updated_at\` datetime NOT NULL, UNIQUE INDEX \`uq_inbound_lines_sku\` (\`shipment_id\`, \`seller_sku\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`inbound_shipment_events\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`shipment_id\` int NOT NULL, \`kind\` enum ('discovered', 'status_changed', 'lines_changed', 'received_updated', 'po_linked', 'attention') NOT NULL, \`old_value\` varchar(200) NULL, \`new_value\` varchar(200) NULL, \`detail\` json NULL, \`source\` enum ('poll', 'sweep', 'refresh', 'script') NOT NULL, \`seen_at\` datetime NOT NULL, INDEX \`idx_inbound_events_shipment\` (\`shipment_id\`, \`seen_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`inbound_status_limits\` (\`id\` int NOT NULL AUTO_INCREMENT, \`source_system\` varchar(50) NOT NULL, \`status\` varchar(30) NOT NULL, \`courier_partner_id\` int NULL, \`max_days\` int NOT NULL, \`updated_by\` int NULL, \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE INDEX \`uq_inbound_limits\` (\`source_system\`, \`status\`, \`courier_partner_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`inbound_plans\` ADD CONSTRAINT \`fk_inbound_plans_facility\` FOREIGN KEY (\`facility_id\`) REFERENCES \`master_facilities\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`inbound_shipments\` ADD CONSTRAINT \`fk_inbound_shipments_plan\` FOREIGN KEY (\`plan_row_id\`) REFERENCES \`inbound_plans\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`inbound_shipments\` ADD CONSTRAINT \`fk_inbound_shipments_po_upload\` FOREIGN KEY (\`po_upload_id\`) REFERENCES \`po_uploads\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`inbound_shipment_lines\` ADD CONSTRAINT \`fk_inbound_lines_shipment\` FOREIGN KEY (\`shipment_id\`) REFERENCES \`inbound_shipments\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`inbound_shipment_events\` ADD CONSTRAINT \`fk_inbound_events_shipment\` FOREIGN KEY (\`shipment_id\`) REFERENCES \`inbound_shipments\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`inbound_status_limits\` ADD CONSTRAINT \`fk_inbound_limits_courier\` FOREIGN KEY (\`courier_partner_id\`) REFERENCES \`master_courier_partners\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`inbound_status_limits\` ADD CONSTRAINT \`fk_inbound_limits_user\` FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        // Default stuck limits for Amazon (no courier = applies to every courier until a courier row is added).
        await queryRunner.query("INSERT INTO `inbound_status_limits` (`source_system`, `status`, `courier_partner_id`, `max_days`) VALUES ('amazon_spapi', 'WORKING', NULL, 7), ('amazon_spapi', 'IN_TRANSIT', NULL, 10), ('amazon_spapi', 'RECEIVING', NULL, 15)");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`inbound_status_limits\` DROP FOREIGN KEY \`fk_inbound_limits_user\``);
        await queryRunner.query(`ALTER TABLE \`inbound_status_limits\` DROP FOREIGN KEY \`fk_inbound_limits_courier\``);
        await queryRunner.query(`ALTER TABLE \`inbound_shipment_events\` DROP FOREIGN KEY \`fk_inbound_events_shipment\``);
        await queryRunner.query(`ALTER TABLE \`inbound_shipment_lines\` DROP FOREIGN KEY \`fk_inbound_lines_shipment\``);
        await queryRunner.query(`ALTER TABLE \`inbound_shipments\` DROP FOREIGN KEY \`fk_inbound_shipments_po_upload\``);
        await queryRunner.query(`ALTER TABLE \`inbound_shipments\` DROP FOREIGN KEY \`fk_inbound_shipments_plan\``);
        await queryRunner.query(`ALTER TABLE \`inbound_plans\` DROP FOREIGN KEY \`fk_inbound_plans_facility\``);
        await queryRunner.query(`DROP INDEX \`uq_inbound_limits\` ON \`inbound_status_limits\``);
        await queryRunner.query(`DROP TABLE \`inbound_status_limits\``);
        await queryRunner.query(`DROP INDEX \`idx_inbound_events_shipment\` ON \`inbound_shipment_events\``);
        await queryRunner.query(`DROP TABLE \`inbound_shipment_events\``);
        await queryRunner.query(`DROP INDEX \`uq_inbound_lines_sku\` ON \`inbound_shipment_lines\``);
        await queryRunner.query(`DROP TABLE \`inbound_shipment_lines\``);
        await queryRunner.query(`DROP INDEX \`uq_inbound_shipments_ext\` ON \`inbound_shipments\``);
        await queryRunner.query(`DROP INDEX \`idx_inbound_shipments_plan\` ON \`inbound_shipments\``);
        await queryRunner.query(`DROP INDEX \`idx_inbound_shipments_status\` ON \`inbound_shipments\``);
        await queryRunner.query(`DROP TABLE \`inbound_shipments\``);
        await queryRunner.query(`DROP INDEX \`uq_inbound_plans_plan\` ON \`inbound_plans\``);
        await queryRunner.query(`DROP INDEX \`idx_inbound_plans_created\` ON \`inbound_plans\``);
        await queryRunner.query(`DROP TABLE \`inbound_plans\``);
    }

}
