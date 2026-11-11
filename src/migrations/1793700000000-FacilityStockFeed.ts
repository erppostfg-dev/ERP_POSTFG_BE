import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Per-facility stock settings (user's facility sheet, 2026-11-02): master_facilities.intransit_feed ('both' = its open
 * purchase orders also count as in transit, 'soh' = stock on hand only) and stock_formula (which Inventory Snapshot
 * columns make its SOH), edited in Masters > Warehouses. Filled for every facility that has a stock bucket with exactly
 * what the report did until now (the formulas were in code), so the report does not change:
 *   D2C       both  INV_PP_OP_MINUS_OS   (mCaff_Mumbai2, mCaff_Gurgaon3: INV_PP_OP_SIT_MINUS_OS)
 *   DarkStore both  INV_PP_OP_SIT_MINUS_OS
 *   GGNMWH / MUMMWH / KOLMWH  both  INV_PP_OP_SIT
 *   Return    soh   INV
 * Facilities without a bucket stay empty. down() drops both columns.
 */

const DEFAULTS: [string, string, string][] = [
    ['D2C', 'both', 'INV_PP_OP_MINUS_OS'],
    ['DarkStore', 'both', 'INV_PP_OP_SIT_MINUS_OS'],
    ['GGNMWH', 'both', 'INV_PP_OP_SIT'],
    ['MUMMWH', 'both', 'INV_PP_OP_SIT'],
    ['KOLMWH', 'both', 'INV_PP_OP_SIT'],
    ['Return', 'soh', 'INV'],
];
const SIT_D2C = ['mCaff_Mumbai2', 'mCaff_Gurgaon3'];

export class FacilityStockFeed1793700000000 implements MigrationInterface {
    name = 'FacilityStockFeed1793700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`intransit_feed\` varchar(20) NULL AFTER \`intransit_type\``);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`stock_formula\` varchar(40) NULL AFTER \`intransit_feed\``);
        for (const [group, feed, formula] of DEFAULTS) {
            await queryRunner.query(
                `UPDATE \`master_facilities\` SET \`intransit_feed\` = ?, \`stock_formula\` = ? WHERE \`intransit_group\` = ?`,
                [feed, formula, group],
            );
        }
        await queryRunner.query(
            `UPDATE \`master_facilities\` SET \`stock_formula\` = 'INV_PP_OP_SIT_MINUS_OS'
             WHERE \`intransit_group\` = 'D2C' AND LOWER(\`code\`) IN (${SIT_D2C.map(() => 'LOWER(?)').join(', ')})`,
            SIT_D2C,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`stock_formula\``);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`intransit_feed\``);
    }

}
