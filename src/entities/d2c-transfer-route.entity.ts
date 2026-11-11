import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { DetailsChannel } from './details-channel.entity';
import { MasterFacility } from './master-facility.entity';

/**
 * d2c_transfer_routes (D2C internal transfers, 2026-11-03; plan "Route codes from the user's sheet"): one row per
 * route = (dispatch facility, transfer location, Uniware channel). The transfer location is a details_channels row (channel + location
 * short name + transfer_facility_id = receiving facility). Holds the codes Uniware needs for that route: the SO's
 * channel and customer (they depend on sender + channel + location) and the inward PO's vendor (it depends on sender +
 * receiving facility). Loaded from the user's sheet (npm run d2c:routes-load), edited in Masters (history in
 * master_change_logs, type transfer_route). Never deleted: switched off (is_active = 0). A (sender, location) pair with
 * 2+ active rows = 2+ Uniware channels: Ops pick one per transfer (master_purchase_orders.transferRouteId).
 */
@Entity({ name: TABLES.D2C_TRANSFER_ROUTES })
// 2026-11-03 (D2cRouteChannels1794000000000): a route may have 2+ Uniware channels, so the channel is part of the key
@Index('uq_d2c_transfer_routes_route_channel', ['dispatchFacilityId', 'locationId', 'uniwareChannelCode'], { unique: true })
@Index('idx_d2c_transfer_routes_location', ['locationId'])
export class D2cTransferRoute {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** master_facilities.id of the SENDING (dispatch) facility. */
  @Column({ name: 'dispatch_facility_id', type: 'int' })
  dispatchFacilityId: number;

  /** details_channels.id of the transfer location (its transfer_facility_id = the receiving facility). */
  @Column({ name: 'location_id', type: 'bigint' })
  locationId: string;

  /** Uniware channel code of the SO (e.g. D2C_TRANSFER_MCAFF, D2C_TRANSFER_MCAFF_L = same state). */
  @Column({ name: 'uniware_channel_code', type: 'varchar', length: 100, nullable: true })
  uniwareChannelCode: string | null;

  /** Uniware customer code of the SO (e.g. MCAFFEINEB2C_KOLKATA3). */
  @Column({ name: 'customer_code', type: 'varchar', length: 100, nullable: true })
  customerCode: string | null;

  @Column({ name: 'customer_name', type: 'varchar', length: 255, nullable: true })
  customerName: string | null;

  /** Uniware vendor code of the inward PO at the receiving facility; null = missing (shown as "vendor missing"). */
  @Column({ name: 'vendor_code', type: 'varchar', length: 100, nullable: true })
  vendorCode: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** fk_d2c_transfer_routes_facility */
  @ManyToOne(() => MasterFacility, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'dispatch_facility_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_d2c_transfer_routes_facility' })
  dispatchFacility: MasterFacility;

  /** fk_d2c_transfer_routes_location */
  @ManyToOne(() => DetailsChannel, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'location_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_d2c_transfer_routes_location' })
  location: DetailsChannel;
}
