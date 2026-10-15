import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE, ShipmentLogAction, ShipmentLogSource, TABLES } from '../constants/db';
import { User } from './auth.entities';
import { DetailsPurchaseOrder } from './details-purchase-order.entity';
import { MasterPurchaseOrder } from './master-purchase-order.entity';

/**
 * shipment_logs: everything done to a shipment, with who did it (PEPIMS kept a JSON list per shipment): one row per
 * changed field (field_changed), or one row for an action (created, line quantity requested / approved / rejected).
 * batch_id groups the rows of one save or one bulk upload. Written in the same transaction as the change itself.
 * Views are not logged (user, 2026-10-14); exports go to activity_log.
 */
@Entity({ name: TABLES.SHIPMENT_LOGS })
@Index('idx_shipment_logs_shipment', ['shipmentUid', 'id'])
export class ShipmentLog {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'shipment_uid', type: 'bigint' })
  shipmentUid: string;

  /** users.id; null for changes the app makes by itself. */
  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'action', type: 'enum', enum: Object.values(SHIPMENT_LOG_ACTION) })
  action: ShipmentLogAction;

  @Column({ name: 'source', type: 'enum', enum: Object.values(SHIPMENT_LOG_SOURCE) })
  source: ShipmentLogSource;

  /** master_purchase_orders column name (e.g. currentAppointmentDate, facility, poNumber); null for an action. */
  @Column({ name: 'field_name', type: 'varchar', length: 100, nullable: true })
  fieldName: string | null;

  /** details_purchase_orders.id for a line action (quantity). */
  @Column({ name: 'line_id', type: 'bigint', nullable: true })
  lineId: string | null;

  /** Same value on every row of one save / one bulk upload (a UUID). */
  @Column({ name: 'batch_id', type: 'char', length: 36, nullable: true })
  batchId: string | null;

  @Column({ name: 'old_value', type: 'text', nullable: true })
  oldValue: string | null;

  @Column({ name: 'new_value', type: 'text', nullable: true })
  newValue: string | null;

  @Column({ name: 'remark', type: 'text', nullable: true })
  remark: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** fk_shipment_logs_shipment: a shipment with history cannot be deleted. */
  @ManyToOne(() => MasterPurchaseOrder, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_uid', referencedColumnName: 'uid', foreignKeyConstraintName: 'fk_shipment_logs_shipment' })
  shipment: MasterPurchaseOrder;

  /** fk_shipment_logs_line */
  @ManyToOne(() => DetailsPurchaseOrder, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'line_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_shipment_logs_line' })
  line: DetailsPurchaseOrder | null;

  /** fk_shipment_logs_user */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_shipment_logs_user' })
  user: User | null;
}
