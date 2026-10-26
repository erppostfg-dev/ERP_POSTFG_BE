import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * In-transit masters in the database (2026-10-22, user: "fewer new tables, reuse and add columns"; the combo splits get
 * their own table, user's choice). No existing value changes. Filled by `npm run intransit:masters`.
 *   NEW master_sku_components  one row per part of a combo: Split1.csv (stage split1) / Split2.csv (stage split2).
 *                              combo_pep_code + component_pep_code -> master_skus.pep_code (FK), qty = units of the part,
 *                              position = its order inside the combo (the order the file lists it).
 *   master_skus        final_pep_code      Final SKU Mapping.csv (listing SKU -> final SKU; null = itself)
 *                      intransit_consider  0 = in SKU-Not To Consider.csv
 *                      intransit_name / _type / _category / _mrp / _cogs
 *                                          Sheet35(2).csv (SKU Name, Type, Count, MRP, COGS (With TAX)); kept apart from
 *                                          product_name / product_type / mrp, which differ for some SKUs (user: keep both)
 *   details_channels   intransit_location  Location Master.csv "Final Location" / MyntraWHIDs.csv "WH location" of the
 *                                          channel location (channel_location_code = the FC / WH id)
 *   master_facilities  intransit_group     the report's stock bucket (GGNMWH, MUMMWH, D2C, DarkStore, Return ...)
 *                      intransit_type      its channel type (MWH, D2C, DarkStore, Return)
 *   NEW intransit_channel_sku_map  TEMPORARY home of Channel SKU Mapping (user, 2026-10-22), until its channels are
 *                              filled and its conflicts settled; then merged into master_channel_skus. One row per
 *                              SKU + channel + channel code (channel empty while unknown); unique (channel, code).
 *                              No FK to master_skus: many of its SKUs are not in the product master yet.
 * Written by hand: review it, then `npm run migration:run`. down() drops the table and the columns (their data with them).
 */

export class IntransitMasters1792200000000 implements MigrationInterface {
    name = 'IntransitMasters1792200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_skus\` ADD \`final_pep_code\` varchar(100) NULL, ADD \`intransit_consider\` tinyint(1) NOT NULL DEFAULT 1, ADD \`intransit_name\` varchar(500) NULL, ADD \`intransit_type\` varchar(50) NULL, ADD \`intransit_category\` varchar(100) NULL, ADD \`intransit_mrp\` decimal(10,2) NULL, ADD \`intransit_cogs\` decimal(10,2) NULL`);
        await queryRunner.query(`CREATE TABLE \`master_sku_components\` (\`id\` int NOT NULL AUTO_INCREMENT, \`stage\` enum ('split1', 'split2') NOT NULL, \`combo_pep_code\` varchar(100) NOT NULL, \`component_pep_code\` varchar(100) NOT NULL, \`qty\` int NOT NULL DEFAULT 1, \`position\` int NOT NULL DEFAULT 0, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_master_sku_components\` (\`stage\`, \`combo_pep_code\`, \`component_pep_code\`), INDEX \`idx_master_sku_components_combo\` (\`combo_pep_code\`), INDEX \`idx_master_sku_components_component\` (\`component_pep_code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`master_sku_components\` ADD CONSTRAINT \`fk_sku_components_combo\` FOREIGN KEY (\`combo_pep_code\`) REFERENCES \`master_skus\`(\`pep_code\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`master_sku_components\` ADD CONSTRAINT \`fk_sku_components_component\` FOREIGN KEY (\`component_pep_code\`) REFERENCES \`master_skus\`(\`pep_code\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`details_channels\` ADD \`intransit_location\` varchar(100) NULL`);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`intransit_group\` varchar(50) NULL, ADD \`intransit_type\` varchar(50) NULL`);
        await queryRunner.query(`CREATE TABLE \`intransit_channel_sku_map\` (\`id\` int NOT NULL AUTO_INCREMENT, \`sku_code\` varchar(100) NOT NULL, \`channel\` varchar(100) NULL, \`channel_sku_code\` varchar(255) NOT NULL, \`final_sku\` varchar(100) NULL, \`source\` varchar(50) NOT NULL, \`review_note\` varchar(255) NULL, \`is_active\` tinyint(1) NOT NULL DEFAULT 1, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_intransit_channel_sku_map\` (\`channel\`, \`channel_sku_code\`), INDEX \`idx_intransit_channel_sku_map_sku\` (\`sku_code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`intransit_channel_sku_map\``);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`intransit_type\`, DROP COLUMN \`intransit_group\``);
        await queryRunner.query(`ALTER TABLE \`details_channels\` DROP COLUMN \`intransit_location\``);
        await queryRunner.query(`ALTER TABLE \`master_sku_components\` DROP FOREIGN KEY \`fk_sku_components_component\``);
        await queryRunner.query(`ALTER TABLE \`master_sku_components\` DROP FOREIGN KEY \`fk_sku_components_combo\``);
        await queryRunner.query(`DROP TABLE \`master_sku_components\``);
        await queryRunner.query(`ALTER TABLE \`master_skus\` DROP COLUMN \`intransit_cogs\`, DROP COLUMN \`intransit_mrp\`, DROP COLUMN \`intransit_category\`, DROP COLUMN \`intransit_type\`, DROP COLUMN \`intransit_name\`, DROP COLUMN \`intransit_consider\`, DROP COLUMN \`final_pep_code\``);
    }

}
