import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { MasterChannel } from './master-channel.entity';
import { MasterFacility } from './master-facility.entity';

/**
 * details_channels: one delivery location of a channel, with its billing / shipping details (was customer_details).
 * The location match of a PO uses channel_location_code (or consignee_pin_code, e.g. Purplle by pincode).
 * Matches the LIVE table (checked 2026-10-08): it also has channel_id (NOT NULL, FK to master_channels.id).
 * 2026-10-14: facility_id (link to master_facilities, filled by masters:link from facility_code), PEPIMS's channel
 * location fields (channel_category, drop_location, appointment_channel / _type, loaded by masters:load channel) and
 * is_active (a location switched off is no longer matched to POs).
 */
@Entity({ name: TABLES.DETAILS_CHANNELS })
export class DetailsChannel {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** master_channels.id (live table only, not in final_schema.sql; NOT NULL; FK fk_details_channel). */
  @Column({ name: 'channel_id', type: 'int' })
  channelId: number;

  /** master_channels.display_name. */
  @Column({ name: 'channel_name', type: 'varchar', length: 100 })
  channelName: string;

  @Column({ name: 'channel_location_code', type: 'varchar', length: 100, nullable: true })
  channelLocationCode: string | null;

  @Column({ name: 'uniware_customer_code', type: 'varchar', length: 255, nullable: true })
  uniwareCustomerCode: string | null;

  @Column({ name: 'tally_ledger_name', type: 'varchar', length: 255, nullable: true })
  tallyLedgerName: string | null;

  @Column({ name: 'final_billing_address', type: 'text', nullable: true })
  finalBillingAddress: string | null;

  @Column({ name: 'buyer_type', type: 'varchar', length: 100, nullable: true })
  buyerType: string | null;

  @Column({ name: 'buyer_gst_number', type: 'varchar', length: 50, nullable: true })
  buyerGstNumber: string | null;

  @Column({ name: 'buyer_state', type: 'varchar', length: 100, nullable: true })
  buyerState: string | null;

  @Column({ name: 'buyer_pin_code', type: 'varchar', length: 20, nullable: true })
  buyerPinCode: string | null;

  @Column({ name: 'consignee_name', type: 'varchar', length: 255, nullable: true })
  consigneeName: string | null;

  @Column({ name: 'consignee_state', type: 'varchar', length: 100, nullable: true })
  consigneeState: string | null;

  @Column({ name: 'consignee_gst_number', type: 'varchar', length: 50, nullable: true })
  consigneeGstNumber: string | null;

  @Column({ name: 'consignee_pin_code', type: 'varchar', length: 20, nullable: true })
  consigneePinCode: string | null;

  @Column({ name: 'final_shipping_address', type: 'text', nullable: true })
  finalShippingAddress: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, nullable: true })
  createdAt: Date | null;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, nullable: true })
  updatedAt: Date | null;

  @Column({ name: 'channel_code', type: 'varchar', length: 100, nullable: true })
  channelCode: string | null;

  @Column({ name: 'facility_code', type: 'varchar', length: 100, nullable: true })
  facilityCode: string | null;

  /** master_facilities.id resolved from facility_code (code or alias); null = not matched yet. */
  @Column({ name: 'facility_id', type: 'int', nullable: true })
  facilityId: number | null;

  /** PEPIMS channelCategory / channelType (B2B, B2C, D2C): the shipment's Channel Type. */
  @Column({ name: 'channel_category', type: 'varchar', length: 50, nullable: true })
  channelCategory: string | null;

  /** City the shipment goes to (PEPIMS dropLocation): the "to" of master_courier_rates. */
  @Column({ name: 'drop_location', type: 'varchar', length: 100, nullable: true })
  dropLocation: string | null;

  /** Does the location need an appointment, and where it is booked (PEPIMS apptChannel / apptChannelType). */
  @Column({ name: 'appointment_channel', type: 'varchar', length: 100, nullable: true })
  appointmentChannel: string | null;

  @Column({ name: 'appointment_channel_type', type: 'varchar', length: 100, nullable: true })
  appointmentChannelType: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'final_shipping_address_embedding', type: 'json', nullable: true })
  finalShippingAddressEmbedding: unknown;

  @Column({ name: 'final_billing_address_embedding', type: 'json', nullable: true })
  finalBillingAddressEmbedding: unknown;

  /** fk_details_channel: channel_id -> master_channels.id. */
  @ManyToOne(() => MasterChannel)
  @JoinColumn({ name: 'channel_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_details_channel' })
  channelById: MasterChannel;

  /** fk_details_channels_channel: channel_name -> master_channels.display_name. */
  @ManyToOne(() => MasterChannel, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'channel_name', referencedColumnName: 'displayName', foreignKeyConstraintName: 'fk_details_channels_channel' })
  channel: MasterChannel;

  /** fk_details_channels_facility: a facility in use cannot be deleted. */
  @ManyToOne(() => MasterFacility, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'facility_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_details_channels_facility' })
  facility: MasterFacility | null;
}
