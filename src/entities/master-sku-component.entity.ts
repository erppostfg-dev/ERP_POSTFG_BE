import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SKU_COMPONENT_STAGE, SkuComponentStage, TABLES } from '../constants/db';
import { MasterSku } from './master-sku.entity';

/**
 * master_sku_components (2026-10-22, In-transit Stock): the parts of a combo, one row per part. stage split1 = Split1.csv,
 * split2 = Split2.csv (the report's two split stages). qty = units of the part in one combo; position = its order inside
 * the combo. Both codes are master_skus.pep_code (FK), so a part must exist in the product master.
 */
@Entity({ name: TABLES.MASTER_SKU_COMPONENTS })
@Index('uq_master_sku_components', ['stage', 'comboPepCode', 'componentPepCode'], { unique: true })
@Index('idx_master_sku_components_combo', ['comboPepCode'])
@Index('idx_master_sku_components_component', ['componentPepCode'])
export class MasterSkuComponent {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'stage', type: 'enum', enum: Object.values(SKU_COMPONENT_STAGE) })
  stage: SkuComponentStage;

  @Column({ name: 'combo_pep_code', type: 'varchar', length: 100 })
  comboPepCode: string;

  @Column({ name: 'component_pep_code', type: 'varchar', length: 100 })
  componentPepCode: string;

  @Column({ name: 'qty', type: 'int', default: 1 })
  qty: number;

  @Column({ name: 'position', type: 'int', default: 0 })
  position: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** fk_sku_components_combo */
  @ManyToOne(() => MasterSku, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'combo_pep_code', referencedColumnName: 'pepCode', foreignKeyConstraintName: 'fk_sku_components_combo' })
  combo: MasterSku;

  /** fk_sku_components_component */
  @ManyToOne(() => MasterSku, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'component_pep_code', referencedColumnName: 'pepCode', foreignKeyConstraintName: 'fk_sku_components_component' })
  component: MasterSku;
}
