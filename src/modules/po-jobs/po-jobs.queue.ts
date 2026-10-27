import path from 'path';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../../config/env';
import { PO_JOB_TYPE, PoJobType, QUEUE_MODE } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { log } from '../../utils/logger';
import { logError } from '../../utils/classify-error';
import { logCall } from '../../utils/log-call';

/*
 * PO jobs (2026-10-26, constants/po-jobs.ts). Every place that used to start the heavy work at once (OCR / sheet reader +
 * chain) calls submitJob() instead:
 *   QUEUE_MODE=local -> runs it in this process exactly as before (runLocal);
 *   QUEUE_MODE=sqs   -> sends { type, folder | id } to the SQS queue; the worker (po-jobs.worker.ts) takes them one at a
 *                       time. If the send fails (no network / no permission) the job runs in-process instead, so a PO is
 *                       never lost; the DB row (queued) stays the source of truth.
 * The folder is the absolute local path: the worker runs on the same machine (local disk = working area).
 */

export interface PoJob {
  type: PoJobType;
  /** EXTRACT / CHAIN: the PO's local folder. */
  folder?: string;
  /** MANUAL: manual_uploads.id. */
  id?: string;
}

let client: SQSClient | undefined;
export const sqsClient = (): SQSClient => (client ??= new SQSClient({ region: env.s3.region }));

/** https://sqs.<region>.amazonaws.com/<account>/<name> from arn:aws:sqs:<region>:<account>:<name>. */
export const queueUrlOf = (arn: string): string => {
  const [, , , region, account, name] = arn.split(':');
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
};

export const usesSqs = (): boolean => env.queue.mode === QUEUE_MODE.SQS && !!env.queue.jobsArn;

const label = (job: PoJob) => (job.type === PO_JOB_TYPE.MANUAL ? `manual upload ${job.id}` : path.basename(job.folder ?? ''));

/** Sends the job to SQS, or runs it here (local mode, or the send failed). */
export const submitJob = async (job: PoJob, runLocal: () => unknown): Promise<void> => {
  if (!usesSqs()) {
    await runLocal();
    return;
  }
  try {
    await logCall(LOG_SOURCE.SQS, 'SendMessage', () =>
      sqsClient().send(new SendMessageCommand({ QueueUrl: queueUrlOf(env.queue.jobsArn), MessageBody: JSON.stringify(job) })),
    );
    log.info(LOG_SOURCE.SQS, `[po-jobs] queued ${job.type}: ${label(job)}`);
  } catch (err) {
    logError(LOG_SOURCE.SQS, `[po-jobs] could not queue ${job.type} ${label(job)}: running it here instead`, err);
    await runLocal();
  }
};
