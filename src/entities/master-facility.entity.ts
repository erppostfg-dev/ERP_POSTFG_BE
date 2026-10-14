import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_SOURCE, MasterSource, TABLES } from '../constants/db';

/**
 * master_facilities: our dispatch warehouses, one row per Uniware facility (PEPIMS facility_masters + the Warehouses
 * screen's fields). details_channels.facility_id and master_purchase_orders.facilityId link here.
 * code is unique ignoring case, so two spellings can never become two facilities: other spellings go in aliases.
 * Rows are never deleted: is_active = false; source tells where a row came from (masters:load).
 */
@Entity({ name: TABLES.MASTER_FACILITIES })
@Index('uq_master_facilities_code', ['code'], { unique: true })
export class MasterFacility {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** The Uniware facility code (e.g. MUM_WAREHOUSE2): written to the Uniware CSV. */
  @Column({ name: 'code', type: 'varchar', length: 100 })
  code: string;

  /** Other spellings found in the data (e.g. ["MUM_Warehouse2"]): masters:link matches them to this row. */
  @Column({ name: 'aliases', type: 'json', nullable: true })
  aliases: string[] | null;

  @Column({ name: 'name', type: 'varchar', length: 255, nullable: true })
  name: string | null;

  /** Legal entity that owns the stock (PEP, KREATIVE): text until the real list is known. */
  @Column({ name: 'entity', type: 'varchar', length: 100, nullable: true })
  entity: string | null;

  /** City the courier picks up from (PEPIMS pickupLocation): the "from" of master_courier_rates. */
  @Column({ name: 'pickup_location', type: 'varchar', length: 100, nullable: true })
  pickupLocation: string | null;

  @Column({ name: 'state', type: 'varchar', length: 100, nullable: true })
  state: string | null;

  /** MWH / CWH: text until the real list is known. */
  @Column({ name: 'facility_type', type: 'varchar', length: 50, nullable: true })
  facilityType: string | null;

  @Column({ name: 'bill_to_gstin', type: 'varchar', length: 20, nullable: true })
  billToGstin: string | null;

  @Column({ name: 'ship_to_gstin', type: 'varchar', length: 20, nullable: true })
  shipToGstin: string | null;

  @Column({ name: 'remarks', type: 'text', nullable: true })
  remarks: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_SOURCE), default: MASTER_SOURCE.MANUAL })
  source: MasterSource;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
