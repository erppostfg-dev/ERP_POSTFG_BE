import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants';

/**
 * po_reopens (2026-11-03, user): a REJECTED PO sent back to In Review by someone with PO review edit rights, to be fixed
 * like any PO in review and submitted for approval again (any number of times). One row per reopen, with the rejection
 * it undid (copied: who / when / why / where), so the history stays readable. No foreign keys: history is never lost.
 */
@Entity({ name: TABLES.PO_REOPENS })
@Index('idx_po_reopens_upload', ['uploadId', 'id'])
export class PoReopen {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  /** Why it is tried again (required). */
  @Column({ name: 'remark', type: 'varchar', length: 500 })
  remark: string;

  @Column({ name: 'reopened_by', type: 'int' })
  reopenedBy: number;

  @Column({ name: 'reopened_at', type: 'datetime' })
  reopenedAt: Date;

  /** The rejection it undid: its reason, where (review = the reviewer, approval = the approver), who and when. */
  @Column({ name: 'rejected_reason', type: 'varchar', length: 500, nullable: true })
  rejectedReason: string | null;

  @Column({ name: 'rejected_from', type: 'varchar', length: 20, nullable: true })
  rejectedFrom: string | null;

  @Column({ name: 'rejected_by', type: 'int', nullable: true })
  rejectedBy: number | null;

  @Column({ name: 'rejected_at', type: 'datetime', nullable: true })
  rejectedAt: Date | null;

  /** po_review_submissions.id of that rejection (null when the row was rejected before submissions were kept). */
  @Column({ name: 'rejected_submission_id', type: 'bigint', nullable: true })
  rejectedSubmissionId: string | null;
}
