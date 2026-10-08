import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { ISSUE_ACTION, IssueAction, TABLES } from '../constants/db';
import { PoIssue } from './po-issue.entity';

/** po_issue_actions: the history of each issue (who assigned, commented, approved, rejected or reopened it). */
@Entity({ name: TABLES.PO_ISSUE_ACTIONS })
@Index('idx_po_issue_actions_issue', ['issueId', 'createdAt'])
export class PoIssueAction {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** po_issues.id. */
  @Column({ name: 'issue_id', type: 'bigint' })
  issueId: string;

  @Column({ name: 'action', type: 'enum', enum: Object.values(ISSUE_ACTION) })
  action: IssueAction;

  /** User email; null for actions taken by the system. */
  @Column({ name: 'action_by', type: 'varchar', length: 255, nullable: true })
  actionBy: string | null;

  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  @Column({ name: 'before_value', type: 'json', nullable: true })
  beforeValue: Record<string, unknown> | null;

  @Column({ name: 'after_value', type: 'json', nullable: true })
  afterValue: Record<string, unknown> | null;

  /** Set by MySQL (DEFAULT CURRENT_TIMESTAMP); plain datetime in the live table. */
  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', update: false })
  createdAt: Date;

  /** fk_po_issue_actions_issue: issue_id -> po_issues.id (ON DELETE CASCADE). */
  @ManyToOne(() => PoIssue, (issue) => issue.actions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'issue_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_issue_actions_issue' })
  issue: PoIssue;
}
