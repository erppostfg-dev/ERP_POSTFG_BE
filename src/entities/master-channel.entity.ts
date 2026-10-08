import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';

/**
 * master_channels: the list of sales channels (was Stash channel_master).
 * display_name is the exact channel name every other table's channel column uses (they reference it).
 * slug is the short code used by the software (e.g. blinkit).
 * Matches the LIVE table (checked 2026-10-08): no color / sort_order columns (they are only in final_schema.sql).
 */
@Entity({ name: TABLES.MASTER_CHANNELS })
@Index('slug', ['slug'], { unique: true })
@Index('display_name', ['displayName'], { unique: true })
export class MasterChannel {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'slug', type: 'varchar', length: 50 })
  slug: string;

  @Column({ name: 'display_name', type: 'varchar', length: 100 })
  displayName: string;

  /** Other spellings of the name, e.g. ["blinkit", "Blinkit"]. */
  @Column({ name: 'db_aliases', type: 'json', nullable: true })
  dbAliases: string[] | null;

  @Column({ name: 'has_processor', type: 'boolean', default: false })
  hasProcessor: boolean;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;
}
