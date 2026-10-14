import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_SOURCE, MasterSource, STATUS_STAGE, StatusStage, TABLES } from '../constants/db';

/**
 * master_shipment_statuses: the values each status column of master_purchase_orders may hold (PEPIMS
 * master_status_*_options). The same value can be in several stages ("Confirmed" is in all three), so the key is
 * stage + value. The PO's status columns stay text; the API checks them against this table.
 */
@Entity({ name: TABLES.MASTER_SHIPMENT_STATUSES })
@Index('uq_master_shipment_statuses_stage_value', ['stage', 'value'], { unique: true })
export class MasterShipmentStatus {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'stage', type: 'enum', enum: Object.values(STATUS_STAGE) })
  stage: StatusStage;

  @Column({ name: 'value', type: 'varchar', length: 100 })
  value: string;

  /** Dropdown order. */
  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_SOURCE), default: MASTER_SOURCE.MANUAL })
  source: MasterSource;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
