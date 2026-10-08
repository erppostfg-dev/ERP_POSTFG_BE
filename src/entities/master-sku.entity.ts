import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { decimal } from './transformers';

/**
 * master_skus: our product master, one row per pep_code (was uniware_sku_master).
 * Matches the LIVE table (checked 2026-10-08, 18 columns): it has is_active, and not final_schema.sql's
 * product_category_code, enabled, fragile, dangerous_good, cost_price, base_price, tax_calculation_type,
 * brief_description, color, size, expirable.
 */
@Entity({ name: TABLES.MASTER_SKUS })
@Index('pep_code', ['pepCode'], { unique: true })
export class MasterSku {
  /** BIGINT: TypeORM returns it as a string. */
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'pep_code', type: 'varchar', length: 100 })
  pepCode: string;

  @Column({ name: 'product_name', type: 'varchar', length: 500, nullable: true })
  productName: string | null;

  @Column({ name: 'mrp', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  mrp: number | null;

  @Column({ name: 'ean_code', type: 'varchar', length: 50, nullable: true })
  eanCode: string | null;

  @Column({ name: 'brand_name', type: 'varchar', length: 100, nullable: true })
  brandName: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, nullable: true })
  createdAt: Date | null;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, nullable: true })
  updatedAt: Date | null;

  @Column({ name: 'hsn_code', type: 'varchar', length: 50, nullable: true })
  hsnCode: string | null;

  @Column({ name: 'is_active', type: 'boolean', nullable: true, default: true })
  isActive: boolean | null;

  @Column({ name: 'product_type', type: 'varchar', length: 50, nullable: true })
  productType: string | null;

  @Column({ name: 'gst_tax_type', type: 'varchar', length: 50, nullable: true })
  gstTaxType: string | null;

  @Column({ name: 'length_mm', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  lengthMm: number | null;

  @Column({ name: 'width_mm', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  widthMm: number | null;

  @Column({ name: 'height_mm', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  heightMm: number | null;

  @Column({ name: 'weight_g', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  weightG: number | null;

  @Column({ name: 'determine_expiry_from', type: 'varchar', length: 100, nullable: true })
  determineExpiryFrom: string | null;

  @Column({ name: 'shelf_life', type: 'int', nullable: true })
  shelfLife: number | null;
}
