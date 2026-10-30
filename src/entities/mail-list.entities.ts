import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants';
import { User } from './auth.entities';

/**
 * mail_list_settings (2026-10-30, user): a mail of MAIL_LISTS switched off / on as a whole on Users & Roles -> Email.
 * A mail without a row is on. Who and when are kept.
 */
@Entity({ name: TABLES.MAIL_LIST_SETTINGS })
export class MailListSetting {
  /** MAIL_LISTS[].key */
  @PrimaryColumn({ name: 'list_key', type: 'varchar', length: 64 })
  listKey: string;

  @Column({ name: 'enabled', type: 'boolean' })
  enabled: boolean;

  @Column({ name: 'updated_by', type: 'int' })
  updatedBy: number;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_mail_list_settings_user' })
  user?: User;
}

/**
 * mail_recipients (2026-10-30, user): who gets each mail - any email address, as To / CC / BCC, paused without being
 * removed. One row per address per mail. Every change is also an activity_log AUDIT row (the page's history).
 */
@Entity({ name: TABLES.MAIL_RECIPIENTS })
@Index('uq_mail_recipients_list_email', ['listKey', 'email'], { unique: true })
export class MailRecipient {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** MAIL_LISTS[].key */
  @Column({ name: 'list_key', type: 'varchar', length: 64 })
  listKey: string;

  /** Lower case. */
  @Column({ name: 'email', type: 'varchar', length: 254 })
  email: string;

  @Column({ name: 'kind', type: 'enum', enum: ['to', 'cc', 'bcc'], default: 'to' })
  kind: 'to' | 'cc' | 'bcc';

  @Column({ name: 'paused', type: 'boolean', default: false })
  paused: boolean;

  @Column({ name: 'created_by', type: 'int' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'datetime' })
  createdAt: Date;

  @Column({ name: 'updated_by', type: 'int' })
  updatedBy: number;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_mail_recipients_created_by' })
  creator?: User;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_mail_recipients_updated_by' })
  updater?: User;
}
