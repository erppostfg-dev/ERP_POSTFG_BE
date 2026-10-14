import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_SOURCE, MasterSource, TABLES } from '../constants/db';
import { decimal } from './transformers';

/**
 * master_courier_partners: transporters (PEPIMS courier_partner_masters + the TAT PEPIMS kept only in its frontend).
 * code = PEPIMS courierPartnerMode, the name a shipment's transporter columns hold (e.g. "Rivigo - PTL").
 * master_purchase_orders.first/second/thirdTransporterId link here.
 */
@Entity({ name: TABLES.MASTER_COURIER_PARTNERS })
@Index('uq_master_courier_partners_code', ['code'], { unique: true })
export class MasterCourierPartner {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'code', type: 'varchar', length: 150 })
  code: string;

  @Column({ name: 'aliases', type: 'json', nullable: true })
  aliases: string[] | null;

  /** The company (e.g. Rivigo). */
  @Column({ name: 'partner', type: 'varchar', length: 100, nullable: true })
  partner: string | null;

  /** PTL, Air, Train, Local ... */
  @Column({ name: 'mode', type: 'varchar', length: 50, nullable: true })
  mode: string | null;

  /** PEPIMS courierType (Type A / B ...). */
  @Column({ name: 'courier_type', type: 'varchar', length: 50, nullable: true })
  courierType: string | null;

  @Column({ name: 'appointment_charge_yes', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  appointmentChargeYes: number | null;

  @Column({ name: 'appointment_charge_no', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  appointmentChargeNo: number | null;

  @Column({ name: 'docket_charges', type: 'decimal', precision: 10, scale: 2, nullable: true, transformer: decimal })
  docketCharges: number | null;

  /** Transit days: Critical Dispatch Date = appointment date - TAT (a rate's own TAT wins when it has one). */
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
}
