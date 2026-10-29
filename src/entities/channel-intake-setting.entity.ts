import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants';
import { User } from './auth.entities';

/**
 * channel_intake_settings (2026-10-23, user): PO intake per channel (constants/intake.ts). A channel without a row is
 * OFF (every channel starts OFF). daily_limit null = no limit.
 */
@Entity({ name: TABLES.CHANNEL_INTAKE_SETTINGS })
@Index('uq_channel_intake_settings_channel', ['channel'], { unique: true })
export class ChannelIntakeSetting {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  /** constants/channels CHANNELS value (blinkit, amazon …). */
  @Column({ name: 'channel', type: 'varchar', length: 50 })
  channel: string;

  @Column({ name: 'enabled', type: 'boolean', default: false })
  enabled: boolean;

  @Column({ name: 'daily_limit', type: 'int', nullable: true })
  dailyLimit: number | null;

  /**
   * Process POs from this time on (2026-10-23): older emails stay in Gmail only (not downloaded), older Amazon shipments
   * are not taken; null = no start (everything new). The row with channel "*" holds the universal value last applied.
   */
  @Column({ name: 'process_from', type: 'datetime', nullable: true })
  processFrom: Date | null;

  @Column({ name: 'updated_by', type: 'int' })
  updatedBy: number;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_channel_intake_settings_user' })
  user?: User;
}
