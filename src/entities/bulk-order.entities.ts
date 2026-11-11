import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { decimal } from './transformers';

/*
 * Bulk Orders portal (2026-11-11, constants/bulk-orders.ts, migration BulkOrders). Own tables: nothing here is a
 * channel, a po_uploads row or a PO yet (the hand-off to the PO / sale order chain comes after approval, later step).
 */

/** One Marketing / Institutional bulk order. The delivery address is COPIED here (a saved location may change later). */
@Entity({ name: TABLES.BULK_ORDERS })
@Index('uq_bulk_orders_po_number', ['poNumber'], { unique: true })
@Index('idx_bulk_orders_type_status', ['orderType', 'status', 'createdAt'])
export class BulkOrder {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** MKT-2026-0001 / INST-2026-0001 (bulk_order_counters + this unique key). */
  @Column({ name: 'po_number', type: 'varchar', length: 30 })
  poNumber: string;

  /** BULK_ORDER_TYPE */
  @Column({ name: 'order_type', type: 'varchar', length: 20 })
  orderType: string;

  /** BULK_ORDER_STATUS */
  @Column({ name: 'status', type: 'varchar', length: 30 })
  status: string;

  /** The design's "Ordered by" (the requester's team / the institution), as typed. */
  @Column({ name: 'ordered_by', type: 'varchar', length: 150 })
  orderedBy: string;

  @Column({ name: 'receiver_name', type: 'varchar', length: 150 })
  receiverName: string;

  /** 10 digits. */
  @Column({ name: 'receiver_phone', type: 'varchar', length: 20 })
  receiverPhone: string;

  /** The saved location it was picked from / saved as (NULL = typed for this order only). */
  @Column({ name: 'location_id', type: 'bigint', nullable: true })
  locationId: string | null;

  @Column({ name: 'location_label', type: 'varchar', length: 100, nullable: true })
  locationLabel: string | null;

  @Column({ name: 'address_line', type: 'varchar', length: 500 })
  addressLine: string;

  @Column({ name: 'city', type: 'varchar', length: 100 })
  city: string;

  @Column({ name: 'state', type: 'varchar', length: 100 })
  state: string;

  @Column({ name: 'pincode', type: 'varchar', length: 10 })
  pincode: string;

  /** YYYY-MM-DD */
  @Column({ name: 'needed_by', type: 'date' })
  neededBy: string;

  /** BULK_DELIVERY_MODES (Marketing only; NULL for Institutional). */
  @Column({ name: 'delivery_mode', type: 'varchar', length: 20, nullable: true })
  deliveryMode: string | null;

  /** BULK_PRIORITIES */
  @Column({ name: 'priority', type: 'varchar', length: 20 })
  priority: string;

  @Column({ name: 'note', type: 'varchar', length: 1000, nullable: true })
  note: string | null;

  /** Totals of the lines (kept so lists need no line query). */
  @Column({ name: 'line_count', type: 'int' })
  lineCount: number;

  @Column({ name: 'total_units', type: 'int' })
  totalUnits: number;

  @Column({ name: 'total_mrp', type: 'decimal', precision: 14, scale: 2, transformer: decimal })
  totalMrp: number;

  /** After the discounts. */
  @Column({ name: 'total_value', type: 'decimal', precision: 14, scale: 2, transformer: decimal })
  totalValue: number;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** Approval (step 2): who approved / rejected, when, why. */
  @Column({ name: 'decided_by', type: 'int', nullable: true })
  decidedBy: number | null;

  @Column({ name: 'decided_at', type: 'datetime', precision: 6, nullable: true })
  decidedAt: Date | null;

  @Column({ name: 'decision_note', type: 'varchar', length: 1000, nullable: true })
  decisionNote: string | null;
}

/**
 * One SKU of a bulk order. MRP = the PEP SKU master's at ordering; price = MRP less discount %. requested_* = what the
 * requester asked (kept when the approver changes qty / discount in step 2).
 */
@Entity({ name: TABLES.BULK_ORDER_LINES })
@Index('uq_bulk_order_lines_line', ['orderId', 'lineNo'], { unique: true })
@Index('uq_bulk_order_lines_sku', ['orderId', 'pepCode'], { unique: true })
export class BulkOrderLine {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId: string;

  /** 1, 2, ... in the order they were added. */
  @Column({ name: 'line_no', type: 'int' })
  lineNo: number;

  @Column({ name: 'pep_code', type: 'varchar', length: 100 })
  pepCode: string;

  @Column({ name: 'product_name', type: 'varchar', length: 500, nullable: true })
  productName: string | null;

  @Column({ name: 'mrp', type: 'decimal', precision: 10, scale: 2, transformer: decimal })
  mrp: number;

  @Column({ name: 'requested_qty', type: 'int' })
  requestedQty: number;

  @Column({ name: 'requested_discount_pct', type: 'decimal', precision: 5, scale: 2, transformer: decimal })
  requestedDiscountPct: number;

  @Column({ name: 'qty', type: 'int' })
  qty: number;

  @Column({ name: 'discount_pct', type: 'decimal', precision: 5, scale: 2, transformer: decimal })
  discountPct: number;

  /** MRP x (1 - discount / 100), 2 decimals. */
  @Column({ name: 'unit_price', type: 'decimal', precision: 10, scale: 2, transformer: decimal })
  unitPrice: number;

  @Column({ name: 'line_total', type: 'decimal', precision: 14, scale: 2, transformer: decimal })
  lineTotal: number;
}

/** A delivery address saved from the order form, per type (Marketing people never see Institutional addresses). */
@Entity({ name: TABLES.BULK_LOCATIONS })
@Index('uq_bulk_locations_label', ['orderType', 'label'], { unique: true })
export class BulkLocation {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'order_type', type: 'varchar', length: 20 })
  orderType: string;

  /** What people pick it by, e.g. "Andheri store". */
  @Column({ name: 'label', type: 'varchar', length: 100 })
  label: string;

  @Column({ name: 'address_line', type: 'varchar', length: 500 })
  addressLine: string;

  @Column({ name: 'city', type: 'varchar', length: 100 })
  city: string;

  @Column({ name: 'state', type: 'varchar', length: 100 })
  state: string;

  @Column({ name: 'pincode', type: 'varchar', length: 10 })
  pincode: string;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;
}

/** One change of an order (Bulk Orders step 2, BULK_EVENT): who, when, a note, and what changed (old -> new). */
@Entity({ name: TABLES.BULK_ORDER_EVENTS })
@Index('idx_bulk_order_events_order', ['orderId'])
export class BulkOrderEvent {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId: string;

  /** BULK_EVENT */
  @Column({ name: 'action', type: 'varchar', length: 20 })
  action: string;

  @Column({ name: 'by_user_id', type: 'int' })
  byUserId: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** The requester's note / cancel reason / approver's note / reject reason. */
  @Column({ name: 'note', type: 'varchar', length: 1000, nullable: true })
  note: string | null;

  /** approved: { lines: [{ lineNo, pepCode, qty?: [old, new], discountPct?: [..], mrp?: [..], removed? }] };
   *  edited: { fields, linesBefore, linesAfter }. */
  @Column({ name: 'changes', type: 'json', nullable: true })
  changes: object | null;
}

/** The last PO serial per type and year (one atomic UPDATE per new order: MKT-2026-0001, -0002, ...). */
@Entity({ name: TABLES.BULK_ORDER_COUNTERS })
export class BulkOrderCounter {
  @PrimaryColumn({ name: 'order_type', type: 'varchar', length: 20 })
  orderType: string;

  @PrimaryColumn({ name: 'order_year', type: 'int' })
  orderYear: number;

  @Column({ name: 'last_serial', type: 'int' })
  lastSerial: number;
}
