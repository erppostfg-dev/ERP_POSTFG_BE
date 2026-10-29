import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { CATCHUP_STATUS, CatchupStatus, TABLES } from '../constants';

/*
 * Gmail intake (2026-10-29, constants/gmail-intake.ts). No links to other tables: channel is a constants CHANNELS value
 * (as channel_intake_settings), the Gmail id is Gmail's.
 */

/**
 * gmail_messages: every Po-Intake email once we have read it (headers or full). channel = whose sender it is (null =
 * no channel's); done_at = sent to the intake / already stored / no longer labelled, so never read again; null = left
 * in Gmail (its channel OFF or before its start): a catch-up of that channel takes it from here, with no Gmail call.
 */
@Entity({ name: TABLES.GMAIL_MESSAGES })
@Index('idx_gmail_messages_channel', ['channel', 'doneAt', 'receivedAt'])
export class GmailMessage {
  @PrimaryColumn({ name: 'gmail_id', type: 'varchar', length: 32 })
  gmailId: string;

  @Column({ name: 'channel', type: 'varchar', length: 40, nullable: true })
  channel: string | null;

  @Column({ name: 'subject', type: 'varchar', length: 300, default: '' })
  subject: string;

  @Column({ name: 'received_at', type: 'datetime', precision: 6, nullable: true })
  receivedAt: Date | null;

  @Column({ name: 'done_at', type: 'datetime', precision: 6, nullable: true })
  doneAt: Date | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;
}

/**
 * intake_catchups: one row per email channel: the last catch-up asked (switched ON / start moved earlier) and how it
 * went. waiting / failed rows are run when next_try_at comes (also after a restart), several channels in one pass.
 */
@Entity({ name: TABLES.INTAKE_CATCHUPS })
export class IntakeCatchup {
  @PrimaryColumn({ name: 'channel', type: 'varchar', length: 40 })
  channel: string;

  /** Emails received from this time on. */
  @Column({ name: 'from_at', type: 'datetime', precision: 6 })
  fromAt: Date;

  @Column({ name: 'status', type: 'enum', enum: Object.values(CATCHUP_STATUS), default: CATCHUP_STATUS.WAITING })
  status: CatchupStatus;

  /** Failed tries since it was asked. */
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'next_try_at', type: 'datetime', precision: 6, nullable: true })
  nextTryAt: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  /** The channel's emails in the label from from_at (last run) and how many were newly sent. */
  @Column({ name: 'found', type: 'int', nullable: true })
  found: number | null;

  @Column({ name: 'sent', type: 'int', nullable: true })
  sent: number | null;

  @Column({ name: 'requested_at', type: 'datetime', precision: 6 })
  requestedAt: Date;

  @Column({ name: 'finished_at', type: 'datetime', precision: 6, nullable: true })
  finishedAt: Date | null;
}
