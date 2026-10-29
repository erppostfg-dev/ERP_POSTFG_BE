import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_LOG_ACTION, MASTER_LOG_SOURCE, MASTER_LOG_TYPE, MasterLogAction, MasterLogSource, MasterLogType, TABLES } from '../constants/db';
import { User } from './auth.entities';

/**
 * master_change_logs (2026-10-28): everything done to a row of the 5 Masters tabs (PEP SKUs, channel SKUs, channels,
 * channel locations, facilities), with who did it, read by the row's History button. One row per changed field, or
 * one row for an action (created, deactivated, activated, a whole master replaced). batch_id groups the rows of one
 * save. Written in the same transaction as the change itself: no change without its log. The in-transit master
 * uploads keep their own log (intransit_master_changes); History reads both.
 */
@Entity({ name: TABLES.MASTER_CHANGE_LOGS })
@Index('idx_master_change_logs_row', ['masterType', 'recordId', 'id'])
@Index('idx_master_change_logs_created', ['createdAt'])
export class MasterChangeLog {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'master_type', type: 'enum', enum: Object.values(MASTER_LOG_TYPE) })
  masterType: MasterLogType;

  /** The row's id in its own table (master_skus.id, details_channels.id, ...); null for a whole master replaced. */
  @Column({ name: 'record_id', type: 'bigint', nullable: true })
  recordId: string | null;

  /** What the row is to people at the time: the PEP code, "Nykaa | 10149354", "Blinkit | DC code", the facility code. */
  @Column({ name: 'row_key', type: 'varchar', length: 255 })
  rowKey: string;

  @Column({ name: 'action', type: 'enum', enum: Object.values(MASTER_LOG_ACTION) })
  action: MasterLogAction;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_LOG_SOURCE) })
  source: MasterLogSource;

  /** The column changed (DB name, e.g. mrp, facility_code); null for an action. */
  @Column({ name: 'field_name', type: 'varchar', length: 100, nullable: true })
  fieldName: string | null;

  @Column({ name: 'old_value', type: 'text', nullable: true })
  oldValue: string | null;

  @Column({ name: 'new_value', type: 'text', nullable: true })
  newValue: string | null;

  /** The optional remark typed on the save. */
  @Column({ name: 'remark', type: 'text', nullable: true })
  remark: string | null;

  /** Same value on every row of one save (a UUID). */
  @Column({ name: 'batch_id', type: 'char', length: 36 })
  batchId: string;

  /** users.id; null for a script run without --by. */
  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** fk_master_change_logs_user */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_master_change_logs_user' })
  user: User | null;
}
