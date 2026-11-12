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

  /** BULK_PAYMENT_STATUS; NULL = no payment check for this order (off for its type when it was created). */
  @Column({ name: 'payment_status', type: 'varchar', length: 20, nullable: true })
  paymentStatus: string | null;

  /** Who / when / why of the last payment change (the approver; an upload sets only the status). */
  @Column({ name: 'payment_by', type: 'int', nullable: true })
  paymentBy: number | null;

  @Column({ name: 'payment_at', type: 'datetime', precision: 6, nullable: true })
  paymentAt: Date | null;

  @Column({ name: 'payment_note', type: 'varchar', length: 1000, nullable: true })
  paymentNote: string | null;

  // ---- Institutional requester details (2026-11-12, migration BulkOrderProcessing; NULL on Marketing orders) ----
  @Column({ name: 'institution_name', type: 'varchar', length: 200, nullable: true })
  institutionName: string | null;

  /** Optional; checked as a GSTIN when given. */
  @Column({ name: 'gstin', type: 'varchar', length: 15, nullable: true })
  gstin: string | null;

  @Column({ name: 'contact_email', type: 'varchar', length: 150, nullable: true })
  contactEmail: string | null;

  /** Billing address (the delivery address copied when the requester ticks "same as delivery"). */
  @Column({ name: 'billing_address_line', type: 'varchar', length: 500, nullable: true })
  billingAddressLine: string | null;

  @Column({ name: 'billing_city', type: 'varchar', length: 100, nullable: true })
  billingCity: string | null;

  @Column({ name: 'billing_state', type: 'varchar', length: 100, nullable: true })
  billingState: string | null;

  @Column({ name: 'billing_pincode', type: 'varchar', length: 10, nullable: true })
  billingPincode: string | null;

  // ---- Step 3b: our team's sale order (the CURRENT one; a sent-back one is cleared here, kept on the timeline) ----
  @Column({ name: 'facility_code', type: 'varchar', length: 100, nullable: true })
  facilityCode: string | null;

  @Column({ name: 'uniware_channel', type: 'varchar', length: 100, nullable: true })
  uniwareChannel: string | null;

  @Column({ name: 'customer_code', type: 'varchar', length: 100, nullable: true })
  customerCode: string | null;

  /** bulk_customers.id saved / updated by the processing. */
  @Column({ name: 'customer_id', type: 'bigint', nullable: true })
  customerId: string | null;

  @Column({ name: 'processed_by', type: 'int', nullable: true })
  processedBy: number | null;

  @Column({ name: 'processed_at', type: 'datetime', precision: 6, nullable: true })
  processedAt: Date | null;

  /** po_uploads.id of the sale order (Processed tab, Verify, Uniware hand-off). */
  @Column({ name: 'upload_id', type: 'bigint', nullable: true })
  uploadId: string | null;

  /** master_purchase_orders.uid */
  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  @Column({ name: 'sale_order_code', type: 'varchar', length: 30, nullable: true })
  saleOrderCode: string | null;

  /** Sale orders made so far (a send back + process again = 2, ...): S3 folder sale-order-<n>, external id. */
  @Column({ name: 'sale_order_count', type: 'int', default: 0 })
  saleOrderCount: number;
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

/** A file on an order (proforma / invoice / proof of payment, BULK_DOC_KIND), in S3. Never deleted: a newer one of the
 *  same kind sets replaced_at on the older ones. */
@Entity({ name: TABLES.BULK_ORDER_DOCUMENTS })
@Index('idx_bulk_order_documents_order', ['orderId'])
export class BulkOrderDocument {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId: string;

  @Column({ name: 'kind', type: 'varchar', length: 30 })
  kind: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'content_type', type: 'varchar', length: 100 })
  contentType: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ name: 's3_url', type: 'varchar', length: 1000 })
  s3Url: string;

  @Column({ name: 'uploaded_by', type: 'int' })
  uploadedBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'replaced_at', type: 'datetime', precision: 6, nullable: true })
  replacedAt: Date | null;
}

/**
 * A customer our team processed (2026-11-12, Bulk Orders step 3b): the requester's institution details + the Uniware
 * channel / customer code typed for it. Suggested on a later order with the same GSTIN, or the same name + billing
 * pincode. Updated (not duplicated) when it is used again; never deleted.
 */
@Entity({ name: TABLES.BULK_CUSTOMERS })
@Index('idx_bulk_customers_gstin', ['gstin'])
@Index('idx_bulk_customers_pincode', ['pincode'])
export class BulkCustomer {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'gstin', type: 'varchar', length: 15, nullable: true })
  gstin: string | null;

  @Column({ name: 'address_line', type: 'varchar', length: 500 })
  addressLine: string;

  @Column({ name: 'city', type: 'varchar', length: 100 })
  city: string;

  @Column({ name: 'state', type: 'varchar', length: 100 })
  state: string;

  @Column({ name: 'pincode', type: 'varchar', length: 10 })
  pincode: string;

  @Column({ name: 'phone', type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ name: 'email', type: 'varchar', length: 150, nullable: true })
  email: string | null;

  @Column({ name: 'uniware_channel', type: 'varchar', length: 100 })
  uniwareChannel: string;

  @Column({ name: 'customer_code', type: 'varchar', length: 100 })
  customerCode: string;

  /** Orders processed with it. */
  @Column({ name: 'used_count', type: 'int', default: 0 })
  usedCount: number;

  @Column({ name: 'last_order_id', type: 'bigint', nullable: true })
  lastOrderId: string | null;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}

/** Settings per order type (admin, user 2026-11-12; a full Bulk Orders admin section comes later). No row = all off. */
@Entity({ name: TABLES.BULK_TYPE_SETTINGS })
export class BulkTypeSetting {
  @PrimaryColumn({ name: 'order_type', type: 'varchar', length: 20 })
  orderType: string;

  /** ON = new orders of the type get a payment status (proof + approver's check). */
  @Column({ name: 'payment_check', type: 'boolean', default: false })
  paymentCheck: boolean;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
