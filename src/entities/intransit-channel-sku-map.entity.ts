import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';

/**
 * intransit_channel_sku_map (2026-10-22, user): TEMPORARY home of the in-transit Channel SKU Mapping, one row per
 * SKU + channel + channel code, until its channels are filled and its conflicts settled; then merged into
 * master_channel_skus (which PO Review uses) and dropped. channel is empty while unknown. Unique (channel, code): on one
 * channel a code means one SKU (MySQL lets several rows have an empty channel, so the loader keeps one per code).
 * No FK to master_skus: many of its SKUs are not in the product master yet.
 */
@Entity({ name: TABLES.INTRANSIT_CHANNEL_SKU_MAP })
@Index('uq_intransit_channel_sku_map', ['channel', 'channelSkuCode'], { unique: true })
@Index('idx_intransit_channel_sku_map_sku', ['skuCode'])
export class IntransitChannelSkuMap {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** Our SKU (the file's "Mapped SKU"). */
  @Column({ name: 'sku_code', type: 'varchar', length: 100 })
  skuCode: string;

  /** master_channels.display_name where it is one; null = not known yet. */
  @Column({ name: 'channel', type: 'varchar', length: 100, nullable: true })
  channel: string | null;

  /** The channel's own code (FNSKU, ASIN, FSN, Myntra code, Zepto UUID ...). */
  @Column({ name: 'channel_sku_code', type: 'varchar', length: 255 })
  channelSkuCode: string;

  /** The file's "Final SKU" column, kept for reference (Final SKU Mapping stays the report's rule). */
  @Column({ name: 'final_sku', type: 'varchar', length: 100, nullable: true })
  finalSku: string | null;

  /** Where the row (and its channel) came from: file / pepims_po / master_channel_skus / stock_file / code_type / old_csv. */
  @Column({ name: 'source', type: 'varchar', length: 50 })
  source: string;

  /** To review, e.g. "DIFFERENT: Blinkit POs use Mcaf397_WB". */
  @Column({ name: 'review_note', type: 'varchar', length: 255, nullable: true })
  reviewNote: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
