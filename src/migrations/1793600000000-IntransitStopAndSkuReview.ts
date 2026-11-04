import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Stop and new-SKU review (user, 2026-11-02):
 *   - intransit_runs.status gains 'stopped'; stop_requested_by = who pressed Stop (also the signal to the machine
 *     running it);
 *   - master_skus.intransit_reviewed_at: a new SKU the user answered Consider / Don't consider for (never asked again);
 *     intransit_autofilled: which Sheet35 values were filled by the build (Uniware MRP, COGS = 20% of MRP), NULL = typed;
 *   - intransit_channel_sku_map.consider: 0 = a marketplace code the user said not to count;
 *   - intransit_master_changes.source gains 'sku_review' and 'uniware_fill'.
 * down() fails while 'stopped' runs or the new change sources exist - delete those first.
 */

export class IntransitStopAndSkuReview1793600000000 implements MigrationInterface {
    name = 'IntransitStopAndSkuReview1793600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` MODIFY \`status\` enum ('queued', 'running', 'succeeded', 'failed', 'stopped') NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` ADD \`stop_requested_by\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` ADD CONSTRAINT \`fk_intransit_runs_stop_requested_by\` FOREIGN KEY (\`stop_requested_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`master_skus\` ADD \`intransit_reviewed_at\` datetime NULL, ADD \`intransit_autofilled\` varchar(100) NULL`);
        await queryRunner.query(`ALTER TABLE \`intransit_channel_sku_map\` ADD \`consider\` tinyint(1) NOT NULL DEFAULT 1`);
        await queryRunner.query(`ALTER TABLE \`intransit_master_changes\` MODIFY \`source\` enum ('upload', 'split1_add', 'variant_map', 'loader', 'sku_review', 'uniware_fill') NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`intransit_master_changes\` MODIFY \`source\` enum ('upload', 'split1_add', 'variant_map', 'loader') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`intransit_channel_sku_map\` DROP COLUMN \`consider\``);
        await queryRunner.query(`ALTER TABLE \`master_skus\` DROP COLUMN \`intransit_autofilled\`, DROP COLUMN \`intransit_reviewed_at\``);
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` DROP FOREIGN KEY \`fk_intransit_runs_stop_requested_by\``);
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` DROP COLUMN \`stop_requested_by\``);
        await queryRunner.query(`ALTER TABLE \`intransit_runs\` MODIFY \`status\` enum ('queued', 'running', 'succeeded', 'failed') NOT NULL DEFAULT 'queued'`);
    }

}
