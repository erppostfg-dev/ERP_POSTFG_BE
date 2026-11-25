import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import {
  UNIWARE_OUTSIDE_ACTION, UNIWARE_OUTSIDE_KIND, UNIWARE_OUTSIDE_STATE, UniwareOutsideAction, UniwareOutsideKind, UniwareOutsideState,
} from '../constants/uniware-outside';

/**
 * uniware_outside_orders (2026-11-25, constants/uniware-outside.ts): a Uniware sale order (found by the read-only
 * search) for a PO that POST_FG has In Review, Rejected, or Processed but not uploaded, under another code than ours.
 * One row per (Uniware code, upload); only matches are stored; nothing is deleted (resolved rows are the record).
 */
@Entity({ name: TABLES.UNIWARE_OUTSIDE_ORDERS })
@Index('uq_uniware_outside_code_upload', ['uniwareCode', 'uploadId'], { unique: true })
@Index('idx_uniware_outside_upload', ['uploadId', 'state'])
@Index('idx_uniware_outside_state', ['state', 'kind'])
export class UniwareOutsideOrder {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'uniware_code', type: 'varchar', length: 100 })
  uniwareCode: string;

  @Column({ name: 'uniware_channel', type: 'varchar', length: 100 })
  uniwareChannel: string;

  /** Uniware's displayOrderCode (= the PO number it was matched on). */
  @Column({ name: 'display_order_code', type: 'varchar', length: 255 })
  displayOrderCode: string;

  @Column({ name: 'uniware_status', type: 'varchar', length: 50, nullable: true })
  uniwareStatus: string | null;

  @Column({ name: 'uniware_created_at', type: 'datetime', nullable: true })
  uniwareCreatedAt: Date | null;

  @Column({ name: 'upload_id', type: 'bigint' })
  uploadId: string;

  @Column({ name: 'kind', type: 'enum', enum: Object.values(UNIWARE_OUTSIDE_KIND) })
  kind: UniwareOutsideKind;

  @Column({ name: 'state', type: 'enum', enum: Object.values(UNIWARE_OUTSIDE_STATE), default: UNIWARE_OUTSIDE_STATE.OPEN })
  state: UniwareOutsideState;

  @Column({ name: 'resolution', type: 'enum', enum: Object.values(UNIWARE_OUTSIDE_ACTION), nullable: true })
  resolution: UniwareOutsideAction | null;

  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  @Column({ name: 'resolved_by', type: 'int', nullable: true })
  resolvedBy: number | null;

  @Column({ name: 'resolved_at', type: 'datetime', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'first_seen_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  lastSeenAt: Date;
}
