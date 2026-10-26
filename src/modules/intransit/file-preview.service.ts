import fs from 'fs';
import fsp from 'fs/promises';
import { gunzipSync } from 'zlib';
import {
  COMBO_CHECK,
  ERROR_CODES,
  INPUT_BY_NAME,
  INTRANSIT_PREVIEW_CACHE_FILES,
  INTRANSIT_PREVIEW_MAX_PAGE,
  INTRANSIT_PREVIEW_PAGE,
  INTRANSIT_REPORT_NAME,
  INTRANSIT_RUN_KIND,
  INTRANSIT_RUN_STATUS,
  SHEET_FRAMES,
} from '../../constants';
import { IntransitRun } from '../../entities';
import { AppDataSource } from '../../config/data-source';
import { appError } from '../../utils/AppError';
import { decodeText, tokenizeCsv } from './io';
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
 * The table viewer and downloads of In-transit Stock (user, 2026-10-16 / 18 / 25 / 26): a page of rows of
 *   - an input CSV (the day's copy, or a master), or a CSV a connector fetched in a given run (also refused ones);
 *   - a sheet of a built report (Sheet35(2), Full_Shipment_Enhanced ...).
 * Files come from the disk store, or from S3 where the S3 store is on (user, 2026-10-26: nothing on the server): an S3
 * key never changes, so its table is cached by key; the database masters are read from the database; a report sheet is
 * the gzipped CSV its build saved (never the whole workbook on the server). A Full Report is kept 90 days: after that
 * 410 (the week's / month's copy holds the period's final build).
 * A table is parsed once and kept (the last few), so paging and searching are quick.
 */

export interface CsvPage {
  name: string;
  size: number;
  modified: Date;
  columns: string[];
  /** The page of rows (after the search). */
  rows: string[][];
  /** Rows matching the search (all rows when there is none). */
  total: number;
  /** Data rows in the table. */
  totalRows: number;
  offset: number;
  limit: number;
}

/** A stored file, wherever it lives: what the viewer and the downloads need of it. */
export interface StoredBlob {
  name: string;
  size: number;
  modified: Date;
  /** Unique per content version (the cache key). */
  key: string;
  read(): Promise<Uint8Array>;
  stream(): Promise<NodeJS.ReadableStream>;
}

type PageOpts = { offset?: number; limit?: number; q?: string };
type Parsed = { key: string; header: string[]; body: string[][]; lower?: string[] };
const cache: Parsed[] = [];

/** The parsed table for `key`, loading it with `load` the first time. */
const parsed = async (key: string, load: () => Promise<string[][]>): Promise<Parsed> => {
  const hit = cache.find((c) => c.key === key);
  if (hit) return hit;
  const [header = [], ...body] = await load();
  const p: Parsed = { key, header, body };
  cache.unshift(p);
  cache.splice(INTRANSIT_PREVIEW_CACHE_FILES);
  return p;
};

const pageOf = (p: Parsed, name: string, st: { size: number; mtime: Date }, opts: PageOpts): CsvPage => {
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0) || 0);
  const limit = Math.min(INTRANSIT_PREVIEW_MAX_PAGE, Math.max(1, Math.trunc(opts.limit ?? INTRANSIT_PREVIEW_PAGE) || INTRANSIT_PREVIEW_PAGE));
  const q = (opts.q ?? '').trim().toLowerCase();
  let rows = p.body;
  if (q) {
    // one lower-cased line per row, built on the first search of this table
    p.lower ??= p.body.map((r) => r.join('\u0001').toLowerCase());
    rows = p.body.filter((_, i) => (p.lower as string[])[i].includes(q));
  }
  return { name, size: st.size, modified: st.mtime, columns: p.header, rows: rows.slice(offset, offset + limit), total: rows.length, totalRows: p.body.length, offset, limit };
};

const collect = async (s: NodeJS.ReadableStream): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    s.on('data', (c: Buffer) => chunks.push(c)).on('error', reject).on('end', () => resolve());
  });
  return new Uint8Array(Buffer.concat(chunks));
};

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

const csvPage = async (blob: StoredBlob, opts: PageOpts): Promise<CsvPage> => {
  if (!/\.csv$/i.test(blob.name)) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_CSV, blob.name);
  const p = await parsed(blob.key, async () => tokenizeCsv(decodeText(await blob.read())));
  return pageOf(p, blob.name, { size: blob.size, mtime: blob.modified }, opts);
};

/** The input `name` as the viewer opens it: the master, or the daily file used for `date` (default today). 404 when none. */
export const inputBlob = async (name: string, date?: unknown): Promise<StoredBlob> => {
  if (!INPUT_BY_NAME.has(name)) throw appError(ERROR_CODES.INTRANSIT_INPUT_UNKNOWN, name);
  const day = checkDate(date);
  if (storageOn()) {
    if ((DB_MASTER_FILES as readonly string[]).includes(name)) {
      const text = (await mastersFromDb())[name as (typeof DB_MASTER_FILES)[number]];
      return textBlob(name, text, `db:${name}:${text.length}:${Date.now() >> 16}`);
    }
    const f = (await resolveStored(day)).files.find((x) => x.name === name);
    if (!f?.key) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
    return s3Blob(f.key, name);
  }
  const file = await inputPathFor(name, day);
  if (!file) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, name);
  return diskBlob(file, name);
};

export const previewInput = async (name: string, date: unknown, opts: PageOpts): Promise<CsvPage> => csvPage(await inputBlob(name, date), opts);

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

export const previewRunFile = async (id: string, name: string, opts: PageOpts): Promise<CsvPage> => csvPage(await runFileBlob(id, name), opts);

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

/** A sheet of a succeeded report run, parsed (404 for a name that is not one of the report's sheets). */
const reportSheet = async (id: string, sheet: string) => {
  if (!REPORT_SHEETS.has(sheet)) throw appError(ERROR_CODES.INTRANSIT_SHEET_UNKNOWN, sheet);
  if (storageOn()) {
    // the sheet's own gzipped CSV, saved by the build in its Full Report folder (90 days)
    const run = await findRunRow(id);
    if (run.status !== INTRANSIT_RUN_STATUS.SUCCEEDED) throw appError(ERROR_CODES.INTRANSIT_RUN_NOT_DONE, id, run.status);
    const base = reportDirOf(run);
    if (!base) throw appError(ERROR_CODES.INTRANSIT_SHEETS_UNAVAILABLE, sheet);
    const blob = await s3Blob(`${base}sheets/${sheet}.csv.gz`, sheet, expired(id));
    const p = await parsed(`${blob.key}|${sheet}`, async () => tokenizeCsv(decodeText(new Uint8Array(gunzipSync(Buffer.from(await blob.read()))))));
    return { p, st: { size: blob.size, mtime: blob.modified } };
  }
  const [file] = await getReportFile(id);
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw appError(ERROR_CODES.INTRANSIT_FILE_NOT_FOUND, sheet);
  const p = await parsed(`${file}|${st.mtimeMs}|${sheet}`, async () => {
    const rows = readXlsxSheet(new Uint8Array(await fsp.readFile(file)), sheet);
    if (!rows) throw appError(ERROR_CODES.INTRANSIT_SHEET_UNKNOWN, sheet);
    return rows;
  });
  return { p, st };
};

export const previewReportSheet = async (id: string, sheet: string, opts: PageOpts): Promise<CsvPage> => {
  const { p, st } = await reportSheet(id, sheet);
  return pageOf(p, sheet, st, opts);
};

/** The whole sheet as CSV text, for its Download button. */
export const reportSheetCsv = async (id: string, sheet: string): Promise<string> => {
  const { p } = await reportSheet(id, sheet);
  return toCsv([p.header, ...p.body]);
};
