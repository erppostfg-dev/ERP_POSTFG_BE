import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Myntra Partner Portal robot (2026-10-28, user): intransit_runs.kind gains 'myntra' for its fetch runs. down() takes it
 * out again (it fails while 'myntra' runs exist - delete those first).
 */

export class IntransitRunsMyntra1793200000000 implements MigrationInterface {
    name = 'IntransitRunsMyntra1793200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` MODIFY \`kind\` enum ('report', 'amazon', 'uniware', 'flipkart', 'myntra') NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` MODIFY \`kind\` enum ('report', 'amazon', 'uniware', 'flipkart') NOT NULL`);
    }

}
