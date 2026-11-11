import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import {
  MARGIN_REQUEST_KIND, MARGIN_REQUEST_SOURCE, MARGIN_REQUEST_STATUS, MarginRequestKind, MarginRequestSource, MarginRequestStatus,
} from '../constants/margin-approval';
import { User } from './auth.entities';

/**
 * margin_change_requests (2026-11-06, constants/margin-approval.ts): a channel SKU's margin % / rate after margin
 * change, or a new channel SKU row, waiting for its two approvals (layer 1 Operations Manager, layer 2 Admin; a new row
 * needs only layer 1 since 2026-11-10).
 * master_channel_skus is changed only when layer 2 approves (status applied, in the same transaction, with its
 * master_change_logs rows). Nothing is deleted: a rejected request stays with its reason.
 */
@Entity({ name: TABLES.MARGIN_CHANGE_REQUESTS })
@Index('idx_margin_requests_status', ['status', 'id'])
@Index('idx_margin_requests_sku', ['channelSkuId', 'status'])
export class MarginChangeRequest {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'kind', type: 'enum', enum: Object.values(MARGIN_REQUEST_KIND) })
  kind: MarginRequestKind;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MARGIN_REQUEST_SOURCE) })
  source: MarginRequestSource;

  @Column({ name: 'status', type: 'enum', enum: Object.values(MARGIN_REQUEST_STATUS), default: MARGIN_REQUEST_STATUS.PENDING_L1 })
  status: MarginRequestStatus;

  /** edit: the master_channel_skus row; add: the row made when applied (null before). */
  @Column({ name: 'channel_sku_id', type: 'bigint', nullable: true })
  channelSkuId: string | null;

  @Column({ name: 'channel_id', type: 'int' })
  channelId: number;

  @Column({ name: 'channel_name', type: 'varchar', length: 100 })
  channelName: string;

  @Column({ name: 'channel_code', type: 'varchar', length: 100 })
  channelCode: string;

  @Column({ name: 'pep_code', type: 'varchar', length: 100 })
  pepCode: string;

  /** Margin as stored (fraction of MRP, 0.27); null = not part of this change / not set. */
  @Column({ name: 'old_margin', type: 'decimal', precision: 10, scale: 4, nullable: true })
  oldMargin: string | null;

  @Column({ name: 'new_margin', type: 'decimal', precision: 10, scale: 4, nullable: true })
  newMargin: string | null;

  @Column({ name: 'old_rate', type: 'decimal', precision: 10, scale: 2, nullable: true })
  oldRate: string | null;

  @Column({ name: 'new_rate', type: 'decimal', precision: 10, scale: 2, nullable: true })
  newRate: string | null;

  /** add: the whole checked row (product name, brand, MRP, EAN ...), inserted as it is when applied. */
  @Column({ name: 'payload', type: 'json', nullable: true })
  payload: Record<string, unknown> | null;

  /** Why (the person's remark, or "From PO review: ..."). */
  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  @Column({ name: 'requested_by', type: 'int' })
  requestedBy: number;

  @Column({ name: 'requested_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  requestedAt: Date;

  @Column({ name: 'l1_by', type: 'int', nullable: true })
  l1By: number | null;

  @Column({ name: 'l1_at', type: 'datetime', precision: 6, nullable: true })
  l1At: Date | null;

  @Column({ name: 'l1_remark', type: 'varchar', length: 500, nullable: true })
  l1Remark: string | null;

  @Column({ name: 'l2_by', type: 'int', nullable: true })
  l2By: number | null;

  @Column({ name: 'l2_at', type: 'datetime', precision: 6, nullable: true })
  l2At: Date | null;

  @Column({ name: 'l2_remark', type: 'varchar', length: 500, nullable: true })
  l2Remark: string | null;

  /** Who rejected (at layer 1 or 2) and why. */
  @Column({ name: 'rejected_by', type: 'int', nullable: true })
  rejectedBy: number | null;

  @Column({ name: 'rejected_at', type: 'datetime', precision: 6, nullable: true })
  rejectedAt: Date | null;

  @Column({ name: 'reject_reason', type: 'varchar', length: 500, nullable: true })
  rejectReason: string | null;

  /** fk_margin_requests_requested_by */
  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'requested_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_margin_requests_requested_by' })
  requester: User;
}
