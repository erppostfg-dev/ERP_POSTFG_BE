import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../../config/data-source';
import { COMBO_CHECK, TABLES } from '../../../constants';
import { AMAZON_CACHE_FILE } from '../sources/amazon';
import { writeScope } from './scope';

/*
 * The in-transit caches (Uniware item types for the combo check, Amazon's closed shipments) live in app_state where the
 * S3 store is on (nothing stays on the server). A job gets them as files in its temporary cache folder before it runs
 * (the worker reads and writes files as before); afterwards only the caches the job CHANGED go back, so a build never
 * overwrites a fetch's newer cache with the copy it started with (review, 2026-10-26).
 * One app_state row per cache and scope: "intransit:<prod|test>:<file>", value = the file's text as a JSON string
 * (mysql2 hands a json column back already parsed: the string itself).
 */

const CACHE_FILES = [COMBO_CHECK.CACHE_FILE, AMAZON_CACHE_FILE];
const keyOf = (file: string): string => `intransit:${writeScope()}:${file}`.slice(0, 100);

/** What a job started with: file -> text ('' = it had none). */
export type LoadedCaches = Map<string, string>;

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value; // parsed by the driver: the text itself
  if (Buffer.isBuffer(value)) {
    const parsed = JSON.parse(value.toString('utf8')) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  }
  return null;
};

/** Write the caches from app_state into `dir`; returns what was written (to compare with afterwards). */
export const cachesIn = async (dir: string): Promise<LoadedCaches> => {
  await fsp.mkdir(dir, { recursive: true });
  const loaded: LoadedCaches = new Map();
  for (const file of CACHE_FILES) {
    const [row] = (await AppDataSource.query(`SELECT value FROM ${TABLES.APP_STATE} WHERE state_key = ?`, [keyOf(file)])) as { value: unknown }[];
    const text = row ? textOf(row.value) : null;
    loaded.set(file, text ?? '');
    if (text !== null) await fsp.writeFile(path.join(dir, file), text, 'utf8');
  }
  return loaded;
};

/** Save back the caches the job changed (compared with what it was given). */
export const cachesOut = async (dir: string, loaded: LoadedCaches): Promise<void> => {
  for (const file of CACHE_FILES) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const text = await fsp.readFile(p, 'utf8');
    if (text === (loaded.get(file) ?? '')) continue; // unchanged: leave whatever is stored now
    await AppDataSource.query(
      `INSERT INTO ${TABLES.APP_STATE} (state_key, value, updated_at) VALUES (?, CAST(? AS JSON), ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [keyOf(file), JSON.stringify(text), new Date()],
    );
  }
};
