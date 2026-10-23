import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { INTAKE_EMAIL_KIND, IntakeEmailKind, TABLES } from '../constants';

/**
 * intake_emails (2026-10-23): one row for every email / API / manual PO folder POST_FG stored, PO or not. It answers
 * "do we already have this email?" without the local folder, so finished folders can be removed from the server's
 * disk (their files stay in S3). message_key = the 16-char key the local folder name ends with (sha1 of the Message-ID).
 */
@Entity({ name: TABLES.INTAKE_EMAILS })
@Index('uq_intake_emails_message_key', ['messageKey'], { unique: true })
@Index('idx_intake_emails_group_kind', ['groupName', 'kind'])
export class IntakeEmail {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'message_key', type: 'char', length: 16 })
  messageKey: string;

  @Column({ name: 'message_id', type: 'text' })
  messageId: string;

  /** gmail-pubsub, manual or channel-api (constants/folders PROVIDERS). */
  @Column({ name: 'provider', type: 'varchar', length: 30, nullable: true })
  provider: string | null;

  /** The storage group it belongs to (the Gmail label folder, manual, channel-api), without -not-po. */
  @Column({ name: 'group_name', type: 'varchar', length: 100 })
  groupName: string;

  @Column({ name: 'kind', type: 'enum', enum: Object.values(INTAKE_EMAIL_KIND) })
  kind: IntakeEmailKind;

  /** constants/channels CHANNELS value when known. */
  @Column({ name: 'channel', type: 'varchar', length: 50, nullable: true })
  channel: string | null;

  @Column({ name: 'from_address', type: 'varchar', length: 320, nullable: true })
  fromAddress: string | null;

  @Column({ name: 'subject', type: 'text', nullable: true })
  subject: string | null;

  @Column({ name: 'received_at', type: 'datetime', nullable: true })
  receivedAt: Date | null;

  @Column({ name: 'stored_at', type: 'datetime' })
  storedAt: Date;

  /** Local folder name (<received date>_<message_key>), the same under <group>/ and <group>-not-po/. */
  @Column({ name: 'folder_name', type: 'varchar', length: 200 })
  folderName: string;

  @Column({ name: 's3_folder', type: 'varchar', length: 500, nullable: true })
  s3Folder: string | null;

  /** Attachment names (the not-PO report lists them). */
  @Column({ name: 'files', type: 'json', nullable: true })
  files: string[] | null;

  /** Not a PO: why (email-sorter reason.json). */
  @Column({ name: 'not_po_code', type: 'varchar', length: 50, nullable: true })
  notPoCode: string | null;

  @Column({ name: 'not_po_reason', type: 'varchar', length: 500, nullable: true })
  notPoReason: string | null;

  /** When the local folder was removed by the cleanup (files in S3); null = still on the server's disk. */
  @Column({ name: 'local_removed_at', type: 'datetime', nullable: true })
  localRemovedAt: Date | null;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
