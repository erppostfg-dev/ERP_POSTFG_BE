import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * PO review approvals (2026-10-15, user): po_review_submissions (one row per approval round or reviewer reject: who
 * submitted, the fixes, who decided, when, why, the PO and sale order created) and po_uploads.status + pending_approval.
 * The status column is CHANGEd in place (existing values kept); its index is dropped and re-created by TypeORM.
 * down: fails while a po_uploads row is pending_approval (strict mode); approve / reject those first.
 */

export class PoReviewApprovals1792044556718 implements MigrationInterface {
    name = 'PoReviewApprovals1792044556718'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`po_review_submissions\` (\`id\` bigint NOT NULL AUTO_INCREMENT, \`upload_id\` bigint NOT NULL, \`type\` enum ('approval', 'reviewer_reject') NOT NULL, \`status\` enum ('pending', 'approved', 'rejected', 'returned') NOT NULL DEFAULT 'pending', \`po_number\` varchar(255) NULL, \`channel\` varchar(100) NULL, \`changes\` json NULL, \`fixes\` json NULL, \`submitted_by\` int NULL, \`submitted_at\` datetime NOT NULL, \`submit_remark\` varchar(500) NULL, \`decided_by\` int NULL, \`decided_at\` datetime NULL, \`decision_remark\` varchar(500) NULL, \`po_uid\` bigint NULL, \`sale_order_code\` varchar(50) NULL, \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX \`idx_po_review_submissions_upload\` (\`upload_id\`, \`id\`), INDEX \`idx_po_review_submissions_list\` (\`type\`, \`status\`, \`submitted_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`DROP INDEX \`idx_po_uploads_status\` ON \`po_uploads\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` CHANGE \`status\` \`status\` enum ('queued', 'extracting', 'needs_review', 'pending_approval', 'processing', 'completed', 'rejected', 'failed') NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`CREATE INDEX \`idx_po_uploads_status\` ON \`po_uploads\` (\`status\`, \`created_at\`)`);
        await queryRunner.query(`ALTER TABLE \`po_review_submissions\` ADD CONSTRAINT \`fk_po_review_submissions_upload\` FOREIGN KEY (\`upload_id\`) REFERENCES \`po_uploads\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`po_review_submissions\` ADD CONSTRAINT \`fk_po_review_submissions_submitted_by\` FOREIGN KEY (\`submitted_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE \`po_review_submissions\` ADD CONSTRAINT \`fk_po_review_submissions_decided_by\` FOREIGN KEY (\`decided_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`po_review_submissions\` DROP FOREIGN KEY \`fk_po_review_submissions_decided_by\``);
        await queryRunner.query(`ALTER TABLE \`po_review_submissions\` DROP FOREIGN KEY \`fk_po_review_submissions_submitted_by\``);
        await queryRunner.query(`ALTER TABLE \`po_review_submissions\` DROP FOREIGN KEY \`fk_po_review_submissions_upload\``);
        await queryRunner.query(`DROP INDEX \`idx_po_uploads_status\` ON \`po_uploads\``);
        await queryRunner.query(`ALTER TABLE \`po_uploads\` CHANGE \`status\` \`status\` enum ('queued', 'extracting', 'needs_review', 'processing', 'completed', 'rejected', 'failed') NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`CREATE INDEX \`idx_po_uploads_status\` ON \`po_uploads\` (\`status\`, \`created_at\`)`);
        await queryRunner.query(`DROP INDEX \`idx_po_review_submissions_list\` ON \`po_review_submissions\``);
        await queryRunner.query(`DROP INDEX \`idx_po_review_submissions_upload\` ON \`po_review_submissions\``);
        await queryRunner.query(`DROP TABLE \`po_review_submissions\``);
    }

}
