import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { detectChannel, emailInfo, StoredMetadata } from './channel-detector';
import { ChannelConfig } from './channels.config';
import { DownloadedLink, downloadLinkedFiles } from './link-downloader';
import { runOcr } from './ocr-runner';

export type ExtractStatus = 'ok' | 'failed' | 'skipped';

export interface ExtractResult {
  status: ExtractStatus;
  reason?: string;
  channel?: string;
  ocrChannel?: string;
  files?: string[];
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

  // 4. Run the OCR in the email folder.
  console.log(`[extractPo] ${config.channel}: ${picked.files.join(', ')} (${path.basename(dir)})`);
  const run = await runOcr(
    config.ocrChannel,
    picked.files.map((f) => path.join(dir, f)),
    dir,
    OUTPUT_CSV,
  );

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
const waiting: string[] = [];

const next = (): void => {
  while (running < env.ocr.concurrency && waiting.length) {
    const folder = waiting.shift() as string;
    running++;
    extractPo(folder)
      .catch((err) => console.error(`[extractPo] ${folder} crashed`, err))
      .finally(() => {
        running--;
        next();
      });
  }
};

/** Queues a stored email for OCR without waiting for it (stand-in for the BullMQ queue). */
export const queueExtractPo = (folder: string): void => {
  waiting.push(folder);
  next();
};
