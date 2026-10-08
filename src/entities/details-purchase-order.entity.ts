import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { MasterPurchaseOrder } from './master-purchase-order.entity';
import { decimal } from './transformers';

/** details_purchase_orders: the PO lines, one row per SKU line (was sku_orders). Column names are camelCase in the DB. */
@Entity({ name: TABLES.DETAILS_PURCHASE_ORDERS })
export class DetailsPurchaseOrder {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'srNo', type: 'varchar', length: 50, nullable: true })
  srNo: string | null;

  @Column({ name: 'skuName', type: 'varchar', length: 255, nullable: true })
  skuName: string | null;

  /** Our pep_code (master_skus.pep_code; logical link, no FK). */
  @Column({ name: 'skuCode', type: 'varchar', length: 255, nullable: true })
  skuCode: string | null;

  @Column({ name: 'channelSkuCode', type: 'varchar', length: 255, nullable: true })
  channelSkuCode: string | null;

  @Column({ name: 'qty', type: 'int', nullable: true })
  qty: number | null;

  @Column({ name: 'gmv', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  gmv: number | null;

  @Column({ name: 'poValue', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  poValue: number | null;

  @Column({ name: 'accountsWorking', type: 'text', nullable: true })
  accountsWorking: string | null;

  @Column({ name: 'channelInwardingQuantity', type: 'int', nullable: true })
  channelInwardingQuantity: number | null;

  @Column({ name: 'actualWeight', type: 'decimal', precision: 12, scale: 3, nullable: true, transformer: decimal })
  actualWeight: number | null;

  /** master_purchase_orders.uid. */
  @Column({ name: 'shipmentOrderId', type: 'bigint' })
  shipmentOrderId: string;

  @Column({ name: 'createdAt', type: 'datetime', nullable: true })
  createdAt: Date | null;

  @Column({ name: 'updatedAt', type: 'datetime', nullable: true })
  updatedAt: Date | null;

  @Column({ name: 'updatedQty', type: 'int', nullable: true })
  updatedQty: number | null;

  @Column({ name: 'updatedGmv', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  updatedGmv: number | null;

  @Column({ name: 'updatedPoValue', type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: decimal })
  updatedPoValue: number | null;

  @Column({ name: 'brandName', type: 'varchar', length: 255, nullable: true })
  brandName: string | null;

  @Column({ name: 'poNumber', type: 'varchar', length: 255, nullable: true })
  poNumber: string | null;

  /** fk_details_master_po: shipmentOrderId -> master_purchase_orders.uid. */
  @ManyToOne(() => MasterPurchaseOrder, (po) => po.lines)
  @JoinColumn({ name: 'shipmentOrderId', referencedColumnName: 'uid', foreignKeyConstraintName: 'fk_details_master_po' })
  purchaseOrder: MasterPurchaseOrder;
}
