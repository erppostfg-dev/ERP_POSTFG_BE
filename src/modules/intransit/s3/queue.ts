import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { env } from '../../../config/env';
import { ERROR_CODES } from '../../../constants';
import { appError } from '../../../utils/AppError';
import { isUnreachable, ObjMeta, put, setQueueHook } from './store';

/*
 * The queue (user, 2026-10-26: "have a queue"): files this server could not send to S3 wait here, then are sent and
 * removed. INTRANSIT_DIR/spool/<id>/ holds `data` (the bytes) and manifest.json (key, metadata, when queued); both
 * written as .part, flushed and renamed, the manifest last (a folder without one is a cut write, removed at start).
 * The key is decided when queued (its stamp is the time of the save, not of the send).
 * Past INTRANSIT_SPOOL_MAX_MB (counted with any kept job folders) new work is refused; nothing waiting is dropped.
 * The Daily run page and builds see queued files (queuedItems): they are this machine's own saves.
 */

export interface QueuedItem {
  id: string;
  dir: string;
  key: string;
  meta: ObjMeta;
  contentType: string;
  size: number;
  queuedAt: string;
  lastError?: string | null;
}

export const spoolRoot = (): string => path.join(path.resolve(env.intransit.dir), 'spool');
const limitBytes = (): number => env.intransit.spoolMaxMb * 1024 * 1024;
const MANIFEST = 'manifest.json';
const DATA = 'data';

let items: QueuedItem[] | null = null;
let reserved = 0;
let seq = 0;

const dirSize = async (dir: string): Promise<number> => {
  let total = 0;
  for (const d of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    const p = path.join(dir, d.name);
    total += d.isDirectory() ? await dirSize(p) : (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
};

/** Read the queue from disk (at start, or on first use): the waiting items and the room they take. */
export const loadQueue = async (): Promise<QueuedItem[]> => {
  const found: QueuedItem[] = [];
  for (const id of await fsp.readdir(spoolRoot()).catch(() => [] as string[])) {
    const dir = path.join(spoolRoot(), id);
    const m = path.join(dir, MANIFEST);
    if (!fs.existsSync(m) || !fs.existsSync(path.join(dir, DATA))) {
      await fsp.rm(dir, { recursive: true, force: true }); // a cut write: its save failed and said so
      continue;
    }
    found.push({ ...(JSON.parse(await fsp.readFile(m, 'utf8')) as Omit<QueuedItem, 'id' | 'dir'>), id, dir });
  }
  found.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
  items = found;
  // kept job folders (a job whose files could not be queued either) count against the limit too
  const kept = await dirSize(path.join(path.resolve(env.intransit.dir), 'tmp'));
  reserved = found.reduce((n, i) => n + i.size, 0) + kept;
  return found;
};

const ensureLoaded = async (): Promise<QueuedItem[]> => items ?? loadQueue();

/** The items waiting (oldest first). */
export const queuedItems = async (): Promise<QueuedItem[]> => [...(await ensureLoaded())];

/** The queued item of a key, if it waits here. */
export const queuedOf = async (key: string): Promise<QueuedItem | null> => (await ensureLoaded()).filter((i) => i.key === key).pop() ?? null;

/** The file holding a queued item's bytes. */
export const dataOf = (item: QueuedItem): string => path.join(item.dir, DATA);

export const queuedBytes = (): number => reserved;

const writeDurable = async (file: string, data: Buffer | string, copyFrom?: string): Promise<void> => {
  const part = `${file}.part`;
  if (copyFrom) await fsp.copyFile(copyFrom, part);
  else await fsp.writeFile(part, data);
  const fh = await fsp.open(part, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(part, file);
};

/** Put a file in the queue (503 INTRANSIT_SPOOL_FULL past the limit). */
export const enqueue = async (key: string, from: Buffer | string, meta: ObjMeta, contentType: string): Promise<QueuedItem> => {
  const list = await ensureLoaded();
  const size = typeof from === 'string' ? (await fsp.stat(from)).size : from.length;
  if (reserved + size > limitBytes()) throw appError(ERROR_CODES.INTRANSIT_SPOOL_FULL, Math.round(reserved / 1048576));
  reserved += size;
  const queuedAt = new Date().toISOString();
  const id = `${queuedAt.replace(/[:.]/g, '-')}-${process.pid}-${++seq}`;
  const dir = path.join(spoolRoot(), id);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await writeDurable(path.join(dir, DATA), typeof from === 'string' ? '' : from, typeof from === 'string' ? from : undefined);
    const item: QueuedItem = { id, dir, key, meta, contentType, size, queuedAt };
    const { id: _i, dir: _d, ...manifest } = item;
    await writeDurable(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    list.push(item);
    console.warn(`[intransit-s3] S3 unreachable: ${key} queued (${list.length} waiting)`);
    return item;
  } catch (err) {
    reserved = Math.max(0, reserved - size);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
};

setQueueHook(async (key, from, meta, contentType) => {
  await enqueue(key, from, meta, contentType);
});

let draining: Promise<{ sent: number; left: number }> | null = null;

/** Called after a drain that reached S3 (the queue sent or had nothing to send): work that waited for S3 to be back. */
const whenReachable: (() => Promise<void>)[] = [];
export const onS3Reachable = (fn: () => Promise<void>): void => {
  whenReachable.push(fn);
};

/** Send what waits, oldest first; stops at the first "unreachable" (tried again next time). */
export const drainOnce = (): Promise<{ sent: number; left: number }> => {
  draining ??= (async () => {
    const list = await ensureLoaded();
    let sent = 0;
    let reachable = true;
    for (const item of [...list]) {
      try {
        // the same key and metadata as when it was queued; put() checks it with a HeadObject
        await put(item.key, dataOf(item), item.meta, { noQueue: true, contentType: item.contentType });
      } catch (err) {
        if (isUnreachable(err)) {
          reachable = false;
          break;
        }
        // refused for another reason (rights, a bad key): kept, with the reason for the status page
        item.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        continue;
      }
      await fsp.rm(item.dir, { recursive: true, force: true });
      list.splice(list.indexOf(item), 1);
      reserved = Math.max(0, reserved - item.size);
      sent++;
    }
    if (sent) console.log(`[intransit-s3] ${sent} queued file(s) sent to S3, ${list.length} waiting`);
    if (reachable) for (const fn of whenReachable) await fn().catch((err) => console.error('[intransit-s3] after the queue:', err instanceof Error ? err.message : err));
    return { sent, left: list.length };
  })().finally(() => {
    draining = null;
  });
  return draining;
};

let timer: NodeJS.Timeout | null = null;

/** At start: read the queue and send it every minute. */
export const startQueue = async (): Promise<void> => {
  await loadQueue();
  if (timer) return;
  timer = setInterval(() => void drainOnce().catch((err) => console.error('[intransit-s3] queue:', err instanceof Error ? err.message : err)), 60_000);
  timer.unref();
  void drainOnce().catch(() => undefined);
};

export const stopQueue = async (): Promise<void> => {
  if (timer) clearInterval(timer);
  timer = null;
  await draining?.catch(() => undefined);
};
