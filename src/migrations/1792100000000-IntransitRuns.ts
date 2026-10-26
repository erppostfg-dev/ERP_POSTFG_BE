import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * In-transit stock (2026-10-15, user): intransit_runs, one row per report build or connector fetch of the
 * Demand Planning > In-transit Stock page (entities/intransit-run.entity.ts). Written by hand to match the entity
 * (no database was reachable to generate it): review it, then `npm run migration:run`. down() drops the table.
 */

export class IntransitRuns1792100000000 implements MigrationInterface {
    name = 'IntransitRuns1792100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`intransit_runs\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`kind\` enum ('report', 'amazon', 'uniware', 'flipkart') NOT NULL, \`status\` enum ('queued', 'running', 'succeeded', 'failed') NOT NULL DEFAULT 'queued', \`as_of\` date NULL, \`options\` json NULL, \`created_by\` int NULL, \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, \`started_at\` datetime NULL, \`finished_at\` datetime NULL, \`error\` varchar(1000) NULL, \`timings\` json NULL, \`summary\` json NULL, \`sheet_rows\` json NULL, \`result\` json NULL, \`log\` mediumtext NULL, \`report_path\` varchar(500) NULL, INDEX \`idx_intransit_runs_kind\` (\`kind\`, \`id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` ADD CONSTRAINT \`fk_intransit_runs_created_by\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` DROP FOREIGN KEY \`fk_intransit_runs_created_by\``);
        await queryRunner.query(`DROP TABLE \`intransit_runs\``);
    }

}
