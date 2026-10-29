import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { MasterChannel } from './master-channel.entity';
import { MasterSku } from './master-sku.entity';
import { decimal } from './transformers';

/**
 * master_channel_skus: a channel's SKU mapped to our pep_code (was all_channels).
 * channel_code is the channel's own SKU code = processed.json line channel_sku_code (Reliance Article No, Purplle PPLB...).
 * Matches the LIVE table (checked 2026-10-08): it has channel_id and pep_sku_id, no final_sku_live, and NO foreign keys
 * (the relations below are for joins only and claim no FK constraint).
 */
@Entity({ name: TABLES.MASTER_CHANNEL_SKUS })
@Index('idx_master_channel_skus_pep_code', ['pepCode'])
@Index('idx_master_channel_skus_channel_code', ['channelCode'])
@Index('fk_master_channel_skus_channel', ['channelName'])
export class MasterChannelSku {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'pep_code', type: 'varchar', length: 100 })
  pepCode: string;

  @Column({ name: 'product_name', type: 'varchar', length: 500, nullable: true })
  productName: string | null;

  @Column({ name: 'mrp', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  mrp: number | null;

  @Column({ name: 'channel_code', type: 'varchar', length: 100, nullable: true })
  channelCode: string | null;

  @Column({ name: 'margin', type: 'decimal', precision: 10, scale: 4, nullable: true, transformer: decimal })
  margin: number | null;

  @Column({ name: 'rate_after_margin', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  rateAfterMargin: number | null;

  @Column({ name: 'ean_code', type: 'varchar', length: 50, nullable: true })
  eanCode: string | null;

  /** master_channels.display_name. */
  @Column({ name: 'channel_name', type: 'varchar', length: 100, nullable: true })
  channelName: string | null;

  @Column({ name: 'brand_name', type: 'varchar', length: 100, nullable: true })
  brandName: string | null;

  /** master_channels.id (no FK in the live table). */
  @Column({ name: 'channel_id', type: 'int', nullable: true })
  channelId: number | null;

  /** master_skus.id (no FK in the live table). */
  @Column({ name: 'pep_sku_id', type: 'int', nullable: true })
  pepSkuId: number | null;

  /**
   * Switched off on the Masters page (2026-10-28, migration ChannelSkuActive; every existing row active): PO checks,
   * the review SKU picker and the Amazon inbound lines use active rows only; only active rows count as duplicates.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /** pep_code -> master_skus.pep_code (join only; no FK in the live table). */
  @ManyToOne(() => MasterSku, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'pep_code', referencedColumnName: 'pepCode' })
  sku: MasterSku;

  /** channel_name -> master_channels.display_name (join only; no FK in the live table). */
  @ManyToOne(() => MasterChannel, { nullable: true, createForeignKeyConstraints: false })
  @JoinColumn({ name: 'channel_name', referencedColumnName: 'displayName' })
  channel: MasterChannel | null;
}
