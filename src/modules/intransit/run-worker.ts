import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { FLIPKART, IntransitSource, SHEET_FRAMES } from '../../constants';
import { fetchScheduledConsignments } from '../channel-api/flipkart/consignments.robot';
import { checkCombos } from './combo-check';
import { ConnectorConfig, ConnectorDirs, ConnectorOptions, runConnector } from './connectors';
import { IntransitSettings } from './context';
import { runPipeline } from './pipeline';
import { frameCsvChunks } from './sources/files';
import { SellerHubConfig } from './sources/flipkart-seller-hub';
import { UniwareConfig } from './sources/uniware';

/*
 * The child process that does one in-transit job (forked by runs.service.ts), so a ~20 s CPU-heavy report build or
 * an hour-long connector never blocks the API. It gets the job as its first IPC message and answers with
 * { type: 'log', line } messages, then one { type: 'done', result } or { type: 'error', message }, and exits.
 * It never touches the database: the parent records everything.
 */

export type WorkerJob =
  /** combo: the Uniware login for the combo check after the build (null = skipped), and where its cache lives. */
  /** sheets: also write each sheet as <outputDir>/sheets/<sheet>.csv.gz (sheet previews and the Daily Snapshot). */
  | { kind: 'report'; settings: IntransitSettings; combo: { uniware: UniwareConfig | null; cacheDir: string }; sheets?: boolean }
  | { kind: IntransitSource; config: ConnectorConfig; dirs: ConnectorDirs; options: ConnectorOptions }
  /** Flipkart scheduled consignments (channel-api/flipkart, 2026-10-30): the same Seller Hub login, one browser job at a time. */
  | { kind: typeof FLIPKART.ROBOT_JOB; seller: SellerHubConfig; cacheDir: string; known: string[] };

export type WorkerMessage = { type: 'log'; line: string } | { type: 'done'; result: unknown } | { type: 'error'; message: string };

const send = (msg: WorkerMessage): Promise<void> =>
  new Promise((resolve) => {
    if (!process.send) {
      console.log(msg.type === 'log' ? msg.line : JSON.stringify(msg));
      return resolve();
    }
    process.send(msg, undefined, {}, () => resolve());
  });

const log = (line: string): void => void send({ type: 'log', line });

const run = async (job: WorkerJob): Promise<unknown> => {
  if (job.kind === 'report') {
    const { ctx, result } = await runPipeline(job.settings, log);
    if (job.sheets) {
      // one gzipped CSV per sheet, from the frames (a preview then needs that sheet only, not the whole workbook)
      const dir = path.join(job.settings.outputDir, 'sheets');
      await fs.mkdir(dir, { recursive: true });
      // streamed: the biggest sheet is ~100 MB of CSV, never held whole
      for (const [label, frame] of SHEET_FRAMES) {
        await pipeline(Readable.from(frameCsvChunks(ctx.get(frame))), createGzip(), createWriteStream(path.join(dir, `${label}.csv.gz`)));
      }
      log(`sheets: ${SHEET_FRAMES.length} saved for previews`);
    }
    // Combos missing from Split1, checked against Uniware's item master; never fails the report.
    const comboCheck = await checkCombos(ctx.get('df_gap_split1'), job.combo.uniware, { cacheDir: job.combo.cacheDir, outDir: job.settings.outputDir }, log)
      .catch((err: unknown) => ({ status: 'failed' as const, reason: err instanceof Error ? err.message : String(err), checked: 0, combos: [], unknownInUniware: 0, lookedUp: 0 }));
    return { ...result, comboCheck };
  }
  if (job.kind === FLIPKART.ROBOT_JOB) return fetchScheduledConsignments(job.seller, job.cacheDir, job.known, log);
  return runConnector(job.kind, job.config, job.dirs, job.options, log);
};

process.once('message', (job: WorkerJob) => {
  run(job)
    .then((result) => send({ type: 'done', result }))
    .catch((err: unknown) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
    .finally(() => process.exit(0));
});
