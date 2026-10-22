import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { PO_VERIFY_ACTION, PoVerifyAction, TABLES } from '../constants';
import { User } from './auth.entities';
import { PoUpload } from './po-upload.entity';

/**
 * po_verifications (2026-10-22, user): every check of a processed PO against its original, one row per action.
 *   verified:  the person found the saved PO right; its Uniware CSV is unlocked.
 *   sent_back: something was wrong; the saved PO (po_uid, sale order) is cancelled and the PO went back to In Review.
 * A PO is verified when its CURRENT po_uid has a `verified` row: after a send-back and a new approval it has a new
 * po_uid and must be checked again. Its own table (no column added elsewhere), so the step can be removed later.
 */
@Entity({ name: TABLES.PO_VERIFICATIONS })
@Index('idx_po_verifications_upload', ['uploadId', 'id'])
@Index('idx_po_verifications_po', ['poUid', 'action'])
export class PoVerification {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  /** The saved PO that was checked (master_purchase_orders.uid); no foreign key, so history stays whatever happens to it. */
  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  @Column({ name: 'sale_order_code', type: 'varchar', length: 50, nullable: true })
  saleOrderCode: string | null;

  @Column({ name: 'action', type: 'enum', enum: Object.values(PO_VERIFY_ACTION) })
  action: PoVerifyAction;

  /** Required for a send-back (what was wrong); optional note for a verify. */
  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  /** Lines the person ticked as checked, of how many (for the record). */
  @Column({ name: 'lines_checked', type: 'int', nullable: true })
  linesChecked: number | null;

  @Column({ name: 'line_count', type: 'int', nullable: true })
  lineCount: number | null;

  @Column({ name: 'done_by', type: 'int' })
  doneBy: number;

  @Column({ name: 'done_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  doneAt: Date;

  @ManyToOne(() => PoUpload, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'upload_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_verifications_upload' })
  upload?: PoUpload;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'done_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_verifications_user' })
  user?: User;
}
