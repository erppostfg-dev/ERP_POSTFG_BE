import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { PRICE_DIFF_FIELD, PriceDiffField } from '../constants/price-differences';

/**
 * po_price_differences (2026-10-30, user): one row per approved PO line where the reviewer kept OUR price / MRP although
 * the channel's PO said otherwise (price check in PO review). The Price differences tab lists them per PO and per
 * channel with an email draft to tell the channel; sent_at / sent_by / sent_batch = marked as sent (one batch = one
 * email). Written in the approval's transaction; never deleted.
 */
@Entity({ name: TABLES.PO_PRICE_DIFFERENCES })
@Index('idx_po_price_differences_channel', ['channel', 'sentAt', 'approvedAt'])
@Index('idx_po_price_differences_upload', ['uploadId'])
export class PoPriceDifference {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  /** po_review_submissions.id of the approval. */
  @Column({ name: 'submission_id', type: 'bigint', nullable: true })
  submissionId: string | null;

  /** master_purchase_orders.uid of the saved PO. */
  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  @Column({ name: 'po_number', type: 'varchar', length: 100 })
  poNumber: string;

  @Column({ name: 'po_date', type: 'date', nullable: true })
  poDate: string | null;

  /** master_channels.display_name. */
  @Column({ name: 'channel', type: 'varchar', length: 100 })
  channel: string;

  @Column({ name: 'line_no', type: 'varchar', length: 20 })
  lineNo: string;

  @Column({ name: 'channel_sku_code', type: 'varchar', length: 100, default: '' })
  channelSkuCode: string;

  @Column({ name: 'pep_code', type: 'varchar', length: 100, default: '' })
  pepCode: string;

  @Column({ name: 'product_name', type: 'varchar', length: 255, default: '' })
  productName: string;

  @Column({ name: 'field', type: 'enum', enum: Object.values(PRICE_DIFF_FIELD) })
  field: PriceDiffField;

  /** Charged qty of the line. */
  @Column({ name: 'qty', type: 'decimal', precision: 12, scale: 2, nullable: true })
  qty: string | null;

  /** What the channel's PO said (price with tax / MRP). */
  @Column({ name: 'po_value', type: 'decimal', precision: 12, scale: 2 })
  poValue: string;

  /** Our master value the sale order used. */
  @Column({ name: 'our_value', type: 'decimal', precision: 12, scale: 2 })
  ourValue: string;

  /** po_value - our_value. */
  @Column({ name: 'difference', type: 'decimal', precision: 12, scale: 2 })
  difference: string;

  /** users.id of the reviewer who chose ours / of the approver. */
  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy: number | null;

  @Column({ name: 'approved_by', type: 'int', nullable: true })
  approvedBy: number | null;

  @Column({ name: 'approved_at', type: 'datetime' })
  approvedAt: Date;

  /** Marked as sent to the channel (by hand for now): when, who, and one id per email. */
  @Column({ name: 'sent_at', type: 'datetime', nullable: true })
  sentAt: Date | null;

  @Column({ name: 'sent_by', type: 'int', nullable: true })
  sentBy: number | null;

  @Column({ name: 'sent_batch', type: 'varchar', length: 40, nullable: true })
  sentBatch: string | null;
}
