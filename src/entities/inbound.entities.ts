import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { INBOUND_EVENT, INBOUND_EVENT_SOURCE, InboundEventKind, InboundEventSource } from '../constants/inbound';
import { User } from './auth.entities';
import { MasterCourierPartner } from './master-courier-partner.entity';
import { MasterFacility } from './master-facility.entity';
import { PoUpload } from './po-upload.entity';

/*
 * Inbound plan tracking (user, 2026-10-19; constants/inbound.ts). Filled by the Amazon inbound sync: a plan once when it
 * first appears, its shipments' status from the "changed since" poll, lines only when they may have changed, received
 * quantities while receiving. The screens read only these tables (no Amazon call to show a plan).
 */

/** inbound_plans: one row per channel inbound plan (Amazon "wf..."). */
@Entity({ name: TABLES.INBOUND_PLANS })
@Index('uq_inbound_plans_plan', ['sourceSystem', 'planId'], { unique: true })
@Index('idx_inbound_plans_created', ['createdAtChannel'])
export class InboundPlan {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** constants SOURCE_SYSTEM (amazon_spapi ...). */
  @Column({ name: 'source_system', type: 'varchar', length: 50 })
  sourceSystem: string;

  /** The channel's plan id (Amazon inboundPlanId, e.g. wf705d7f8b-...). */
  @Column({ name: 'plan_id', type: 'varchar', length: 64 })
  planId: string;

  @Column({ name: 'name', type: 'varchar', length: 200, nullable: true })
  name: string | null;

  /** The channel's own plan status (Amazon: ACTIVE / SHIPPED / VOIDED); says nothing about its shipments. */
  @Column({ name: 'status', type: 'varchar', length: 30, nullable: true })
  status: string | null;

  @Column({ name: 'ship_from_name', type: 'varchar', length: 200, nullable: true })
  shipFromName: string | null;

  @Column({ name: 'ship_from_pincode', type: 'varchar', length: 10, nullable: true })
  shipFromPincode: string | null;

  /** Our facility the stock leaves from (matched from the ship-from address; null until mapped). */
  @Column({ name: 'facility_id', type: 'int', nullable: true })
  facilityId: number | null;

  /** When the channel created the plan. */
  @Column({ name: 'created_at_channel', type: 'datetime', nullable: true })
  createdAtChannel: Date | null;

  @Column({ name: 'updated_at_channel', type: 'datetime', nullable: true })
  updatedAtChannel: Date | null;

  /** What was asked for (the plan's items): SKU lines and units; compared with the sum of its shipments. */
  @Column({ name: 'plan_sku_count', type: 'int', nullable: true })
  planSkuCount: number | null;

  @Column({ name: 'plan_units', type: 'int', nullable: true })
  planUnits: number | null;

  /** Shipments the channel made from the plan (0 = not split yet). */
  @Column({ name: 'shipment_count', type: 'int', default: 0 })
  shipmentCount: number;

  @Column({ name: 'first_seen_at', type: 'datetime' })
  firstSeenAt: Date;

  @Column({ name: 'last_checked_at', type: 'datetime' })
  lastCheckedAt: Date;

  /** fk_inbound_plans_facility */
  @ManyToOne(() => MasterFacility, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'facility_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_plans_facility' })
  facility: MasterFacility | null;
}

/** inbound_shipments: one row per channel shipment (Amazon FBA15...): our snapshot of it. */
@Entity({ name: TABLES.INBOUND_SHIPMENTS })
@Index('uq_inbound_shipments_ext', ['sourceSystem', 'externalId'], { unique: true })
@Index('idx_inbound_shipments_plan', ['planRowId'])
@Index('idx_inbound_shipments_status', ['status', 'statusSince'])
export class InboundShipment {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'source_system', type: 'varchar', length: 50 })
  sourceSystem: string;

  /** The channel's shipment id we use everywhere (Amazon FBA15...): = po_uploads.external_id. */
  @Column({ name: 'external_id', type: 'varchar', length: 40 })
  externalId: string;

  /** inbound_plans.id; null while its plan is not known yet. */
  @Column({ name: 'plan_row_id', type: 'int', nullable: true })
  planRowId: number | null;

  /** The channel's internal shipment id inside the plan (Amazon v2024 "sh..."). */
  @Column({ name: 'channel_shipment_id', type: 'varchar', length: 64, nullable: true })
  channelShipmentId: string | null;

  @Column({ name: 'name', type: 'varchar', length: 200, nullable: true })
  name: string | null;

  /** Destination warehouse (Amazon FC code, e.g. LKO1) and its city / pincode. */
  @Column({ name: 'fc_code', type: 'varchar', length: 20, nullable: true })
  fcCode: string | null;

  @Column({ name: 'fc_city', type: 'varchar', length: 100, nullable: true })
  fcCity: string | null;

  @Column({ name: 'fc_pincode', type: 'varchar', length: 10, nullable: true })
  fcPincode: string | null;

  @Column({ name: 'status', type: 'varchar', length: 30 })
  status: string;

  /** When we first saw it in this status (stuck warnings count from here). */
  @Column({ name: 'status_since', type: 'datetime' })
  statusSince: Date;

  @Column({ name: 'sku_count', type: 'int', nullable: true })
  skuCount: number | null;

  /** Units on the shipment (Amazon QuantityShipped) and received so far (QuantityReceived). */
  @Column({ name: 'units_planned', type: 'int', nullable: true })
  unitsPlanned: number | null;

  @Column({ name: 'units_received', type: 'int', nullable: true })
  unitsReceived: number | null;

  /** Hash of the sorted SKU + quantity list: same hash = lines unchanged (nothing to do). */
  @Column({ name: 'lines_fingerprint', type: 'char', length: 40, nullable: true })
  linesFingerprint: string | null;

  @Column({ name: 'lines_checked_at', type: 'datetime', nullable: true })
  linesCheckedAt: Date | null;

  @Column({ name: 'received_checked_at', type: 'datetime', nullable: true })
  receivedCheckedAt: Date | null;

  /** Our PO (po_uploads row) made from this shipment; null until the PO chain took it. */
  @Column({ name: 'po_upload_id', type: 'bigint', nullable: true })
  poUploadId: string | null;

  /** Why a person should look at it (lines changed after punching ...); null = nothing. Stuck warnings are computed. */
  @Column({ name: 'attention', type: 'varchar', length: 200, nullable: true })
  attention: string | null;

  @Column({ name: 'first_seen_at', type: 'datetime' })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'datetime' })
  lastSeenAt: Date;

  /** fk_inbound_shipments_plan */
  @ManyToOne(() => InboundPlan, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'plan_row_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_shipments_plan' })
  plan: InboundPlan | null;

  /** fk_inbound_shipments_po_upload */
  @ManyToOne(() => PoUpload, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'po_upload_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_shipments_po_upload' })
  poUpload: PoUpload | null;
}

/** inbound_shipment_lines: one row per SKU of a shipment, as the channel has it now. */
@Entity({ name: TABLES.INBOUND_SHIPMENT_LINES })
@Index('uq_inbound_lines_sku', ['shipmentId', 'sellerSku'], { unique: true })
export class InboundShipmentLine {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'shipment_id', type: 'int' })
  shipmentId: number;

  /** Our listing code at the channel (Amazon MSKU). */
  @Column({ name: 'seller_sku', type: 'varchar', length: 100 })
  sellerSku: string;

  /** Amazon FNSKU (what our Amazon SKU master is keyed by). */
  @Column({ name: 'fnsku', type: 'varchar', length: 40, nullable: true })
  fnsku: string | null;

  @Column({ name: 'asin', type: 'varchar', length: 20, nullable: true })
  asin: string | null;

  /** Units on the shipment (QuantityShipped) and received (QuantityReceived; null until read). */
  @Column({ name: 'qty_planned', type: 'int' })
  qtyPlanned: number;

  @Column({ name: 'qty_received', type: 'int', nullable: true })
  qtyReceived: number | null;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  /** fk_inbound_lines_shipment: the lines go with their shipment. */
  @ManyToOne(() => InboundShipment, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_lines_shipment' })
  shipment: InboundShipment;
}

/** inbound_shipment_events: every change we saw on a shipment (the channel keeps no history). */
@Entity({ name: TABLES.INBOUND_SHIPMENT_EVENTS })
@Index('idx_inbound_events_shipment', ['shipmentId', 'seenAt'])
export class InboundShipmentEvent {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'shipment_id', type: 'int' })
  shipmentId: number;

  @Column({ name: 'kind', type: 'enum', enum: Object.values(INBOUND_EVENT) })
  kind: InboundEventKind;

  @Column({ name: 'old_value', type: 'varchar', length: 200, nullable: true })
  oldValue: string | null;

  @Column({ name: 'new_value', type: 'varchar', length: 200, nullable: true })
  newValue: string | null;

  /** Extra facts (lines old -> new per SKU, received per SKU ...). */
  @Column({ name: 'detail', type: 'json', nullable: true })
  detail: Record<string, unknown> | null;

  @Column({ name: 'source', type: 'enum', enum: Object.values(INBOUND_EVENT_SOURCE) })
  source: InboundEventSource;

  /** When we saw it (Amazon gives no change time). */
  @Column({ name: 'seen_at', type: 'datetime' })
  seenAt: Date;

  /** fk_inbound_events_shipment */
  @ManyToOne(() => InboundShipment, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_events_shipment' })
  shipment: InboundShipment;
}

/**
 * inbound_status_limits: "stuck" warning limits in days per status (user, 2026-10-19), editable; a row with a
 * courier_partner_id applies to that courier only (IN_TRANSIT varies by courier), the row without one is the default.
 */
@Entity({ name: TABLES.INBOUND_STATUS_LIMITS })
@Index('uq_inbound_limits', ['sourceSystem', 'status', 'courierPartnerId'], { unique: true })
export class InboundStatusLimit {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'source_system', type: 'varchar', length: 50 })
  sourceSystem: string;

  @Column({ name: 'status', type: 'varchar', length: 30 })
  status: string;

  @Column({ name: 'courier_partner_id', type: 'int', nullable: true })
  courierPartnerId: number | null;

  @Column({ name: 'max_days', type: 'int' })
  maxDays: number;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt: Date;

  /** fk_inbound_limits_courier */
  @ManyToOne(() => MasterCourierPartner, { nullable: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'courier_partner_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_limits_courier' })
  courierPartner: MasterCourierPartner | null;

  /** fk_inbound_limits_user */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_inbound_limits_user' })
  updater: User | null;
}
