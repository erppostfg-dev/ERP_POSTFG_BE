import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { UNIWARE_CREATE_STATUS, UniwareCreateStatus } from '../constants/uniware-create';

/**
 * uniware_creates (2026-11-09, constants/uniware-create.ts): one row per "Create in Uniware" request of one PO, worked
 * by modules/uniware-create. Kept as the record of what was sent and what Uniware answered; nothing is deleted.
 */
@Entity({ name: TABLES.UNIWARE_CREATES })
@Index('idx_uniware_creates_status', ['status', 'id'])
@Index('idx_uniware_creates_upload', ['uploadId', 'id'])
export class UniwareCreate {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  @Column({ name: 'po_uid', type: 'bigint' })
  poUid: string;

  @Column({ name: 'sale_order_code', type: 'varchar', length: 45 })
  saleOrderCode: string;

  @Column({ name: 'facility', type: 'varchar', length: 100 })
  facility: string;

  @Column({ name: 'status', type: 'enum', enum: Object.values(UNIWARE_CREATE_STATUS), default: UNIWARE_CREATE_STATUS.QUEUED })
  status: UniwareCreateStatus;

  /** Tries so far (each one reads Uniware first). */
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  /** Why it failed (Uniware's own errors, or what was missing before calling it). */
  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  /** Units sent (one item per unit) and the order value, for the record. */
  @Column({ name: 'items', type: 'int', nullable: true })
  items: number | null;

  @Column({ name: 'order_value', type: 'decimal', precision: 14, scale: 2, nullable: true })
  orderValue: string | null;

  @Column({ name: 'requested_by', type: 'int' })
  requestedBy: number;

  @Column({ name: 'requested_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  requestedAt: Date;

  @Column({ name: 'started_at', type: 'datetime', precision: 6, nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'datetime', precision: 6, nullable: true })
  finishedAt: Date | null;
}
