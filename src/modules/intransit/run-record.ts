import path from 'path';
import { RUN_RECORD_FILE } from '../../constants';
import { IntransitRun } from '../../entities';
import { writeAtomic } from './sources/files';

/*
 * run.json beside every run's files (user, 2026-10-22: kept for ever with them in Drive): what the run was, who started
 * it, how it went and its whole log - so a report or a connector's export can be understood without the database.
 * Written by the parent process when a run ends (succeeded or failed) and when a run left over by a restart is closed.
 */

export interface RunRecord {
  id: string;
  kind: string;
  host: string | null;
  status: string;
  asOf: string | null;
  options: Record<string, unknown> | null;
  createdBy: { id: number; name: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  timings: Record<string, number> | null;
  summary: Record<string, unknown>[] | null;
  sheetRows: Record<string, number> | null;
  result: Record<string, unknown> | null;
  reportPath: string | null;
  log: string[];
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export const runRecord = (run: IntransitRun): RunRecord => ({
  id: run.id,
  kind: run.kind,
  host: ((run.options ?? {}) as { host?: string }).host ?? null,
  status: run.status,
  asOf: run.asOf,
  options: run.options,
  createdBy: run.createdBy === null ? null : { id: run.createdBy, name: run.creator?.name ?? ((run.options ?? {}) as { byName?: string }).byName ?? null },
  createdAt: iso(run.createdAt) as string,
  startedAt: iso(run.startedAt),
  finishedAt: iso(run.finishedAt),
  error: run.error,
  timings: run.timings,
  summary: run.summary,
  sheetRows: run.sheetRows,
  result: run.result,
  reportPath: run.reportPath,
  log: (run.log ?? '').split('\n').filter(Boolean),
});

/** Write run.json of `run` into `dir` (its run or export folder); returns the file. */
export const writeRunRecord = async (run: IntransitRun, dir: string): Promise<string> => {
  const file = path.join(dir, RUN_RECORD_FILE);
  await writeAtomic(file, `${JSON.stringify(runRecord(run), null, 2)}\n`);
  return file;
};
