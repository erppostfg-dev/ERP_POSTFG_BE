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
@Index('idx_bulk_orders_inst_customer', ['institutionCustomerId'])
@Index('idx_bulk_orders_buyer_org', ['buyerOrgId'])
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

  /** YYYY-MM-DD; v2 1d: optional for a Normal order (NULL), required for Fast-track. */
  @Column({ name: 'needed_by', type: 'date', nullable: true })
  neededBy: string | null;

  /** BULK_DELIVERY_MODES (Marketing only; NULL for Institutional). */
  @Column({ name: 'delivery_mode', type: 'varchar', length: 20, nullable: true })
  deliveryMode: string | null;

  /** BULK_PRIORITIES */
  @Column({ name: 'priority', type: 'varchar', length: 20 })
  priority: string;

  /** Special instructions (shown to our team). */
  @Column({ name: 'note', type: 'varchar', length: 1000, nullable: true })
  note: string | null;

  /** v2 1d: why a Fast-track order is urgent (required for Fast-track, NULL otherwise). */
  @Column({ name: 'fast_track_remarks', type: 'varchar', length: 500, nullable: true })
  fastTrackRemarks: string | null;

  // ---- courier tracking (v2 piece 4, 2026-11-24, migration BulkOrderTracking): from Uniware by the sync ----
  @Column({ name: 'awb', type: 'varchar', length: 255, nullable: true })
  awb: string | null;

  @Column({ name: 'courier', type: 'varchar', length: 255, nullable: true })
  courier: string | null;

  @Column({ name: 'courier_status', type: 'varchar', length: 255, nullable: true })
  courierStatus: string | null;

  @Column({ name: 'tracking_link', type: 'varchar', length: 1000, nullable: true })
  trackingLink: string | null;

  @Column({ name: 'dispatched_at', type: 'datetime', precision: 6, nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'delivered_at', type: 'datetime', precision: 6, nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'invoice_code', type: 'varchar', length: 255, nullable: true })
  invoiceCode: string | null;

  /** When the sync last read it (shown as "updated"). */
  @Column({ name: 'tracking_checked_at', type: 'datetime', precision: 6, nullable: true })
  trackingCheckedAt: Date | null;

  /** v2 1f: the brand of every line (PEP SKU master brand_name, as chosen); NULL on orders made before 1f. */
  @Column({ name: 'brand', type: 'varchar', length: 100, nullable: true })
  brand: string | null;

  /** v2 1d: Marketing only, optional (e.g. influencer seeding, an event name). */
  @Column({ name: 'purpose', type: 'varchar', length: 200, nullable: true })
  purpose: string | null;

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

  /** v2 piece 2 (2026-11-24, migration BulkOrderReceivers): receivers of the order (bulk_order_receivers); receiver 1 is also on this row. */
  @Column({ name: 'receiver_count', type: 'int', default: 1 })
  receiverCount: number;

  /** v2 piece 5a (migration BulkInstitutionCustomers): the customer an Institutional order was placed for (NULL = typed by hand). */
  @Column({ name: 'institution_customer_id', type: 'bigint', nullable: true })
  institutionCustomerId: string | null;

  /** v2 piece 5b (migration BulkFinance): the Razorpay payment link finance pasted (the buyer sees 'Pay now'). */
  @Column({ name: 'payment_link', type: 'varchar', length: 1000, nullable: true })
  paymentLink: string | null;

  @Column({ name: 'payment_link_by', type: 'int', nullable: true })
  paymentLinkBy: number | null;

  @Column({ name: 'payment_link_at', type: 'datetime', precision: 6, nullable: true })
  paymentLinkAt: Date | null;

  /** 2026-11-24 (migration BulkPaymentDetails): bank details text our team gives the buyer (with / instead of a link / QR). */
  @Column({ name: 'payment_bank_details', type: 'varchar', length: 1000, nullable: true })
  paymentBankDetails: string | null;

  /** 2026-11-24 (migration BulkBuyerOrgs): the buyer organisation the order belongs to (NULL = ours / none). */
  @Column({ name: 'buyer_org_id', type: 'bigint', nullable: true })
  buyerOrgId: string | null;
}

/**
 * One SKU of a bulk order. MRP = the PEP SKU master's at ordering; price = MRP less discount %. requested_* = what the
 * requester asked (kept when the approver changes qty / discount in step 2).
 */
@Entity({ name: TABLES.BULK_ORDER_LINES })
@Index('uq_bulk_order_lines_line', ['orderId', 'lineNo'], { unique: true })
@Index('uq_bulk_order_lines_sku', ['orderId', 'receiverNo', 'pepCode'], { unique: true })
export class BulkOrderLine {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId: string;

  /** 1, 2, ... in the order they were added (numbered across all receivers of the order). */
  @Column({ name: 'line_no', type: 'int' })
  lineNo: number;

  /** v2 piece 2: the receiver (bulk_order_receivers.receiver_no) the line goes to; 1 on a one-receiver order. */
  @Column({ name: 'receiver_no', type: 'int', default: 1 })
  receiverNo: number;

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

/**
 * v2 piece 2 (2026-11-24, migration BulkOrderReceivers): one receiver of a bulk order (Marketing / Head office may have
 * many; Institutional and older orders one). Each becomes its own Uniware sale order (piece 2b: its sale order + courier
 * tracking here). The address is COPIED (a saved location may change later). Receiver 1 is also kept on bulk_orders.
 */
@Entity({ name: TABLES.BULK_ORDER_RECEIVERS })
@Index('uq_bulk_order_receivers_no', ['orderId', 'receiverNo'], { unique: true })
@Index('idx_bulk_order_receivers_po_uid', ['poUid'])
@Index('idx_bulk_order_receivers_upload', ['uploadId'])
export class BulkOrderReceiver {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId: string;

  /** 1, 2, ... as on the form. */
  @Column({ name: 'receiver_no', type: 'int' })
  receiverNo: number;

  @Column({ name: 'receiver_name', type: 'varchar', length: 150 })
  receiverName: string;

  /** 10 digits. */
  @Column({ name: 'receiver_phone', type: 'varchar', length: 20 })
  receiverPhone: string;

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

  @Column({ name: 'total_units', type: 'int', default: 0 })
  totalUnits: number;

  /** NULL = no sale order yet; then processing / dispatched / delivered (BULK_ORDER_STATUS values). */
  @Column({ name: 'receiver_status', type: 'varchar', length: 30, nullable: true })
  receiverStatus: string | null;

  // ---- its sale order (piece 2b) ----
  @Column({ name: 'customer_code', type: 'varchar', length: 100, nullable: true })
  customerCode: string | null;

  @Column({ name: 'customer_id', type: 'bigint', nullable: true })
  customerId: string | null;

  @Column({ name: 'processed_by', type: 'int', nullable: true })
  processedBy: number | null;

  @Column({ name: 'processed_at', type: 'datetime', precision: 6, nullable: true })
  processedAt: Date | null;

  @Column({ name: 'upload_id', type: 'bigint', nullable: true })
  uploadId: string | null;

  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  @Column({ name: 'sale_order_code', type: 'varchar', length: 30, nullable: true })
  saleOrderCode: string | null;

  @Column({ name: 'sale_order_count', type: 'int', default: 0 })
  saleOrderCount: number;

  // ---- courier tracking from Uniware (piece 2b; as on bulk_orders) ----
  @Column({ name: 'awb', type: 'varchar', length: 255, nullable: true })
  awb: string | null;

  @Column({ name: 'courier', type: 'varchar', length: 255, nullable: true })
  courier: string | null;

  @Column({ name: 'courier_status', type: 'varchar', length: 255, nullable: true })
  courierStatus: string | null;

  @Column({ name: 'tracking_link', type: 'varchar', length: 1000, nullable: true })
  trackingLink: string | null;

  @Column({ name: 'dispatched_at', type: 'datetime', precision: 6, nullable: true })
  dispatchedAt: Date | null;

  @Column({ name: 'delivered_at', type: 'datetime', precision: 6, nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'invoice_code', type: 'varchar', length: 255, nullable: true })
  invoiceCode: string | null;

  @Column({ name: 'tracking_checked_at', type: 'datetime', precision: 6, nullable: true })
  trackingCheckedAt: Date | null;
}

/**
 * v2 piece 5a (2026-11-24, PRD "Customers page"): a customer an Institutional buyer orders for. GSTIN unverified until
 * finance verifies it (gstin_verified_*; a GSTIN change clears it). Never deleted: switched off (is_active).
 */
@Entity({ name: TABLES.BULK_INSTITUTION_CUSTOMERS })
@Index('uq_bulk_inst_customers_gstin', ['gstin'], { unique: true })
@Index('idx_bulk_inst_customers_name', ['companyName'])
@Index('idx_bulk_inst_customers_org', ['buyerOrgId'])
export class BulkInstitutionCustomer {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'company_name', type: 'varchar', length: 200 })
  companyName: string;

  /** 15 characters, upper case; NULL = none given. One customer per GSTIN. */
  @Column({ name: 'gstin', type: 'varchar', length: 15, nullable: true })
  gstin: string | null;

  @Column({ name: 'gstin_verified_by', type: 'int', nullable: true })
  gstinVerifiedBy: number | null;

  @Column({ name: 'gstin_verified_at', type: 'datetime', precision: 6, nullable: true })
  gstinVerifiedAt: Date | null;

  @Column({ name: 'billing_address_line', type: 'varchar', length: 500 })
  billingAddressLine: string;

  @Column({ name: 'billing_city', type: 'varchar', length: 100 })
  billingCity: string;

  @Column({ name: 'billing_state', type: 'varchar', length: 100 })
  billingState: string;

  @Column({ name: 'billing_pincode', type: 'varchar', length: 10 })
  billingPincode: string;

  @Column({ name: 'contact_name', type: 'varchar', length: 150 })
  contactName: string;

  /** 10 digits. */
  @Column({ name: 'contact_phone', type: 'varchar', length: 20 })
  contactPhone: string;

  @Column({ name: 'contact_email', type: 'varchar', length: 150, nullable: true })
  contactEmail: string | null;

  /** Filled into a new order's lines (still changeable per line). */
  @Column({ name: 'default_discount_pct', type: 'decimal', precision: 5, scale: 2, default: 0, transformer: decimal })
  defaultDiscountPct: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** 2026-11-24 (migration BulkBuyerOrgs): the buyer organisation whose list it is in (NULL = ours). */
  @Column({ name: 'buyer_org_id', type: 'bigint', nullable: true })
  buyerOrgId: string | null;
}

/**
 * 2026-11-24 (migration BulkBuyerOrgs): an outside buyer organisation. Its people see only its orders + customers.
 */
@Entity({ name: TABLES.BULK_BUYER_ORGS })
@Index('uq_bulk_buyer_orgs_name', ['name'], { unique: true })
export class BulkBuyerOrg {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}

/** A person of a buyer organisation (one organisation per person). */
@Entity({ name: TABLES.BULK_BUYER_ORG_USERS })
@Index('idx_bulk_buyer_org_users_org', ['orgId'])
export class BulkBuyerOrgUser {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'org_id', type: 'bigint' })
  orgId: string;

  @Column({ name: 'added_by', type: 'int' })
  addedBy: number;

  @Column({ name: 'added_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  addedAt: Date;
}

/** v2 piece 5a: a shipping address of an Institutional customer (picked on the order form; switched off, never deleted). */
@Entity({ name: TABLES.BULK_INSTITUTION_CUSTOMER_ADDRESSES })
@Index('idx_bulk_inst_customer_addresses_customer', ['customerId'])
export class BulkInstitutionCustomerAddress {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'customer_id', type: 'bigint' })
  customerId: string;

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

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;
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
 * The customer book = address book (2026-11-12, step 3b; addresses 2026-11-13): one row per order type + delivery
 * address + Uniware channel + customer code our team typed. name / gstin / address_line .. pincode = the customer
 * (Institutional: institution + billing address; Marketing: receiver + delivery address); ship_* = the delivery address,
 * address_key = sha1 of its pincode + cleaned line (bulk-process.service addressKey). Used again = used_count + 1;
 * never deleted ("Don't suggest again" = hidden_at).
 */
@Entity({ name: TABLES.BULK_CUSTOMERS })
@Index('idx_bulk_customers_gstin', ['gstin'])
@Index('idx_bulk_customers_pincode', ['pincode'])
@Index('idx_bulk_customers_address_key', ['addressKey'])
@Index('idx_bulk_customers_ship_pincode', ['shipPincode'])
export class BulkCustomer {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** marketing | institutional: suggestions stay within the type (different Uniware channels). */
  @Column({ name: 'order_type', type: 'varchar', length: 20, default: 'institutional' })
  orderType: string;

  @Column({ name: 'receiver_name', type: 'varchar', length: 150, nullable: true })
  receiverName: string | null;

  @Column({ name: 'ship_address_line', type: 'varchar', length: 500, nullable: true })
  shipAddressLine: string | null;

  @Column({ name: 'ship_city', type: 'varchar', length: 100, nullable: true })
  shipCity: string | null;

  @Column({ name: 'ship_state', type: 'varchar', length: 100, nullable: true })
  shipState: string | null;

  @Column({ name: 'ship_pincode', type: 'varchar', length: 10, nullable: true })
  shipPincode: string | null;

  @Column({ name: 'address_key', type: 'char', length: 40, nullable: true })
  addressKey: string | null;

  /** "Don't suggest again" (PO review editor); cleared when the same address + code is used again. */
  @Column({ name: 'hidden_at', type: 'datetime', precision: 6, nullable: true })
  hiddenAt: Date | null;

  @Column({ name: 'hidden_by', type: 'int', nullable: true })
  hiddenBy: number | null;

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

  /** v2 1c (2026-11-23): an order with MORE units than this needs approval; NULL = never by units (BULK_APPROVAL). */
  @Column({ name: 'approval_over_units', type: 'int', nullable: true })
  approvalOverUnits: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
