import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Uniware hand-off (2026-10-19, user): a completed PO waits on the Processed tab until its sale order CSV is downloaded
 * and then marked uploaded into Uniware; only then does it show in PO Overview.
 *   po_uploads + csv_downloaded_at / csv_downloaded_by (first download) + uniware_uploaded_at / uniware_uploaded_by
 *   (the mark), FKs to users. All NULL for existing rows: every PO done so far counts as NOT downloaded (user), so
 *   they leave PO Overview until someone downloads + marks them.
 *   shipment_logs.action + uniware_uploaded / uniware_upload_undone (CHANGEd in place, values kept).
 * Generated. down(): fails while a shipment_logs row uses one of the two new actions (delete those rows first).
 */

export class UniwareHandoff1792390590579 implements MigrationInterface {
    name = 'UniwareHandoff1792390590579'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`csv_downloaded_at\` datetime NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`csv_downloaded_by\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`uniware_uploaded_at\` datetime NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD \`uniware_uploaded_by\` int NULL`);
        await queryRunner.query(`ALTER TABLE \`shipment_logs\` CHANGE \`action\` \`action\` enum ('created', 'field_changed', 'bulk_update', 'line_qty_requested', 'line_qty_approved', 'line_qty_rejected', 'uniware_uploaded', 'uniware_upload_undone') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD CONSTRAINT \`fk_po_uploads_csv_downloaded_by\` FOREIGN KEY (\`csv_downloaded_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` ADD CONSTRAINT \`fk_po_uploads_uniware_uploaded_by\` FOREIGN KEY (\`uniware_uploaded_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP FOREIGN KEY \`fk_po_uploads_uniware_uploaded_by\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP FOREIGN KEY \`fk_po_uploads_csv_downloaded_by\``);
        await queryRunner.query(`ALTER TABLE \`shipment_logs\` CHANGE \`action\` \`action\` enum ('created', 'field_changed', 'bulk_update', 'line_qty_requested', 'line_qty_approved', 'line_qty_rejected') NOT NULL`);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`uniware_uploaded_by\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`uniware_uploaded_at\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`csv_downloaded_by\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` DROP COLUMN \`csv_downloaded_at\``);
    }

}
