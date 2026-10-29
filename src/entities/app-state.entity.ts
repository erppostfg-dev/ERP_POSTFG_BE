import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TABLES } from '../constants';

/**
 * app_state (2026-10-23): small values the server must keep across deploys and new servers (constants APP_STATE_KEY),
 * e.g. the Gmail sync point that used to live in storage/gmail-state.json.
 */
@Entity({ name: TABLES.APP_STATE })
export class AppState {
  @PrimaryColumn({ name: 'state_key', type: 'varchar', length: 100 })
  key: string;

  @Column({ name: 'value', type: 'json' })
  value: Record<string, unknown>;

  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt: Date;
}
