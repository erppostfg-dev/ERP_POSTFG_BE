import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Uniware sale order status for channel POs (2026-11-06, modules/po-uniware-sync): one new nullable column
 * master_purchase_orders.uniwareStatus ("COMPLETE | SP/1 DISPATCHED" or "Not in Uniware yet"). Existing rows stay null
 * until the sync reads them. Numbered after 1794500000000 (margin approval, not on dev yet). down() drops it.
 */

export class PoUniwareStatus1794600000000 implements MigrationInterface {
    name = 'PoUniwareStatus1794600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` ADD \`uniwareStatus\` varchar(100) NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_purchase_orders\` DROP COLUMN \`uniwareStatus\``);
    }

}
