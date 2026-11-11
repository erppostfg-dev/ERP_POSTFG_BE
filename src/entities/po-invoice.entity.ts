import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { MasterPurchaseOrder } from './master-purchase-order.entity';

/** po_invoices.sku_qty: units per SKU (pep_code) of one invoice. */
export type PoInvoiceSkuQty = Record<string, { dispatched: number; inward: number; received: number }>;
/**
 * po_invoices.grn_codes: the GRNs of the invoice's inward PO. units = accepted units (quantity - rejectedQuantity of its
 * items); status / skus / rejected (phase 7) let the sync re-read a GRN that was not COMPLETE yet and re-sum
 * sku_qty.received without reading the complete ones again.
 */
export type PoInvoiceGrn = {
  code: string; date: string | null; units: number;
  status?: string | null; rejected?: number; skus?: Record<string, number>;
};

/**
 * po_invoices (D2C internal transfers, 2026-11-03; plan v3 section 2.3): one row per Uniware invoice / shipping
 * package of a transfer (master_purchase_orders.transferCode NOT NULL), with the inward PO made for it at the
 * receiving facility, its GRNs and the variance reason. The only new table of the feature.
 * Inward PO code = <SO code>-<n> (constants/d2c-transfers.ts). Who / when of each action: shipment_logs.
 */
@Entity({ name: TABLES.PO_INVOICES })
@Index('uq_po_invoices_package', ['poUid', 'shippingPackageCode'], { unique: true })
@Index('uq_po_invoices_inward_po_code', ['inwardPoCode'], { unique: true })
@Index('idx_po_invoices_inward_po_state', ['inwardPoState'])
export class PoInvoice {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** master_purchase_orders.uid of the transfer. */
  @Column({ name: 'po_uid', type: 'bigint' })
  poUid: string;

  @Column({ name: 'sale_order_code', type: 'varchar', length: 100, nullable: true })
  saleOrderCode: string | null;

  @Column({ name: 'shipping_package_code', type: 'varchar', length: 100 })
  shippingPackageCode: string;

  @Column({ name: 'invoice_code', type: 'varchar', length: 100, nullable: true })
  invoiceCode: string | null;

  @Column({ name: 'invoice_display_code', type: 'varchar', length: 100, nullable: true })
  invoiceDisplayCode: string | null;

  @Column({ name: 'invoice_date', type: 'datetime', nullable: true })
  invoiceDate: Date | null;

  /** Raw Uniware package status. */
  @Column({ name: 'package_status', type: 'varchar', length: 50, nullable: true })
  packageStatus: string | null;

  /** Set = dispatched, so an inward PO can be made for it. */
  @Column({ name: 'dispatched_at', type: 'datetime', nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'units', type: 'int', default: 0 })
  units: number;

  /** Our code of the inward PO in Uniware (<SO code>-<n>); unique. */
  @Column({ name: 'inward_po_code', type: 'varchar', length: 100, nullable: true })
  inwardPoCode: string | null;

  /** D2C_REQUEST_STATE: requested / created / failed / unknown; null = not asked. */
  @Column({ name: 'inward_po_state', type: 'varchar', length: 10, nullable: true })
  inwardPoState: string | null;

  /**
   * Facility code the inward PO was requested at (written at reserve time; migration D2cInvoiceReceiving1794100000000).
   * NULL on rows made before it: the code then reads the inward_po_requested log remark (storedReceivingOf).
   */
  @Column({ name: 'receiving_facility_code', type: 'varchar', length: 100, nullable: true })
  receivingFacilityCode: string | null;

  @Column({ name: 'inward_po_requested_at', type: 'datetime', precision: 6, nullable: true })
  inwardPoRequestedAt: Date | null;

  @Column({ name: 'inward_po_error', type: 'text', nullable: true })
  inwardPoError: string | null;

  /** Raw Uniware PO status. */
  @Column({ name: 'inward_po_status', type: 'varchar', length: 50, nullable: true })
  inwardPoStatus: string | null;

  @Column({ name: 'grn_codes', type: 'json', nullable: true })
  grnCodes: PoInvoiceGrn[] | null;

  /** Sum of the GRNs. */
  @Column({ name: 'received_units', type: 'int', default: 0 })
  receivedUnits: number;

  @Column({ name: 'grn_completed_at', type: 'datetime', nullable: true })
  grnCompletedAt: Date | null;

  /** D2C_VARIANCE_REASON: short_received / damaged / excess / other. */
  @Column({ name: 'variance_reason', type: 'varchar', length: 20, nullable: true })
  varianceReason: string | null;

  @Column({ name: 'variance_note', type: 'text', nullable: true })
  varianceNote: string | null;

  @Column({ name: 'sku_qty', type: 'json', nullable: true })
  skuQty: PoInvoiceSkuQty | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** fk_po_invoices_po: a transfer with invoices cannot be deleted (npm run d2c:purge deletes these first). */
  @ManyToOne(() => MasterPurchaseOrder, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'po_uid', referencedColumnName: 'uid', foreignKeyConstraintName: 'fk_po_invoices_po' })
  purchaseOrder: MasterPurchaseOrder;
}
