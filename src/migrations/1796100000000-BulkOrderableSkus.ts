import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Bulk Orders: which PEP SKUs the portal shows (2026-11-24, user: only the 540 "final to consider" SKUs, no others).
 * master_skus + bulk_orderable (1 = shown in Bulk Orders, 0 = hidden; default 0, so a new SKU stays hidden until someone
 * switches it on in Masters > PEP SKUs or the list is loaded with npm run bulk:skus). NO data here: the list is loaded
 * by the loader (dry run first). down() drops the column.
 */

export class BulkOrderableSkus1796100000000 implements MigrationInterface {
    name = 'BulkOrderableSkus1796100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `master_skus` ADD `bulk_orderable` tinyint NOT NULL DEFAULT 0");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("ALTER TABLE `master_skus` DROP COLUMN `bulk_orderable`");
    }

}
