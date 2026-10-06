import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { detectChannel, emailInfo, StoredMetadata } from './channel-detector';
import { ChannelConfig } from './channels.config';
import { DownloadedLink, downloadLinkedFiles } from './link-downloader';
import { runOcr } from './ocr-runner';
import { syncEmailToS3 } from '../email-intake/s3-mirror.service';

export type ExtractStatus = 'ok' | 'failed' | 'skipped';

export interface ExtractResult {
  status: ExtractStatus;
  reason?: string;
  channel?: string;
  ocrChannel?: string;
  files?: string[];
  /** The paths given to the OCR: local paths, or s3:// URIs with OCR_INPUT_FROM_S3. */
  inputs?: string[];
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  ocr?: Record<string, unknown>;
  logTail?: string;
  /** Files downloaded from links in the email body (channels with `links`). */
  links?: DownloadedLink[];
  folder: string;
  startedAt: string;
  finishedAt: string;
}

const RESULT_FILE = 'ocr-result.json';
const OUTPUT_CSV = 'ocr-output.csv';

/** The attachments the channel's OCR needs (run_po.py tells the PDF and the sheet apart itself). */
const pickFiles = (config: ChannelConfig, filenames: string[]): { files: string[] } | { reason: string } => {
  const picked: string[] = [];
  for (const kind of ['pdf', 'sheet'] as const) {
    const pattern = config.files[kind];
    if (!pattern) continue;
    const file = filenames.find((f) => pattern.test(f));
    if (!file) return { reason: `${config.channel} needs a ${kind} matching ${pattern}, got [${filenames.join(', ')}]` };
    picked.push(file);
  }
  return { files: picked };
};

/**
 * Takes one stored email folder (storage/emails/<label>/<date>_<key>/), works out its channel from
 * metadata.json, downloads the channel's linked files if it sends links instead of attachments,
 * picks the files that channel's OCR needs, runs the Python OCR and saves ocr-result.json
 * (plus the OCR's CSV) in the same folder.
 *
 * Today the intake calls this directly after storing an email; later a BullMQ worker calls it.
 */
export const extractPo = async (folder: string): Promise<ExtractResult> => {
  const dir = path.resolve(folder);
  const startedAt = new Date().toISOString();

  const save = async (r: Omit<ExtractResult, 'folder' | 'startedAt' | 'finishedAt'>): Promise<ExtractResult> => {
    const full: ExtractResult = { ...r, folder: dir, startedAt, finishedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dir, RESULT_FILE), JSON.stringify(full, null, 2), 'utf8');
    // The OCR result, its CSV and any downloaded files go to S3 too (awaited, so `npm run ocr:run` uploads before exiting).
    await syncEmailToS3(dir).catch((err) => console.error(`[s3] upload ${dir} failed (retried by the next sync):`, (err as Error).message));
    return full;
  };

  const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')) as StoredMetadata;

  // 1. Which channel?
  const detected = detectChannel(emailInfo(meta));
  if ('reason' in detected) return save({ status: 'skipped', reason: detected.reason });
  const config = detected.config;

  const filenames = (meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename));

  // 2. Channels that send links instead of attachments: download them into the folder first.
  let links: DownloadedLink[] | undefined;
  if (config.links) {
    const dl = await downloadLinkedFiles(config, dir, await fs.readdir(dir));
    links = dl.downloaded;
    for (const d of dl.downloaded) if (d.filename && !filenames.includes(d.filename)) filenames.push(d.filename);
    if (dl.missingRequired.length) {
      return save({ status: 'failed', reason: `download failed: ${dl.missingRequired.join('; ')}`, channel: config.channel, links });
    }
  }

  // 3. Which files does that channel's OCR need?
  const picked = pickFiles(config, filenames);
  if ('reason' in picked) return save({ status: 'skipped', reason: picked.reason, channel: config.channel, links });

  // 4. The OCR's inputs: the local files, or their S3 copies (uploaded first if missing).
  let inputs = picked.files.map((f) => path.join(dir, f));
  if (env.ocr.inputFromS3) {
    if (!env.s3.enabled) {
      return save({ status: 'failed', reason: 'OCR_INPUT_FROM_S3 needs S3_ENABLED=true', channel: config.channel, links });
    }
    let s3Folder: string;
    try {
      s3Folder = (await syncEmailToS3(dir)).s3Folder;
    } catch (err) {
      return save({ status: 'failed', reason: `S3 upload before OCR failed: ${(err as Error).message}`, channel: config.channel, links });
    }
    inputs = picked.files.map((f) => `s3://${env.s3.bucket}/${s3Folder}/${f}`);
  }

  // 5. Run the OCR in the email folder (its CSV and result are written there).
  console.log(`[extractPo] ${config.channel}: ${inputs.join(', ')} (${path.basename(dir)})`);
  const run = await runOcr(config.ocrChannel, inputs, dir, OUTPUT_CSV);

  const ok = run.exitCode === 0 && run.result?.status === 'ok';
  const reason = ok
    ? undefined
    : run.timedOut
      ? `timed out after ${env.ocr.timeoutMs} ms`
      : ((run.result?.error as string | undefined) ?? `OCR exited with code ${run.exitCode}`);

  const result = await save({
    status: ok ? 'ok' : 'failed',
    reason,
    channel: config.channel,
    ocrChannel: config.ocrChannel,
    files: picked.files,
    inputs,
    links,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    ocr: run.result,
    logTail: ok ? undefined : run.logTail,
  });
  console.log(`[extractPo] ${config.channel} ${result.status}${reason ? `: ${reason}` : ''} (${run.durationMs} ms)`);
  return result;
};

// Direct connection for testing: run extractPo in the background, a few at a time.
let running = 0;
let started = 0;
const waiting: string[] = [];
const queued = new Set<string>();

/** OCR_RUN_LIMIT runs were started (or queued) since the server started. */
const limitReached = (): boolean => env.ocr.runLimit > 0 && started + waiting.length >= env.ocr.runLimit;

const next = (): void => {
  while (running < env.ocr.concurrency && waiting.length) {
    const folder = waiting.shift() as string;
    started++;
    running++;
    extractPo(folder)
      .catch((err) => console.error(`[extractPo] ${folder} crashed`, err))
      .finally(() => {
        running--;
        next();
      });
  }
};

/**
 * Queues a stored email for OCR without waiting for it (stand-in for the BullMQ queue).
 * Returns false when OCR_RUN_LIMIT is reached: the email keeps no ocr-result.json, so the next start's backlog takes it.
 */
export const queueExtractPo = (folder: string): boolean => {
  const dir = path.resolve(folder);
  if (queued.has(dir)) return true;
  if (limitReached()) return false;
  queued.add(dir);
  waiting.push(dir);
  next();
  return true;
};

/** Stored emails in a label folder that have no ocr-result.json yet, oldest first. */
export const foldersWithoutOcr = async (groupDir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const d of (await fs.readdir(groupDir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory()) continue;
    const dir = path.join(groupDir, d.name);
    const hasResult = await fs.access(path.join(dir, RESULT_FILE)).then(() => true, () => false);
    if (!hasResult) out.push(dir);
  }
  return out;
};

/** Queues every stored email of the label folders that was never run through OCR (OCR_BACKLOG). */
export const queueOcrBacklog = async (groupDirs: string[]): Promise<{ found: number; queued: number }> => {
  let found = 0;
  let queuedNow = 0;
  for (const groupDir of groupDirs) {
    for (const dir of await foldersWithoutOcr(groupDir)) {
      found++;
      if (queueExtractPo(dir)) queuedNow++;
    }
  }
  return { found, queued: queuedNow };
};
