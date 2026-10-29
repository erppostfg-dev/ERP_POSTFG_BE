import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * po_uploads.po_date (2026-10-29, user: PO Date on the In Review tab): the PO's own date as read from the PO, written
 * by the chain every time it checks a PO. Existing rows stay NULL until `npm run po:po-date-fill -- --apply` (reads
 * each row's processed.json from S3 once). down() drops the column.
 */

export class UploadPoDate1793260000000 implements MigrationInterface {
    name = 'UploadPoDate1793260000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`po_date\` date NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`po_date\``);
    }

}
