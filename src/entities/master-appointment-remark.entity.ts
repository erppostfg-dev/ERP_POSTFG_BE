import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MASTER_SOURCE, MasterSource, REMARK_LIST, RemarkList, TABLES } from '../constants/db';

/**
 * master_appointment_remarks: the remark dropdowns of a shipment (PEPIMS appointment_remark_masters + its RTO and
 * rejection lists). list = which dropdown (ENUM, ours); category = PEPIMS's group inside it (e.g. "Appointment Miss").
 */
@Entity({ name: TABLES.MASTER_APPOINTMENT_REMARKS })
@Index('uq_master_appointment_remarks_list_remark', ['list', 'remark'], { unique: true })
export class MasterAppointmentRemark {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'list', type: 'enum', enum: Object.values(REMARK_LIST) })
  list: RemarkList;

  @Column({ name: 'remark', type: 'varchar', length: 255 })
  remark: string;

  @Column({ name: 'category', type: 'varchar', length: 100, nullable: true })
  category: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'source', type: 'enum', enum: Object.values(MASTER_SOURCE), default: MASTER_SOURCE.MANUAL })
  source: MasterSource;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
