import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * master_channel_skus.is_active (2026-10-28, user: switch a wrong channel SKU mapping off on the Masters page instead of
 * deleting it). Every existing row becomes active (DEFAULT 1), so PO results do not change until someone switches a
 * row off. Generated from the entity; down() drops the column.
 */

export class ChannelSkuActive1793189583175 implements MigrationInterface {
    name = 'ChannelSkuActive1793189583175'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_channel_skus\` ADD \`is_active\` tinyint NOT NULL DEFAULT 1`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_channel_skus\` DROP COLUMN \`is_active\``);
    }

}
