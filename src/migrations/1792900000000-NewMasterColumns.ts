import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * New masters (2026-10-28, "Post FG - Updated Masters" workbook): details_channels.city and master_channels.channel_type
 * (B2B / B2C), expiry_days_min, expiry_days_max. On the dev DB these four columns were already added by hand (outside
 * the migrations) the same day, so each one is added only when it is missing: a no-op on dev, the real change on prod.
 * Same definitions as dev: all nullable. down() drops them.
 */

const COLUMNS: [table: string, column: string, definition: string][] = [
    ['details_channels', 'city', 'varchar(255) NULL'],
    ['master_channels', 'channel_type', 'varchar(20) NULL'],
    ['master_channels', 'expiry_days_min', 'int NULL'],
    ['master_channels', 'expiry_days_max', 'int NULL'],
];

export class NewMasterColumns1792900000000 implements MigrationInterface {
    name = 'NewMasterColumns1792900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column, definition] of COLUMNS) {
            const found = (await queryRunner.query(
                `SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column],
            )) as { n: number | string }[];
            if (Number(found[0]?.n) === 0) await queryRunner.query(`ALTER TABLE \`${table}\` ADD \`${column}\` ${definition}`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column] of [...COLUMNS].reverse()) await queryRunner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }

}
