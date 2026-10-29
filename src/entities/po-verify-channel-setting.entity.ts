import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants';
import { User } from './auth.entities';

/**
 * po_verify_channel_settings (2026-10-22, user): the verify-before-Uniware switch, per channel ("keep it ON for the
 * channels that fail, OFF for the ones that are right"). A channel without a row uses PO_VERIFY_REQUIRED from .env.
 * Changed by admins / developers on Users & Roles -> Settings; who and when are kept. Part of the removable po-verify step.
 */
@Entity({ name: TABLES.PO_VERIFY_CHANNEL_SETTINGS })
@Index('uq_po_verify_channel_settings_channel', ['channel'], { unique: true })
export class PoVerifyChannelSetting {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** master_channels.display_name, as po_uploads.channel holds it. */
  @Column({ name: 'channel', type: 'varchar', length: 100 })
  channel: string;

  @Column({ name: 'required', type: 'boolean' })
  required: boolean;

  @Column({ name: 'updated_by', type: 'int' })
  updatedBy: number;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_po_verify_channel_settings_user' })
  user?: User;
}
