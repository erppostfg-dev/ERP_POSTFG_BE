import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { User } from './auth.entities';
import { MasterPurchaseOrder } from './master-purchase-order.entity';

/**
 * shipment_logs: one row per change of a shipment field (PEPIMS logs, which kept a JSON list per shipment): who changed
 * which field from what to what, and why. Written by the PO Overview edits (not built yet).
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

  /** master_purchase_orders column name (e.g. currentAppointmentDate, facility, poNumber). */
  @Column({ name: 'field_name', type: 'varchar', length: 100 })
  fieldName: string;

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

  /** fk_shipment_logs_user */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_shipment_logs_user' })
  user: User | null;
}
