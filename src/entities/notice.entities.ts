import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';

/**
 * One notice (2026-11-10, constants/notices.ts): one row even when it goes to everyone (to_user_id NULL). Deleted 2
 * days after created_at. reply_to_id = the notice it answers (may be gone already).
 */
@Entity({ name: TABLES.NOTICES })
@Index('idx_notices_created', ['createdAt'])
export class Notice {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'from_user_id', type: 'int' })
  fromUserId: number;

  /** NULL = everyone. */
  @Column({ name: 'to_user_id', type: 'int', nullable: true })
  toUserId: number | null;

  @Column({ name: 'text', type: 'varchar', length: 500 })
  text: string;

  /** An in-app page path, or NULL. */
  @Column({ name: 'link', type: 'varchar', length: 300, nullable: true })
  link: string | null;

  @Column({ name: 'reply_to_id', type: 'bigint', nullable: true })
  replyToId: string | null;

  /** The start of the notice it answers (kept here: that notice may be deleted first). */
  @Column({ name: 'reply_quote', type: 'varchar', length: 60, nullable: true })
  replyQuote: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;
}

/** The newest notice id each person has seen (opened the bell): everything up to it counts as read. */
@Entity({ name: TABLES.NOTICE_SEEN })
export class NoticeSeen {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'seen_id', type: 'bigint' })
  seenId: string;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}
