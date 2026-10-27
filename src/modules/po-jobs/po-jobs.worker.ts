import path from 'path';
import { DeleteMessageCommand, Message, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { env } from '../../config/env';
import { PO_JOB_TYPE, PO_JOBS, UPLOAD_STATUS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { logError } from '../../utils/classify-error';
import { logCall, runJob } from '../../utils/log-call';
import { extractPo } from '../ocr/extract-po.service';
import { jobFailed, runChainFor, statusesOf } from '../po-pipeline/pipeline.service';
import { manualJobFailed, runManualUpload, shouldRunManual } from '../manual-upload/manual-upload.service';
import { PoJob, queueUrlOf, sqsClient, usesSqs } from './po-jobs.queue';

/*
 * The PO jobs worker (2026-10-26). Takes jobs from SQS (long poll), WORKER_CONCURRENCY at a time (default 1), a pause of
 * WORKER_PAUSE_MS after each, and runs them exactly as the in-process path did (extractPo / the chain / a manual upload).
 *   done (or nothing to do)        -> the message is deleted;
 *   crash / error                  -> left in the queue: SQS hands it out again after the visibility timeout (15 min);
 *   error on the last try (3rd)    -> its PO rows / manual upload are marked failed with the reason, message deleted;
 *   a worker killed mid-job        -> SQS hands it out again; after 3 receives SQS moves it to the DLQ.
 * A message can come twice (Standard queue): before running, the job is skipped when its rows are already past it.
 * Runs as its own process (`npm run worker`, pm2 on EC2) or inside the API server with WORKER_IN_SERVER=true.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Statuses a job still has work for (anything else: it already ran, or a person / the intake switch owns it now). */
const OPEN = new Set<string>([UPLOAD_STATUS.QUEUED, UPLOAD_STATUS.EXTRACTING, UPLOAD_STATUS.PROCESSING]);

const shouldRun = async (job: PoJob): Promise<boolean> => {
  if (job.type === PO_JOB_TYPE.MANUAL) return shouldRunManual(job.id ?? '');
  const statuses = await statusesOf(job.folder ?? '');
  return !statuses.length || statuses.some((s) => OPEN.has(s));
};

const run = async (job: PoJob): Promise<void> => {
  if (job.type === PO_JOB_TYPE.EXTRACT) await extractPo(job.folder!);
  else if (job.type === PO_JOB_TYPE.CHAIN) await runChainFor(job.folder!);
  else if (job.type === PO_JOB_TYPE.MANUAL) await runManualUpload(job.id!);
  else throw new Error(`unknown job type ${String((job as { type?: unknown }).type)}`);
};

const failed = (job: PoJob, reason: string) =>
  job.type === PO_JOB_TYPE.MANUAL ? manualJobFailed(job.id ?? '', reason) : jobFailed(job.folder ?? '', reason);

const handle = async (url: string, m: Message): Promise<void> => {
  const receives = Number(m.Attributes?.ApproximateReceiveCount ?? 1);
  let job: PoJob | undefined;
  try {
    job = JSON.parse(m.Body ?? '') as PoJob;
  } catch {
    log.warn(LOG_SOURCE.SQS, `[po-jobs] message ${m.MessageId} is not a job: deleted`);
  }
  const remove = () => logCall(LOG_SOURCE.SQS, 'DeleteMessage', () => sqsClient().send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle })));
  if (!job) return void (await remove());
  const name = job.type === PO_JOB_TYPE.MANUAL ? `manual ${job.id}` : path.basename(job.folder ?? '');
  try {
    await runJob(`po-job-${job.type}`, async () => {
      if (!(await shouldRun(job!))) {
        log.info(LOG_SOURCE.SQS, `[po-jobs] ${name}: already done or not open any more, skipped`);
        return;
      }
      await run(job!);
    }, { job: name, receives });
    await remove();
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (receives >= PO_JOBS.MAX_RECEIVES) {
      logError(LOG_SOURCE.SQS, `[po-jobs] ${name} failed on try ${receives}: marked failed`, err);
      await failed(job, `queued job failed ${receives} times: ${reason}`).catch(() => undefined);
      await remove().catch(() => undefined);
    } else {
      logError(LOG_SOURCE.SQS, `[po-jobs] ${name} failed on try ${receives}: SQS gives it again after the visibility timeout`, err);
    }
  }
};

/** Starts the worker loops (SQS mode only). stop() lets the current jobs finish (and the open long polls end). */
export const startPoWorker = (): { stop: () => Promise<void> } => {
  if (!usesSqs()) return { stop: async () => undefined };
  const url = queueUrlOf(env.queue.jobsArn);
  let stopping = false;
  const loop = async (n: number): Promise<void> => {
    while (!stopping) {
      try {
        const r = await sqsClient().send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 1, WaitTimeSeconds: PO_JOBS.WAIT_SECONDS, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }),
        );
        for (const m of r.Messages ?? []) {
          await handle(url, m);
          if (env.queue.pauseMs) await sleep(env.queue.pauseMs);
        }
      } catch (err) {
        logError(LOG_SOURCE.SQS, `[po-jobs] worker ${n}: receive failed, trying again in ${PO_JOBS.ERROR_BACKOFF_MS / 1000} s`, err);
        await sleep(PO_JOBS.ERROR_BACKOFF_MS);
      }
    }
  };
  log.info(LOG_SOURCE.SQS, `[po-jobs] worker started: ${env.queue.concurrency} at a time, ${env.queue.pauseMs} ms pause, queue ${url}`);
  const loops = Array.from({ length: env.queue.concurrency }, (_, i) => loop(i + 1));
  return {
    stop: async () => {
      stopping = true;
      await Promise.allSettled(loops);
    },
  };
};
