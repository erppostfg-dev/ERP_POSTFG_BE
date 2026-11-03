import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';

/**
 * channel_pull_items (2026-10-30): one row per thing a channel robot fetched (Flipkart: one scheduled consignment), from
 * the robot run until it became a PO. The connector reads its new rows (no S3 listing, no browser); the Channel Pulls
 * page lists them. Taken once (unique per source_system + external_id): a later change of the same consignment is not
 * read again (user, 2026-10-30). Rows are never deleted.
 */
@Entity({ name: TABLES.CHANNEL_PULL_ITEMS })
@Index('uq_channel_pull_items_external', ['sourceSystem', 'externalId'], { unique: true })
@Index('idx_channel_pull_items_fetched', ['sourceSystem', 'fetchedAt'])
export class ChannelPullItem {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** constants SOURCE_SYSTEM (flipkart_seller_hub ...). */
  @Column({ name: 'source_system', type: 'varchar', length: 50 })
  sourceSystem: string;

  /** The channel's id (Flipkart: the consignment id). */
  @Column({ name: 'external_id', type: 'varchar', length: 100 })
  externalId: string;

  /** The channel's status when fetched (Flipkart: Consignment Status of the Bulk Consignment File); null = not known yet. */
  @Column({ name: 'status', type: 'varchar', length: 80, nullable: true })
  status: string | null;

  /** Where it goes (Flipkart: the Warehouse Id = our channel_location_code); null = not known yet. */
  @Column({ name: 'warehouse', type: 'varchar', length: 100, nullable: true })
  warehouse: string | null;

  /** The channel's creation date (YYYY-MM-DD); the PO date and the S3 month folder. */
  @Column({ name: 'created_on', type: 'date', nullable: true })
  createdOn: string | null;

  /** Short text for the screens. */
  @Column({ name: 'label', type: 'varchar', length: 300, default: '' })
  label: string;

  /** What was fetched, as it came: { row: the table row's text, header: the Bulk Consignment File row, csv: the file's text }. */
  @Column({ name: 'data', type: 'json' })
  data: Record<string, unknown>;

  @Column({ name: 'fetched_at', type: 'datetime', precision: 6 })
  fetchedAt: Date;

  /** When the connector handed it to the PO chain (or held it); null = not taken yet. */
  @Column({ name: 'taken_at', type: 'datetime', precision: 6, nullable: true })
  takenAt: Date | null;
}
