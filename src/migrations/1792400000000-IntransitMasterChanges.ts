import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * In-transit masters change log (2026-10-25, user): NEW intransit_master_changes, one row per value an in-transit master
 * gained or changed in the database (uploads, combos added on the page, variant maps, the first load). Nothing reads it
 * until the masters are in the database (INTRANSIT_MASTERS_SOURCE=db). Written by hand: review it, then
 * `npm run migration:run`. down() drops intransit_master_changes.
 * app_state (the in-transit store keeps its owner and caches in it) is made by LocalStorageDb1792750018744, which runs
 * after this one: this migration made it too (IF NOT EXISTS) until 2026-10-27, which made LocalStorageDb's plain CREATE
 * TABLE fail on a new database and stopped the deploy part-way. Databases where this already ran are unaffected.
 */

export class IntransitMasterChanges1792400000000 implements MigrationInterface {
    name = 'IntransitMasterChanges1792400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`intransit_master_changes\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`master\` varchar(40) NOT NULL, \`table_name\` varchar(64) NOT NULL, \`row_key\` varchar(255) NOT NULL, \`field\` varchar(64) NULL, \`old_value\` text NULL, \`new_value\` text NULL, \`action\` enum ('add', 'update') NOT NULL, \`source\` enum ('upload', 'split1_add', 'variant_map', 'loader') NOT NULL, \`import_key\` varchar(600) NULL, \`changed_by\` int NULL, \`changed_by_name\` varchar(255) NULL, \`host\` varchar(64) NOT NULL, \`changed_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX \`idx_intransit_master_changes_master\` (\`master\`, \`changed_at\`), INDEX \`idx_intransit_master_changes_row\` (\`row_key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`intransit_master_changes\``);
    }

}
