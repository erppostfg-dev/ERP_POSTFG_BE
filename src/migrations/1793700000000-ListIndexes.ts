import { MigrationInterface, QueryRunner } from "typeorm";

/*
 * Load (2026-11-04, user; audit K8 + K9): indexes only, no data changes. The lists and the live "anything new?" check read
 * these columns on every call; without an index each was a full table scan.
 *   po_uploads            (updated_at)                    live check MAX(updated_at)
 *                         (status, completed_at)          Processed list, newest first
 *                         (status, updated_at)            Rejected & Failed lists, newest first
 *                         (status, email_received_at)     In Review / held, by when the email came
 *   po_issues             (upload_id, status)             a PO's open issues
 *   po_review_submissions (type, status, decided_at)      Approvals Approved / Rejected tabs, latest decision first
 *                         (updated_at)                    live check MAX(updated_at)
 * Adding an index on a table this size takes seconds and does not lock reads (InnoDB online DDL). down() drops them.
 */

const INDEXES: [string, string, string][] = [
  ['po_uploads', 'idx_po_uploads_updated', '`updated_at`'],
  ['po_uploads', 'idx_po_uploads_status_completed', '`status`, `completed_at`'],
  ['po_uploads', 'idx_po_uploads_status_updated', '`status`, `updated_at`'],
  ['po_uploads', 'idx_po_uploads_status_received', '`status`, `email_received_at`'],
  ['po_issues', 'idx_po_issues_upload_status', '`upload_id`, `status`'],
  ['po_review_submissions', 'idx_po_review_submissions_decided', '`type`, `status`, `decided_at`'],
  ['po_review_submissions', 'idx_po_review_submissions_updated', '`updated_at`'],
];

export class ListIndexes1793700000000 implements MigrationInterface {
    name = 'ListIndexes1793700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name, cols] of INDEXES) await queryRunner.query(`CREATE INDEX \`${name}\` ON \`${table}\` (${cols})`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, name] of [...INDEXES].reverse()) await queryRunner.query(`DROP INDEX \`${name}\` ON \`${table}\``);
    }

}
