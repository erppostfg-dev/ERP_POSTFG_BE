import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_SOURCE, MasterSource, TABLES } from '../constants/db';

/**
 * master_final_status_map: planning + warehouse + logistics status -> the Final Status the PO Overview shows (PEPIMS
 * status_masters). A combination not listed has no final status ("No mapping available" in PEPIMS).
 */
@Entity({ name: TABLES.MASTER_FINAL_STATUS_MAP })
@Index('uq_master_final_status_map_stages', ['statusPlanning', 'statusWarehouse', 'statusLogistics'], { unique: true })
export class MasterFinalStatusMap {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'status_planning', type: 'varchar', length: 100 })
  statusPlanning: string;

  @Column({ name: 'status_warehouse', type: 'varchar', length: 100 })
  statusWarehouse: string;

  @Column({ name: 'status_logistics', type: 'varchar', length: 100 })
  statusLogistics: string;

  @Column({ name: 'status_final', type: 'varchar', length: 100 })
  statusFinal: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_SOURCE), default: MASTER_SOURCE.MANUAL })
  source: MasterSource;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
