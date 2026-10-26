import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { MASTER_CHANGE_ACTION, MASTER_CHANGE_SOURCE, MasterChangeAction, MasterChangeSource } from '../constants/intransit';

/**
 * intransit_master_changes (2026-10-25, user: "a change log in the DB"): one row per value an in-transit master gained
 * or changed in the database - from an uploaded master file, a combo added on the page, a variant mapped to its base,
 * or the first full load. Uploads only add and update (user), so there is no "removed" action.
 */
@Entity({ name: TABLES.INTRANSIT_MASTER_CHANGES })
@Index('idx_intransit_master_changes_master', ['master', 'changedAt'])
@Index('idx_intransit_master_changes_row', ['rowKey'])
export class IntransitMasterChange {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** The master as the page names it ("Split1", "Final SKU Mapping", "Location Master" ...). */
  @Column({ name: 'master', type: 'varchar', length: 40 })
  master: string;

  /** The table changed (master_skus, master_sku_components, details_channels, intransit_channel_sku_map, ...). */
  @Column({ name: 'table_name', type: 'varchar', length: 64 })
  tableName: string;

  /** What the row is to people: the SKU, "combo > part", "channel | code" ... */
  @Column({ name: 'row_key', type: 'varchar', length: 255 })
  rowKey: string;

  /** The column changed; null for a whole row added. */
  @Column({ name: 'field', type: 'varchar', length: 64, nullable: true })
  field: string | null;

  @Column({ name: 'old_value', type: 'text', nullable: true })
  oldValue: string | null;

  @Column({ name: 'new_value', type: 'text', nullable: true })
  newValue: string | null;

  @Column({ name: 'action', type: 'enum', enum: Object.values(MASTER_CHANGE_ACTION) })
  action: MasterChangeAction;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_CHANGE_SOURCE) })
  source: MasterChangeSource;

  /** The uploaded file kept in S3 (its key under Masters/Imports/), for an upload. */
  @Column({ name: 'import_key', type: 'varchar', length: 600, nullable: true })
  importKey: string | null;

  @Column({ name: 'changed_by', type: 'int', nullable: true })
  changedBy: number | null;

  @Column({ name: 'changed_by_name', type: 'varchar', length: 255, nullable: true })
  changedByName: string | null;

  @Column({ name: 'host', type: 'varchar', length: 64 })
  host: string;

  @Column({ name: 'changed_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  changedAt: Date;
}
