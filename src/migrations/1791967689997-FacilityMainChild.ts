import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Main and child warehouses (2026-10-14): upper and lower case are DIFFERENT facilities (capitals = the main warehouse,
 * lower / mixed case = its child, e.g. MUM_WAREHOUSE2 / MUM_Warehouse2; user).
 *   master_facilities.code -> utf8mb4_bin (case-sensitive; its unique index uq_master_facilities_code then allows both
 *     spellings). HAND-ADDED: migration:generate does not see a collation change. MODIFY keeps every value.
 *   + parent_facility_id (the main warehouse of a child, FK to master_facilities.id, ON DELETE RESTRICT). Generated.
 * down(): back to the case-insensitive collation; it fails while two codes differ only in case (remove one first).
 */
export class FacilityMainChild1791967689997 implements MigrationInterface {
    name = 'FacilityMainChild1791967689997'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_facilities\` MODIFY \`code\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD \`parent_facility_id\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` ADD CONSTRAINT \`fk_master_facilities_parent\` FOREIGN KEY (\`parent_facility_id\`) REFERENCES \`master_facilities\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP FOREIGN KEY \`fk_master_facilities_parent\``);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` DROP COLUMN \`parent_facility_id\``);
        await queryRunner.query(`ALTER TABLE \`master_facilities\` MODIFY \`code\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL`);
    }

}
