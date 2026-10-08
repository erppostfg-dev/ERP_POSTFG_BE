import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ISSUE_STATUS, ISSUE_TYPE, IssueStatus, IssueType, TABLES } from '../constants/db';
import type { PoIssueAction } from './po-issue-action.entity';
import { PoUpload } from './po-upload.entity';

/** po_issues: every problem found while reading or checking an upload, before the PO is saved. */
@Entity({ name: TABLES.PO_ISSUES })
@Index('idx_po_issues_open', ['status', 'issueType'])
export class PoIssue {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** po_uploads.id. */
  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  /** OCR line (srNo); null for header-level issues. */
  @Column({ name: 'line_no', type: 'int', nullable: true })
  lineNo: number | null;

  @Column({ name: 'issue_type', type: 'enum', enum: Object.values(ISSUE_TYPE) })
  issueType: IssueType;

  /** Which field is wrong, e.g. channelSkuCode. */
  @Column({ name: 'field_name', type: 'varchar', length: 100, nullable: true })
  fieldName: string | null;

  /** Readable message for the approver. */
  @Column({ name: 'details', type: 'varchar', length: 500, nullable: true })
  details: string | null;

  /** What the OCR gave. */
  @Column({ name: 'original_values', type: 'json', nullable: true })
  originalValues: Record<string, unknown> | null;

  /** What the approver changed it to. */
  @Column({ name: 'resolved_values', type: 'json', nullable: true })
  resolvedValues: Record<string, unknown> | null;

  /** On approve, also write the fix into the master table. */
  @Column({ name: 'save_as_master', type: 'boolean', default: false })
  saveAsMaster: boolean;

  @Column({ name: 'status', type: 'enum', enum: Object.values(ISSUE_STATUS), default: ISSUE_STATUS.OPEN })
  status: IssueStatus;

  @Column({ name: 'resolved_by', type: 'varchar', length: 255, nullable: true })
  resolvedBy: string | null;

  @Column({ name: 'resolved_at', type: 'datetime', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  /** Set by MySQL (DEFAULT CURRENT_TIMESTAMP); plain datetime in the live table. */
  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', update: false })
  createdAt: Date;

  /** fk_po_issues_upload: upload_id -> po_uploads.id (ON DELETE CASCADE). */
  @ManyToOne(() => PoUpload, (upload) => upload.issues, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'upload_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_issues_upload' })
  upload: PoUpload;

  @OneToMany('PoIssueAction', (action: PoIssueAction) => action.issue)
  actions: PoIssueAction[];
}
