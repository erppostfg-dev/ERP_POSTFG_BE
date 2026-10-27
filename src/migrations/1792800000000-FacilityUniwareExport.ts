import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Uniware export list in the database (2026-10-26, user): master_facilities gains `uniware_export` (yes/no): the
 * facilities the in-transit Uniware fetch exports, once each. Switched on for the 46 codes UNIWARE_FACILITY listed in
 * .env that day (all present and active in master_facilities, same spelling); the .env list is then no longer needed.
 * Stock counting is not affected (that is intransit_group). down() drops the column.
 */

const EXPORTED = [
    'HYP_SRGGN', 'HYP_SRKOL', 'mCaff_Mumbai2', 'mCaff_Gurgaon2', 'mCaff_Bangalore2', 'mCaff_Kolkata2', 'mCaff_Ahmedabad', 'mCaff_Hyderabad2',
    'mCaff_Guwahati', 'HYP_SRBGLR', 'HYP_AHMD', 'HYP_SRHYD', 'HYP_SRGWHT', 'HYP_SRLOK', 'mCaff_Gurgaon3', 'mCaff_Lucknow3', 'HYP_SRLOK2',
    'HYP_DLNAG', 'HYP_DLGWHT', 'mCaff_Lucknow2', 'Mcaff_Nagpur', 'mCaff_Guwahati2', 'HYP_SPCHN', 'Mcaff_Chennai',
    'DS_NCR_PD_MOTHERHUB', 'DS_NCR_PD_EASTDELHI_931', 'DS_NCR_PD_FARIDABAD', 'DS_NCR_PD_GHAZIABAD', 'DS_NCR_PD_HUMAYUNPUR_945',
    'DS_NCR_PD_NANGLOIHUB_935', 'DS_NCR_PD_NOIDAHUB_907', 'DS_NCR_PD_OKHLAHUB_939', 'DS_NCR_PD_CENTRALHUB_908', 'DS_NCR_PD_TRANSPORTNAGAR_934',
    'DS_NCR_PD_WESTHUB_906', 'DS_NCR_PD_GURUGRAM_SARHAULGGN',
    'GGN_WAREHOUSE', 'HYP_B2B_GGN', 'HYP_B2B_MUM2', 'MUM_WAREHOUSE2', 'Return_MUM2', 'Return_GGN',
    'KOL_WAREHOUSE', 'mCaff_Kolkata3', 'mCaff_Hyderabad3', 'HYP_BYHYD',
];

export class FacilityUniwareExport1792800000000 implements MigrationInterface {
    name = 'FacilityUniwareExport1792800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`uniware_export\` tinyint NOT NULL DEFAULT 0`);
        await queryRunner.query(`UPDATE \`master_facilities\` SET \`uniware_export\` = 1 WHERE \`code\` IN (${EXPORTED.map(() => '?').join(', ')})`, EXPORTED);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`uniware_export\``);
    }

}
