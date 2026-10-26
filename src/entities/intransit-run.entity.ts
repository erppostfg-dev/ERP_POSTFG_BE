import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS, IntransitRunKind, IntransitRunStatus } from '../constants/intransit';
import { TABLES } from '../constants/db';
import { User } from './auth.entities';

/**
 * intransit_runs (2026-10-15, user): every In-transit Stock job, newest first on the page.
 *   kind report:                    a report build from the uploaded inputs (as_of, summary, sheet_rows, report_path).
 *   kind amazon / uniware / flipkart: a connector fetch whose files replace those inputs (`result`: files written).
 * A run left queued or running when the server stops is marked failed at the next start.
 */
@Entity({ name: TABLES.INTRANSIT_RUNS })
@Index('idx_intransit_runs_kind', ['kind', 'id'])
export class IntransitRun {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'kind', type: 'enum', enum: Object.values(INTRANSIT_RUN_KIND) })
  kind: IntransitRunKind;

  @Column({ name: 'status', type: 'enum', enum: Object.values(INTRANSIT_RUN_STATUS), default: INTRANSIT_RUN_STATUS.QUEUED })
  status: IntransitRunStatus;

  /** Report: the reference date of the age rules (YYYY-MM-DD). */
  @Column({ name: 'as_of', type: 'date', nullable: true })
  asOf: string | null;

  /** Connector options as asked (e.g. { only: 'soh' }). */
  @Column({ name: 'options', type: 'json', nullable: true })
  options: Record<string, unknown> | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', update: false })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'datetime', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt: Date | null;

  @Column({ name: 'error', type: 'varchar', length: 1000, nullable: true })
  error: string | null;

  /** Seconds per stage (+ excel), or per connector step. */
  @Column({ name: 'timings', type: 'json', nullable: true })
  timings: Record<string, number> | null;

  /** Report: the Summary_Dashboard rows. */
  @Column({ name: 'summary', type: 'json', nullable: true })
  summary: Record<string, unknown>[] | null;

  /** Report: rows per sheet, in workbook order. */
  @Column({ name: 'sheet_rows', type: 'json', nullable: true })
  sheetRows: Record<string, number> | null;

  /** Connector: the files it wrote into the inputs, and anything it skipped. */
  @Column({ name: 'result', type: 'json', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ name: 'log', type: 'mediumtext', nullable: true })
  log: string | null;

  /** Report: the workbook on disk (under INTRANSIT_DIR/runs/<id>/). */
  @Column({ name: 'report_path', type: 'varchar', length: 500, nullable: true })
  reportPath: string | null;

  /** fk_intransit_runs_created_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_intransit_runs_created_by' })
  creator: User | null;
}
