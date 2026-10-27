import fs from 'fs';
import fsp from 'fs/promises';
import { createHash } from 'crypto';
import {
  COMBO_CHECK,
  ERROR_CODES,
  INPUT_BY_NAME,
  INTRANSIT_REPORT_NAME,
  INTRANSIT_RUN_KIND,
  INTRANSIT_RUN_STATUS,
  SHEET_FRAMES,
} from '../../constants';
import { IntransitRun } from '../../entities';
import { AppDataSource } from '../../config/data-source';
import { appError } from '../../utils/AppError';
import { checkDate, inputPathFor } from './input-store';
import { DB_MASTER_FILES, mastersFromDb } from './masters-export';
import { getReportFile, getRun, runFilePath } from './runs.service';
import { resolveStored } from './s3/inputs';
import { dataOf, queuedOf } from './s3/queue';
import { reportDirOf } from './s3/run-store';
import { storageOn } from './s3/scope';
import { getBytes, head, open } from './s3/store';
import { readXlsxSheet, toCsv } from './sources/files';

/*
 * The table viewer and downloads of In-transit Stock (user, 2026-10-16 / 18 / 25 / 26): the whole of
 *   - an input CSV (the day's copy, or a master), or a CSV a connector fetched in a given run (also refused ones);
 *   - a sheet of a built report (Sheet35(2), Full_Shipment_Enhanced ...).
 * Files come from the disk store, or from S3 where the S3 store is on (user, 2026-10-26: nothing on the server); the
 * database masters are read from the database; a report sheet is the gzipped CSV its build saved (never the whole
 * workbook on the server). A Full Report is kept 90 days: after that 410 (the week's / month's copy holds the period's
 * final build).
 * The browser pages, searches and keeps the table (user, 2026-10-27: "cache everything needed on the user's side"):
 * the server only passes the file on, with an ETag, and holds no table in memory (it held the last three, ~450 MB).
 */

/** A stored file, wherever it lives: what the viewer and the downloads need of it. */
export interface StoredBlob {
  name: string;
  size: number;
  modified: Date;
  /** Unique per content version (the ETag of the viewer's table). */
  key: string;
  /** stream() gives gzip bytes (a report sheet's stored .csv.gz). */
  gzip?: boolean;
  read(): Promise<Uint8Array>;
  stream(): Promise<NodeJS.ReadableStream>;
}

/** The ETag the viewer's table is sent with: the blob's version key, hashed (never changes for one content). */
export const tableEtag = (blob: StoredBlob): string => createHash('sha1').update(blob.key).digest('hex');

/** A file on the disk store. */
const diskBlob = async (file: string, name: string): Promise<StoredBlob> => {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
  return { name, size: st.size, modified: st.mtime, key: `${file}|${st.mtimeMs}`, read: async () => new Uint8Array(await fsp.readFile(file)), stream: async () => fs.createReadStream(file) };
};

/** An object in S3 (or waiting in this server's queue); `gone` = the error when it is not there. */
const s3Blob = async (key: string, name: string, gone: () => Error = () => appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name)): Promise<StoredBlob> => {
  const q = await queuedOf(key);
  if (q) return diskBlob(dataOf(q), name);
  const h = await head(key);
  if (!h) throw gone();
  return {
    name, size: h.size, modified: h.modified, key: `s3:${key}`,
    read: async () => {
      const bytes = await getBytes(key);
      if (!bytes) throw gone();
      return new Uint8Array(bytes);
    },
    stream: async () => {
      const o = await open(key);
      if (!o || o === 'not-modified') throw gone();
      return o.body;
    },
  };
};

const findRunRow = async (id: string): Promise<IntransitRun> => {
  await getRun(id); // 404 for an unknown run
  return (await AppDataSource.getRepository(IntransitRun).findOneBy({ id })) as IntransitRun;
};

const expired = (id: string) => (): Error => appError(ERROR_CODES.INTRANSIT_REPORT_EXPIRED, `run ${id}`);

/** Text made now (a database master as CSV). */
const textBlob = (name: string, text: string, key: string): StoredBlob => {
  const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
  return { name, size: bytes.length, modified: new Date(), key, read: async () => bytes, stream: async () => (await import('stream')).Readable.from(Buffer.from(bytes)) };
};

/** The input `name` as the viewer opens it: the master, or the daily file used for `date` (default today). 404 when none. */
export const inputBlob = async (name: string, date?: unknown): Promise<StoredBlob> => {
  if (!INPUT_BY_NAME.has(name)) throw appError(ERROR_CODES.INTRANSIT_INPUT_UNKNOWN, name);
  const day = checkDate(date);
  if (storageOn()) {
    if ((DB_MASTER_FILES as readonly string[]).includes(name)) {
      const text = (await mastersFromDb())[name as (typeof DB_MASTER_FILES)[number]];
      return textBlob(name, text, `db:${name}:${createHash('sha1').update(text).digest('hex')}`);
    }
    const f = (await resolveStored(day)).files.find((x) => x.name === name);
    if (!f?.key) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
    return s3Blob(f.key, name);
  }
  const file = await inputPathFor(name, day);
  if (!file) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
  return diskBlob(file, name);
};

/** A file a run wrote (a connector's export, saved or refused; a report's combo-check files). */
export const runFileBlob = async (id: string, name: string): Promise<StoredBlob> => {
  if (!storageOn()) return diskBlob(await runFilePath(id, name), name);
  const run = await findRunRow(id);
  // a connector run: the keys of the files it saved (or refused); a build: its combo-check files
  let key: string | null = null;
  if (run.kind === INTRANSIT_RUN_KIND.REPORT) {
    const base = reportDirOf(run);
    if (base && (name === COMBO_CHECK.ALERT_FILE || name === COMBO_CHECK.SPLIT1_ROWS_FILE)) key = `${base}${name}`;
  } else {
    key = ((run.result ?? {}) as { files?: Record<string, string> }).files?.[name] ?? null;
  }
  if (!key) throw appError(ERROR_CODES.INTRANSIT_RUN_FILE_UNKNOWN, id, name);
  return s3Blob(key, name);
};

/** The workbook of a succeeded report run, with its download name. */
export const reportBlob = async (id: string): Promise<StoredBlob> => {
  if (!storageOn()) {
    const [file, name] = await getReportFile(id);
    return diskBlob(file, name);
  }
  const run = await findRunRow(id);
  if (run.status !== INTRANSIT_RUN_STATUS.SUCCEEDED || !run.reportPath?.startsWith('s3:')) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_DONE, id, run.status);
  const day = (run.asOf ?? '').replace(/-/g, '');
  return s3Blob(run.reportPath.slice(3), INTRANSIT_REPORT_NAME.replace('.xlsx', `${day ? `_${day}` : ''}_run${id}.xlsx`), expired(id));
};

// ---- report sheets ---------------------------------------------------------------------------------------------

const REPORT_SHEETS = new Set(SHEET_FRAMES.map(([label]) => label));

/**
 * A sheet of a succeeded report run as CSV. S3 store: the gzipped CSV its build saved, sent as stored (never parsed
 * here). Disk store (older runs): read from the workbook for this one answer, not kept.
 */
export const reportSheetBlob = async (id: string, sheet: string): Promise<StoredBlob> => {
  if (!REPORT_SHEETS.has(sheet)) throw appError(ERROR_CODES.INTRANSIT_SHEET_UNKNOWN, sheet);
  if (storageOn()) {
    const run = await findRunRow(id);
    if (run.status !== INTRANSIT_RUN_STATUS.SUCCEEDED) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_DONE, id, run.status);
    const base = reportDirOf(run);
    if (!base) throw appError(ERROR_CODES.INTRANSIT_SHEETS_UNAVAILABLE, sheet);
    return { ...(await s3Blob(`${base}sheets/${sheet}.csv.gz`, `${sheet}.csv`, expired(id))), gzip: true };
  }
  const [file] = await getReportFile(id);
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, sheet);
  const rows = readXlsxSheet(new Uint8Array(await fsp.readFile(file)), sheet);
  if (!rows) throw appError(ERROR_CODES.INTRANSIT_SHEET_UNKNOWN, sheet);
  return { ...textBlob(`${sheet}.csv`, toCsv(rows), `${file}|${st.mtimeMs}|${sheet}`), modified: st.mtime };
};
