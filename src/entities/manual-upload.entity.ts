import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { MANUAL_UPLOAD_STATUS, ManualUploadStatus, TABLES } from '../constants';
import { User } from './auth.entities';

export interface ManualUploadFile {
  filename: string;
  size: number;
  /** sha1 of the bytes: the same file uploaded again is flagged. */
  sha1: string;
}

/**
 * manual_uploads (2026-10-22, user): the Manual Upload queue. One row per PO upload (one or two files, as the channel's
 * reader needs). Its folder holds the files like an email's; its po_uploads rows are found by
 * email_message_id = "manual-upload:<id>" once processing starts. Nothing is deleted: a cancel keeps the row.
 */
@Entity({ name: TABLES.MANUAL_UPLOADS })
@Index('idx_manual_uploads_status', ['status', 'id'])
@Index('idx_manual_uploads_external', ['channel', 'externalId'])
export class ManualUpload {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  /** constants/channels CHANNELS value (the reader's channel). */
  @Column({ name: 'channel', type: 'varchar', length: 50 })
  channel: string;

  /** Amazon: the FBA shipment id read from the uploaded file (the duplicate check); null for file channels. */
  @Column({ name: 'external_id', type: 'varchar', length: 64, nullable: true })
  externalId: string | null;

  @Column({ name: 'files', type: 'json' })
  files: ManualUploadFile[];

  /** Local folder (storage/emails/manual-upload/<date>_<id>) and its S3 folder. */
  @Column({ name: 'folder', type: 'varchar', length: 500 })
  folder: string;

  @Column({ name: 's3_folder', type: 'varchar', length: 500, nullable: true })
  s3Folder: string | null;

  @Column({ name: 'status', type: 'enum', enum: Object.values(MANUAL_UPLOAD_STATUS), default: MANUAL_UPLOAD_STATUS.UPLOADED })
  status: ManualUploadStatus;

  /** Why it failed, or a warning (same file uploaded before). */
  @Column({ name: 'note', type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ name: 'uploaded_by', type: 'int' })
  uploadedBy: number;

  @Column({ name: 'uploaded_at', type: 'datetime' })
  uploadedAt: Date;

  @Column({ name: 'process_by', type: 'int', nullable: true })
  processBy: number | null;

  @Column({ name: 'process_at', type: 'datetime', nullable: true })
  processAt: Date | null;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt: Date | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_manual_uploads_uploaded_by' })
  uploader?: User;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'process_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_manual_uploads_process_by' })
  processor?: User;
}
