import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_SOURCE, MasterSource, TABLES } from '../constants/db';
import { MasterCourierPartner } from './master-courier-partner.entity';
import { decimal } from './transformers';

/**
 * master_courier_rates: rate per kg of a transporter from a pickup city to a drop city (PEPIMS courier_rate_masters).
 * pickup_location matches master_facilities.pickup_location, drop_location matches details_channels.drop_location
 * (city names as text: there is no city master yet).
 */
@Entity({ name: TABLES.MASTER_COURIER_RATES })
@Index('uq_master_courier_rates_route', ['courierPartnerId', 'pickupLocation', 'dropLocation'], { unique: true })
export class MasterCourierRate {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'courier_partner_id', type: 'int' })
  courierPartnerId: number;

  @Column({ name: 'pickup_location', type: 'varchar', length: 100 })
  pickupLocation: string;

  @Column({ name: 'drop_location', type: 'varchar', length: 100 })
  dropLocation: string;

  @Column({ name: 'rate_per_kg', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  ratePerKg: number | null;

  @Column({ name: 'tat_days', type: 'int', nullable: true })
  tatDays: number | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_SOURCE), default: MASTER_SOURCE.MANUAL })
  source: MasterSource;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** fk_courier_rates_partner: a partner in use cannot be deleted. */
  @ManyToOne(() => MasterCourierPartner, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'courier_partner_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_courier_rates_partner' })
  courierPartner: MasterCourierPartner;
}
