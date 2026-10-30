import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Stock buckets in the database (user, 2026-10-30): the in-transit build now counts the facilities of
 * master_facilities.intransit_group / intransit_type instead of the list in code (FACILITY_GROUPS), so new Uniware
 * facilities are added from the Facility check with a click. Fills the bucket of every facility that list held on
 * 30-Oct where none is set yet - among them the four counted from that day (KOL_WAREHOUSE, mCaff_Kolkata3,
 * mCaff_Hyderabad3, HYP_BYHYD), which had SOH 0 before. A bucket already set is left as it is.
 * down() clears only those four.
 */

const BUCKETS: [string, string, string[]][] = [
    ['D2C', 'D2C', [
        'HYP_SRGGN', 'HYP_SRKOL', 'mCaff_Mumbai2', 'mCaff_Gurgaon2', 'mCaff_Bangalore2', 'mCaff_Kolkata2', 'mCaff_Ahmedabad', 'mCaff_Hyderabad2',
        'mCaff_Guwahati', 'HYP_SRBGLR', 'HYP_AHMD', 'HYP_SRHYD', 'HYP_SRGWHT', 'HYP_SRLOK', 'mCaff_Gurgaon3', 'mCaff_Lucknow3', 'HYP_SRLOK2',
        'HYP_DLNAG', 'HYP_DLGWHT', 'mCaff_Lucknow2', 'Mcaff_Nagpur', 'mCaff_Guwahati2', 'HYP_SPCHN', 'Mcaff_Chennai',
        'mCaff_Kolkata3', 'mCaff_Hyderabad3', 'HYP_BYHYD',
    ]],
    ['DarkStore', 'DarkStore', [
        'DS_NCR_PD_MOTHERHUB', 'DS_NCR_PD_EASTDELHI_931', 'DS_NCR_PD_FARIDABAD', 'DS_NCR_PD_GHAZIABAD', 'DS_NCR_PD_HUMAYUNPUR_945',
        'DS_NCR_PD_NANGLOIHUB_935', 'DS_NCR_PD_NOIDAHUB_907', 'DS_NCR_PD_OKHLAHUB_939', 'DS_NCR_PD_CENTRALHUB_908', 'DS_NCR_PD_TRANSPORTNAGAR_934',
        'DS_NCR_PD_WESTHUB_906', 'DS_NCR_PD_GURUGRAM_SARHAULGGN',
    ]],
    ['GGNMWH', 'MWH', ['GGN_WAREHOUSE', 'HYP_B2B_GGN']],
    ['MUMMWH', 'MWH', ['HYP_B2B_MUM2', 'MUM_WAREHOUSE2']],
    ['KOLMWH', 'MWH', ['KOL_WAREHOUSE']],
    ['Return', 'Return', ['Return_MUM2', 'Return_GGN']],
];

const ADDED_30_OCT = ['KOL_WAREHOUSE', 'mCaff_Kolkata3', 'mCaff_Hyderabad3', 'HYP_BYHYD'];

export class FacilityStockBuckets1793500000000 implements MigrationInterface {
    name = 'FacilityStockBuckets1793500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [group, type, codes] of BUCKETS) {
            await queryRunner.query(
                `UPDATE \`master_facilities\` SET \`intransit_group\` = ?, \`intransit_type\` = ?
                 WHERE (\`intransit_group\` IS NULL OR \`intransit_group\` = '') AND \`code\` IN (${codes.map(() => '?').join(', ')})`,
                [group, type, ...codes],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE \`master_facilities\` SET \`intransit_group\` = NULL, \`intransit_type\` = NULL WHERE \`code\` IN (${ADDED_30_OCT.map(() => '?').join(', ')})`,
            ADDED_30_OCT,
        );
    }

}
