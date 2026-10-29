import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import {
  TABLES,
  UPLOAD_OCR_STATUS,
  UPLOAD_SOURCE,
  UPLOAD_STATUS,
  UploadOcrStatus,
  UploadSource,
  UploadStatus,
} from '../constants/db';
import { User } from './auth.entities';
import { MasterChannel } from './master-channel.entity';
import { MasterPurchaseOrder } from './master-purchase-order.entity';
import type { PoIssue } from './po-issue.entity';

/**
 * po_uploads: ONE ROW PER PO (user, 2026-10-08), by email, manual upload or API, with its OCR summary and status.
 * An email is one row at intake (po_number empty); after processing, an email with several POs (Purplle) gets one row
 * per PO, so the same mail is never stored twice: unique (email_message_id, po_number). source 'api' and this key are
 * the user's ALTER of 2026-10-08 (they own the table).
 */
@Entity({ name: TABLES.PO_UPLOADS })
@Index('idx_po_uploads_status', ['status', 'createdAt'])
@Index('idx_po_uploads_po_number', ['poNumber'])
@Index('uq_po_uploads_message_po', ['emailMessageId', 'poNumber'], { unique: true })
@Index('uq_po_uploads_source_external', ['sourceSystem', 'externalId'], { unique: true })
export class PoUpload {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'source', type: 'enum', enum: Object.values(UPLOAD_SOURCE) })
  source: UploadSource;

  /** master_channels.display_name; null until detected. */
  @Column({ name: 'channel', type: 'varchar', length: 100, nullable: true })
  channel: string | null;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  /** S3 key of the PO file. */
  @Column({ name: 'file_url', type: 'varchar', length: 500 })
  fileUrl: string;

  /** pdf, xlsx, xls, csv. */
  @Column({ name: 'file_type', type: 'varchar', length: 20, nullable: true })
  fileType: string | null;

  // --- email intake only ---
  /** The same mail is never processed twice. */
  @Column({ name: 'email_message_id', type: 'varchar', length: 255, nullable: true })
  emailMessageId: string | null;

  @Column({ name: 'email_from', type: 'varchar', length: 255, nullable: true })
  emailFrom: string | null;

  @Column({ name: 'email_subject', type: 'varchar', length: 500, nullable: true })
  emailSubject: string | null;

  @Column({ name: 'email_received_at', type: 'datetime', nullable: true })
  emailReceivedAt: Date | null;

  // --- channel API only (2026-10-16): which connector and the channel's own id; both null for email / manual ---
  /** The connector (constants SOURCE_SYSTEM, e.g. amazon_spapi). */
  @Column({ name: 'source_system', type: 'varchar', length: 50, nullable: true })
  sourceSystem: string | null;

  /** The channel's id of this PO (Amazon: the FBA shipment id); unique per source_system, so it is never taken twice. */
  @Column({ name: 'external_id', type: 'varchar', length: 100, nullable: true })
  externalId: string | null;

  // --- manual upload only ---
  /** User email; null for email intake. */
  @Column({ name: 'uploaded_by', type: 'varchar', length: 255, nullable: true })
  uploadedBy: string | null;

  // --- OCR ---
  @Column({ name: 'ocr_status', type: 'enum', enum: Object.values(UPLOAD_OCR_STATUS), default: UPLOAD_OCR_STATUS.PENDING })
  ocrStatus: UploadOcrStatus;

  /** OCR summary (user, 2026-10-08): S3 keys of the raw output and processed.json, input type, lines, cost, warnings. The full raw output stays in S3. */
  @Column({ name: 'ocr_result', type: 'json', nullable: true })
  ocrResult: Record<string, unknown> | null;

  @Column({ name: 'ocr_started_at', type: 'datetime', nullable: true })
  ocrStartedAt: Date | null;

  @Column({ name: 'ocr_finished_at', type: 'datetime', nullable: true })
  ocrFinishedAt: Date | null;

  @Column({ name: 'ocr_attempts', type: 'tinyint', default: 0 })
  ocrAttempts: number;

  // --- result ---
  /** Copied from the OCR result, for search. */
  @Column({ name: 'po_number', type: 'varchar', length: 255, nullable: true })
  poNumber: string | null;

  /** The PO created from this upload (master_purchase_orders.uid). */
  @Column({ name: 'po_uid', type: 'bigint', nullable: true })
  poUid: string | null;

  /** S3 key of the generated Uniware CSV. */
  @Column({ name: 'uniware_csv_url', type: 'varchar', length: 500, nullable: true })
  uniwareCsvUrl: string | null;

  // --- Uniware hand-off (2026-10-19): CSV downloaded, then marked uploaded into Uniware (then shown in PO Overview) ---
  /** First download of the sale order CSV (later downloads keep this date). */
  @Column({ name: 'csv_downloaded_at', type: 'datetime', nullable: true })
  csvDownloadedAt: Date | null;

  /** users.id of that first download. */
  @Column({ name: 'csv_downloaded_by', type: 'int', nullable: true })
  csvDownloadedBy: number | null;

  /** When someone marked the CSV uploaded into Uniware; null = not yet (the PO stays out of PO Overview). */
  @Column({ name: 'uniware_uploaded_at', type: 'datetime', nullable: true })
  uniwareUploadedAt: Date | null;

  @Column({ name: 'uniware_uploaded_by', type: 'int', nullable: true })
  uniwareUploadedBy: number | null;

  /**
   * The PO's own date as read from the PO (processed.json po_date, YYYY-MM-DD), written every time the chain checks the
   * PO (2026-10-29, user: PO Date on the In Review tab, where no saved PO exists yet). Null when the PO has none.
   */
  @Column({ name: 'po_date', type: 'date', nullable: true })
  poDate: string | null;

  /** PO intake (2026-10-23): when a HELD PO was let go; it counts against THAT day's limit, not its arrival day's. */
  @Column({ name: 'released_at', type: 'datetime', nullable: true })
  releasedAt: Date | null;

  @Column({ name: 'status', type: 'enum', enum: Object.values(UPLOAD_STATUS), default: UPLOAD_STATUS.QUEUED })
  status: UploadStatus;

  /** Technical failures only (crash, timeout), not data problems. */
  @Column({ name: 'error_details', type: 'json', nullable: true })
  errorDetails: Record<string, unknown> | null;

  /** Set by MySQL (DEFAULT CURRENT_TIMESTAMP); plain datetime in the live table. */
  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', update: false })
  createdAt: Date;

  /** Set by MySQL (DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP); never written by the app (update: false). */
  @Column({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP', update: false })
  updatedAt: Date;

  @Column({ name: 'completed_at', type: 'datetime', nullable: true })
  completedAt: Date | null;

  /** fk_po_uploads_po: po_uid -> master_purchase_orders.uid. */
  @ManyToOne(() => MasterPurchaseOrder, { nullable: true })
  @JoinColumn({ name: 'po_uid', referencedColumnName: 'uid', foreignKeyConstraintName: 'fk_po_uploads_po' })
  purchaseOrder: MasterPurchaseOrder | null;

  /** fk_po_uploads_csv_downloaded_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'csv_downloaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_uploads_csv_downloaded_by' })
  csvDownloader: User | null;

  /** fk_po_uploads_uniware_uploaded_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'uniware_uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_uploads_uniware_uploaded_by' })
  uniwareUploader: User | null;

  /** fk_po_uploads_channel: channel -> master_channels.display_name. */
  @ManyToOne(() => MasterChannel, { nullable: true, onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'channel', referencedColumnName: 'displayName', foreignKeyConstraintName: 'fk_po_uploads_channel' })
  channelRef: MasterChannel | null;

  @OneToMany('PoIssue', (issue: PoIssue) => issue.upload)
  issues: PoIssue[];
}
