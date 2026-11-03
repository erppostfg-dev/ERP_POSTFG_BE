import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import {
  REVIEW_SUBMISSION_STATUS,
  REVIEW_SUBMISSION_TYPE,
  ReviewSubmissionStatus,
  ReviewSubmissionType,
  TABLES,
} from '../constants/db';
import { User } from './auth.entities';
import { PoUpload } from './po-upload.entity';

/** What the reviewer fixed, as the approver reads it (old -> new). Stored with the submission, so it never changes. */
export interface ReviewFixes {
  location: { from: string | null; to: string | null } | null;
  lines: { lineNo: string; channelSku: string | null; description: string | null; changes: { field: string; from: unknown; to: unknown }[] }[];
  issues: { issueId: string; type: string; lineNo: string | null; field: string | null; message: string | null; how: 'fixed' | 'accepted'; remark: string | null }[];
  /** Price check (2026-10-30): per decided line + field, ours or the channel's value, and whether the master changes. */
  choices?: { lineNo: string; channelSku: string | null; description: string | null; field: string; from: string; ours: number; channel: number; updateMaster: boolean }[];
}

/**
 * po_review_submissions (2026-10-15, user): every decision on a PO in review, one row per round.
 *   type approval:        the reviewer fixed every issue and submitted it (status pending); an approver approves it (the PO
 *                         is created: po_uid, sale_order_code) or rejects it with a reason. If the PO no longer passes the
 *                         checks when approved, the row becomes `returned` and the PO goes back to In Review by itself.
 *   type reviewer_reject: the reviewer rejected the PO directly from PO Review (who, when, why), so rejected POs can be
 *                         listed later.
 * `changes` = the request body as sent (replayed at approval); `fixes` = old -> new for the Approvals screen.
 */
@Entity({ name: TABLES.PO_REVIEW_SUBMISSIONS })
@Index('idx_po_review_submissions_list', ['type', 'status', 'submittedAt'])
@Index('idx_po_review_submissions_upload', ['uploadId', 'id'])
export class PoReviewSubmission {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  @Column({ name: 'type', type: 'enum', enum: Object.values(REVIEW_SUBMISSION_TYPE) })
  type: ReviewSubmissionType;

  @Column({ name: 'status', type: 'enum', enum: Object.values(REVIEW_SUBMISSION_STATUS), default: REVIEW_SUBMISSION_STATUS.PENDING })
  status: ReviewSubmissionStatus;

  /** Copied from the upload, for the list and search. */
  @Column({ name: 'po_number', type: 'varchar', length: 255, nullable: true })
  poNumber: string | null;

  @Column({ name: 'channel', type: 'varchar', length: 100, nullable: true })
  channel: string | null;

  /** The reviewer's corrections as sent (location, lines, accepted issues); null for a reject. */
  @Column({ name: 'changes', type: 'json', nullable: true })
  changes: Record<string, unknown> | null;

  /** Old -> new per field and how each issue was resolved; null for a reject. */
  @Column({ name: 'fixes', type: 'json', nullable: true })
  fixes: ReviewFixes | null;

  @Column({ name: 'submitted_by', type: 'int', nullable: true })
  submittedBy: number | null;

  @Column({ name: 'submitted_at', type: 'datetime' })
  submittedAt: Date;

  @Column({ name: 'submit_remark', type: 'varchar', length: 500, nullable: true })
  submitRemark: string | null;

  /** Approver (or the reviewer for a direct reject); null while pending or when the system returned it. */
  @Column({ name: 'decided_by', type: 'int', nullable: true })
  decidedBy: number | null;

  @Column({ name: 'decided_at', type: 'datetime', nullable: true })
  decidedAt: Date | null;

  /** Why it was rejected (required), the approver's note, or why the system returned it. */
  @Column({ name: 'decision_remark', type: 'varchar', length: 500, nullable: true })
  decisionRemark: string | null;

  /** The PO created on approval (master_purchase_orders.uid) and its sale order code. */
  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  @Column({ name: 'sale_order_code', type: 'varchar', length: 50, nullable: true })
  saleOrderCode: string | null;

  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', update: false })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP', update: false })
  updatedAt: Date;

  /** fk_po_review_submissions_upload */
  @ManyToOne(() => PoUpload, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'upload_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_review_submissions_upload' })
  upload: PoUpload;

  /** fk_po_review_submissions_submitted_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'submitted_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_review_submissions_submitted_by' })
  submitter: User | null;

  /** fk_po_review_submissions_decided_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'decided_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_review_submissions_decided_by' })
  decider: User | null;
}
