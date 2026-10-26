import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { createGunzip, gzipSync } from 'zlib';
import { LessThanOrEqual } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { ERROR_CODES, INTRANSIT_FOLDERS, INTRANSIT_RUN_KIND, INTRANSIT_RUN_STATUS } from '../../constants';
import { IntransitRun } from '../../entities';
import { appError } from '../../utils/AppError';
import { checkDate } from './input-store';
import { getReportFile } from './runs.service';
import { readXlsxSheet, toCsv } from './sources/files';
import { SNAPSHOT_SHEETS } from './s3/layout';
import { scopeOfRun } from './s3/run-store';
import { PROD_SCOPE, storageOn } from './s3/scope';
import { openSnapshotFile, snapshotFor, SnapshotView } from './s3/snapshot';

/*
 * GET /intransit/snapshot?day= and GET /intransit/snapshot/file?key= (Inventory Calculation, user 2026-10-26): the
 * Daily Snapshot of the newest day <= day with a final build, from S3. Until the disk store is moved (plan phase S5),
 * a machine without the S3 store serves the same from its newest build's sheets/ folder (keys "disk:<run>/<sheet>").
 */

const DISK_KEY_RE = /^disk:(\d+)\/(.+)$/;

const diskSheet = (runId: string, sheet: string): string =>
  path.join(path.resolve(env.intransit.dir), INTRANSIT_FOLDERS.RUNS, runId, 'sheets', `${sheet}.csv.gz`);

/** A build from before the sheets were saved separately: its 3 sheets taken from its workbook once, kept beside it. */
const extractSheets = async (run: IntransitRun): Promise<void> => {
  if (SNAPSHOT_SHEETS.every((s) => fs.existsSync(diskSheet(run.id, s)))) return;
  const [workbook] = await getReportFile(run.id).catch(() => [null]);
  if (!workbook) return;
  const bytes = new Uint8Array(await fsp.readFile(workbook));
  await fsp.mkdir(path.dirname(diskSheet(run.id, SNAPSHOT_SHEETS[0])), { recursive: true });
  for (const sheet of SNAPSHOT_SHEETS) {
    const rows = readXlsxSheet(bytes, sheet);
    if (rows) await fsp.writeFile(diskSheet(run.id, sheet), gzipSync(Buffer.from(toCsv(rows), 'utf8')));
  }
};

const diskSnapshot = async (day: string): Promise<SnapshotView> => {
  const runs = (await AppDataSource.getRepository(IntransitRun).find({
    where: { kind: INTRANSIT_RUN_KIND.REPORT, status: INTRANSIT_RUN_STATUS.SUCCEEDED, asOf: LessThanOrEqual(day) },
    order: { asOf: 'DESC', id: 'DESC' }, take: 20,
  })).filter((r) => scopeOfRun(r) === PROD_SCOPE);
  for (const run of runs) {
    await extractSheets(run).catch((err) => console.warn(`[intransit] run ${run.id}: sheets not read from its workbook:`, err instanceof Error ? err.message : err));
    const files: SnapshotView['files'] = [];
    for (const name of SNAPSHOT_SHEETS) {
      const st = await fsp.stat(diskSheet(run.id, name)).catch(() => null);
      if (st) files.push({ name, key: `disk:${run.id}/${name}`, etag: `${st.size}-${Math.round(st.mtimeMs)}`, size: st.size });
    }
    if (files.length === SNAPSHOT_SHEETS.length) {
      return { requested: day, shown: { day: run.asOf as string, runId: run.id, builtAt: (run.finishedAt ?? run.createdAt).toISOString() }, latestMissing: run.asOf !== day, files };
    }
  }
  return { requested: day, shown: null, latestMissing: true, files: [] };
};

/** The snapshot to show for `day` (default today). */
export const getSnapshot = async (day: unknown): Promise<SnapshotView> => {
  const d = checkDate(day);
  return storageOn() ? snapshotFor(d) : diskSnapshot(d);
};

/** A snapshot file to send: its CSV text as a stream (null body = not modified). */
export const snapshotFile = async (key: string, ifNoneMatch?: string): Promise<{ body: Readable | null; etag: string }> => {
  const disk = DISK_KEY_RE.exec(key);
  if (disk) {
    if (storageOn() || !(SNAPSHOT_SHEETS as readonly string[]).includes(disk[2])) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, key);
    const file = diskSheet(disk[1], disk[2]);
    const st = await fsp.stat(file).catch(() => null);
    if (!st) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, key);
    const etag = `${st.size}-${Math.round(st.mtimeMs)}`;
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, '') === etag) return { body: null, etag };
    return { body: fs.createReadStream(file).pipe(createGunzip()), etag };
  }
  if (!storageOn()) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, key);
  const o = await openSnapshotFile(key, ifNoneMatch);
  if (o === 'not-modified') return { body: null, etag: (ifNoneMatch ?? '').replace(/"/g, '') };
  return { body: key.endsWith('.gz') ? o.body.pipe(createGunzip()) : o.body, etag: o.etag };
};
