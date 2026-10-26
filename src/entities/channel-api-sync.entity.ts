import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TABLES } from '../constants/db';

/**
 * channel_api_sync (2026-10-16): one row per channel API connector (Amazon SP-API ...), its check point and health.
 * The next run asks the channel for what changed since synced_until (minus a small overlap), so a server that was off
 * catches up by itself; synced_until only moves after a run succeeded. Failures are counted for the back-off and shown.
 */
@Entity({ name: TABLES.CHANNEL_API_SYNC })
export class ChannelApiSync {
  /** constants SOURCE_SYSTEM (amazon_spapi ...). */
  @PrimaryColumn({ name: 'connector', type: 'varchar', length: 50 })
  connector: string;

  /** Everything changed up to this moment has been taken (the next run starts here). */
  @Column({ name: 'synced_until', type: 'datetime', nullable: true })
  syncedUntil: Date | null;

  @Column({ name: 'last_run_at', type: 'datetime', nullable: true })
  lastRunAt: Date | null;

  @Column({ name: 'last_success_at', type: 'datetime', nullable: true })
  lastSuccessAt: Date | null;

  /** Runs that failed in a row (0 after a success). */
  @Column({ name: 'failures', type: 'int', default: 0 })
  failures: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  /** What the last run did: { seen, created, waiting, skipped, failed }. */
  @Column({ name: 'last_result', type: 'json', nullable: true })
  lastResult: Record<string, unknown> | null;

  @Column({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP', update: false })
  updatedAt: Date;
}
