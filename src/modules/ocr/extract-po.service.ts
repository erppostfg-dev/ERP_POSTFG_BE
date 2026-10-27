import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { detectChannel, emailInfo, StoredMetadata } from './channel-detector';
import { ChannelConfig } from './channels.config';
import { DownloadedLink, downloadLinkedFiles } from './link-downloader';
import { runOcr } from './ocr-runner';
import { readSheets } from './sheet-reader';
import { submitJob, usesSqs } from '../po-jobs/po-jobs.queue';
import { syncEmailToS3 } from '../email-intake/s3-mirror.service';
import { ocrFinished, ocrStarted } from '../po-pipeline/pipeline.service';
import { ErrorArgs, ErrorCode, ERROR_CODES, errorMessage, FILES, PO_JOB_TYPE, RESULT_STATUS, ResultStatus } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { logError } from '../../utils/classify-error';
import { runJob, step } from '../../utils/log-call';

export type ExtractStatus = ResultStatus;

export interface ExtractResult {
  status: ExtractStatus;
  /** Why it was skipped or failed: a code from constants/errors.ts and its message. */
  code?: ErrorCode;
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

/** A code from constants/errors.ts with its message, for a skipped or failed run. */
const why = <C extends ErrorCode>(code: C, ...args: ErrorArgs<C>): { code: C; reason: string } => ({
  code,
  reason: errorMessage(code, ...args),
});

/** The attachments the channel's OCR needs (run_po.py tells the PDF and the sheet apart itself). */
const pickFiles = (config: ChannelConfig, filenames: string[]): { files: string[] } | { code: ErrorCode; reason: string } => {
  const picked: string[] = [];
  for (const kind of ['pdf', 'sheet'] as const) {
    const pattern = config.files[kind];
    if (!pattern) continue;
    const file = filenames.find((f) => pattern.test(f));
    if (!file && config.optional?.includes(kind)) continue; // not needed (e.g. 1mg's PDF): read without it
    if (!file) return why(ERROR_CODES.OCR_FILES_MISSING, config.channel, kind, String(pattern), filenames.join(', '));
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
    await fs.writeFile(path.join(dir, FILES.OCR_RESULT), JSON.stringify(full, null, 2), 'utf8');
    // The OCR result, its CSV and any downloaded files go to S3 too (awaited, so `npm run ocr:run` uploads before exiting).
    await syncEmailToS3(dir).catch((err) => logError(LOG_SOURCE.S3, `upload ${dir} failed (retried by the next sync)`, err));
    // The chain goes on (processed.json -> validation -> DB -> CSV) when the database is connected.
    await ocrFinished(dir, full);
    return full;
  };

  const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.METADATA), 'utf8')) as StoredMetadata;

  // 1. Which channel?
  const detected = detectChannel(emailInfo(meta));
  if ('reason' in detected) return save({ status: RESULT_STATUS.SKIPPED, code: detected.code, reason: detected.reason });
  const config = detected.config;

  const filenames = (meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename));

  // 2. Channels that send links instead of attachments: download them into the folder first.
  let links: DownloadedLink[] | undefined;
  if (config.links) {
    const dl = await step('download linked files', async () => downloadLinkedFiles(config, dir, await fs.readdir(dir)));
    links = dl.downloaded;
    for (const d of dl.downloaded) if (d.filename && !filenames.includes(d.filename)) filenames.push(d.filename);
    if (dl.missingRequired.length) {
      const failed = why(ERROR_CODES.OCR_DOWNLOAD_FAILED, dl.missingRequired.join('; '));
      return save({ status: RESULT_STATUS.FAILED, ...failed, channel: config.channel, links });
    }
  }

  // 3. Which files does that channel's OCR need?
  const picked = pickFiles(config, filenames);
  if ('reason' in picked) {
    return save({ status: RESULT_STATUS.SKIPPED, code: picked.code, reason: picked.reason, channel: config.channel, links });
  }

  // 3b. Sheet channels (reader 'sheet', 2026-10-26): no OCR, our own reader turns every CSV into the raw JSON.
  if (config.reader === 'sheet') {
    const sheets = filenames.filter((f) => config.files.sheet?.test(f));
    await ocrStarted(dir);
    const t0 = Date.now();
    try {
      const read = await step('read sheet (no OCR)', () => readSheets(dir, sheets, config.channel), { files: sheets.length });
      log.info(LOG_SOURCE.OCR, `[extractPo] ${config.channel}: sheet reader, no OCR: ${read.lines} line(s) from ${sheets.length} file(s) (${path.basename(dir)})`);
      return await save({
        status: RESULT_STATUS.OK,
        channel: config.channel,
        ocrChannel: config.ocrChannel,
        files: picked.files,
        inputs: sheets,
        links,
        durationMs: Date.now() - t0,
        ocr: { status: RESULT_STATUS.OK, reader: 'sheet', lines: read.lines, files: sheets },
      });
    } catch (err) {
      const failed = why(ERROR_CODES.OCR_FAILED, `sheet reader: ${(err as Error).message}`);
      return save({ status: RESULT_STATUS.FAILED, ...failed, channel: config.channel, files: sheets, links, durationMs: Date.now() - t0 });
    }
  }

  // 4. The OCR's inputs: the local files, or their S3 copies (uploaded first if missing).
  let inputs = picked.files.map((f) => path.join(dir, f));
  if (env.ocr.inputFromS3) {
    if (!env.s3.enabled) {
      return save({ status: RESULT_STATUS.FAILED, ...why(ERROR_CODES.OCR_S3_INPUT_DISABLED), channel: config.channel, links });
    }
    let s3Folder: string;
    try {
      s3Folder = (await step('upload OCR inputs to S3', () => syncEmailToS3(dir))).s3Folder;
    } catch (err) {
      const failed = why(ERROR_CODES.OCR_S3_UPLOAD_FAILED, (err as Error).message);
      return save({ status: RESULT_STATUS.FAILED, ...failed, channel: config.channel, links });
    }
    inputs = picked.files.map((f) => `s3://${env.s3.bucket}/${s3Folder}/${f}`);
  }

  // 5. Run the OCR in the email folder (its CSV and result are written there).
  log.info(LOG_SOURCE.OCR, `[extractPo] ${config.channel}: ${inputs.join(', ')} (${path.basename(dir)})`);
  await ocrStarted(dir);
  const run = await step('run OCR', () => runOcr(config.ocrChannel, inputs, dir, FILES.OCR_OUTPUT_CSV), { channel: config.channel, files: inputs.length });

  const ok = run.exitCode === 0 && run.result?.status === RESULT_STATUS.OK;
  const ocrError = run.result?.error as string | undefined;
  const failure = ok
    ? undefined
    : run.timedOut
      ? why(ERROR_CODES.OCR_TIMED_OUT, env.ocr.timeoutMs)
      : ocrError
        ? why(ERROR_CODES.OCR_FAILED, ocrError)
        : why(ERROR_CODES.OCR_EXITED, run.exitCode);
  const reason = failure?.reason;

  const result = await save({
    status: ok ? RESULT_STATUS.OK : RESULT_STATUS.FAILED,
    code: failure?.code,
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
  log.info(LOG_SOURCE.OCR, `[extractPo] ${config.channel} ${result.status}${reason ? `: ${reason}` : ''} (${run.durationMs} ms)`);
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
    // One job per OCR run: its OCR, S3, DB and pipeline lines share one jobId.
    runJob('ocr', () => extractPo(folder), { folder: path.basename(folder) })
      .catch((err) => logError(LOG_SOURCE.OCR, `${folder} crashed (it stays queued for the next start)`, err))
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
  // PO jobs queue (2026-10-26): with QUEUE_MODE=sqs the job goes to SQS and the worker runs it, one at a time.
  if (usesSqs()) {
    void submitJob({ type: PO_JOB_TYPE.EXTRACT, folder: dir }, () => queueLocal(dir));
    return true;
  }
  return queueLocal(dir);
};

/** The in-process queue (QUEUE_MODE=local, or an SQS send that failed). */
const queueLocal = (dir: string): boolean => {
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
    const hasResult = await fs.access(path.join(dir, FILES.OCR_RESULT)).then(() => true, () => false);
    if (!hasResult) out.push(dir);
  }
  return out;
};

/** Queues every stored email of the label folders that was never run through OCR (OCR_BACKLOG). */
export const queueOcrBacklog = async (
  groupDirs: string[],
  admit: (folder: string) => Promise<boolean> = async () => true,
): Promise<{ found: number; queued: number }> => {
  let found = 0;
  let queuedNow = 0;
  for (const groupDir of groupDirs) {
    for (const dir of await foldersWithoutOcr(groupDir)) {
      found++;
      // PO intake (2026-10-23): the admin switch / limit / process-from decide, not the .env flag alone.
      if (!(await admit(dir))) continue;
      if (queueExtractPo(dir)) queuedNow++;
    }
  }
  return { found, queued: queuedNow };
};
