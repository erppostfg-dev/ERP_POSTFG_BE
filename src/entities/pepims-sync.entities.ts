import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { DetailsPurchaseOrder } from './details-purchase-order.entity';
import { MasterPurchaseOrder } from './master-purchase-order.entity';

/*
 * PEPIMS -> prod migration + sync (2026-11-16, user: "keep both in sync for a few days, the newest change wins"):
 * one row per PO / line that exists in both PEPIMS (mcaff_inv.shipment_orders / sku_orders) and our tables. An imported
 * PO keeps its PEPIMS uid, but a PO made on our side later gets its own PEPIMS uid when the sync writes it there, so
 * the pair is kept here, never guessed. syncedValues = the field values both sides had at the last sync: a field that
 * differs from it on one side was changed there (the other side takes it); changed on both = the newer change wins.
 */

@Entity({ name: TABLES.PEPIMS_SYNC_LINKS })
@Index('uq_pepims_sync_links_po', ['poUid'], { unique: true })
@Index('uq_pepims_sync_links_pepims', ['pepimsUid'], { unique: true })
export class PepimsSyncLink {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** master_purchase_orders.uid */
  @Column({ name: 'po_uid', type: 'bigint' })
  poUid: string;

  /** mcaff_inv.shipment_orders.uid */
  @Column({ name: 'pepims_uid', type: 'int' })
  pepimsUid: number;

  /** { field: value } of both sides at the last sync. */
  @Column({ name: 'synced_values', type: 'json', nullable: true })
  syncedValues: Record<string, unknown> | null;

  /** shipment_orders.updatedAt when it was last read (rows not changed since are skipped). */
  @Column({ name: 'pepims_updated_at', type: 'datetime', nullable: true })
  pepimsUpdatedAt: Date | null;

  @Column({ name: 'synced_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  syncedAt: Date;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** fk_pepims_sync_links_po: a linked PO cannot be deleted. */
  @ManyToOne(() => MasterPurchaseOrder, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'po_uid', referencedColumnName: 'uid', foreignKeyConstraintName: 'fk_pepims_sync_links_po' })
  po: MasterPurchaseOrder;
}

@Entity({ name: TABLES.PEPIMS_SYNC_LINE_LINKS })
@Index('uq_pepims_sync_line_links_line', ['lineId'], { unique: true })
@Index('uq_pepims_sync_line_links_pepims', ['pepimsLineId'], { unique: true })
@Index('idx_pepims_sync_line_links_po', ['poUid'])
export class PepimsSyncLineLink {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** details_purchase_orders.id */
  @Column({ name: 'line_id', type: 'bigint' })
  lineId: string;

  /** mcaff_inv.sku_orders.id */
  @Column({ name: 'pepims_line_id', type: 'int' })
  pepimsLineId: number;

  /** The line's PO (master_purchase_orders.uid), to read a PO's lines in one query. */
  @Column({ name: 'po_uid', type: 'bigint' })
  poUid: string;

  @Column({ name: 'synced_values', type: 'json', nullable: true })
  syncedValues: Record<string, unknown> | null;

  @Column({ name: 'synced_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  syncedAt: Date;

  /** fk_pepims_sync_line_links_line */
  @ManyToOne(() => DetailsPurchaseOrder, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'line_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_pepims_sync_line_links_line' })
  line: DetailsPurchaseOrder;
}
