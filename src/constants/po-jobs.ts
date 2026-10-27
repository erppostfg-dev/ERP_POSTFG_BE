/*
 * PO jobs queue (user, 2026-10-26: "reduce the spike of emails processed at a time"). Every PO that has to be read and
 * run through the chain is a JOB: QUEUE_MODE=local runs it in this process as before; QUEUE_MODE=sqs sends it to the SQS
 * queue (SQS_PO_JOBS_ARN) and a worker takes them one at a time (WORKER_CONCURRENCY), a pause between (WORKER_PAUSE_MS).
 * The queue's own settings (checked 2026-10-26): Standard, visibility 15 min, DLQ after 3 receives, 20 s long poll.
 */
export const QUEUE_MODE = { LOCAL: 'local', SQS: 'sqs' } as const;
export type QueueMode = (typeof QUEUE_MODE)[keyof typeof QUEUE_MODE];

/** What a job does. */
export const PO_JOB_TYPE = {
  /** A stored email / released email / backlog: read it (OCR or sheet reader), then the chain. */
  EXTRACT: 'extract',
  /** A folder that already has processed.json (channel API PO, released API PO): only the chain. */
  CHAIN: 'chain',
  /** A manual upload (manual_uploads.id), as the Manual Upload queue runs it. For now in the same queue (backlog: own queue). */
  MANUAL: 'manual',
} as const;
export type PoJobType = (typeof PO_JOB_TYPE)[keyof typeof PO_JOB_TYPE];

export const PO_JOBS = {
  /** SQS long poll (seconds, max 20). */
  WAIT_SECONDS: 20,
  /** The queue moves a message to the DLQ after this many receives; on the last one a failing job is marked failed. */
  MAX_RECEIVES: 3,
  /** Waiting after a receive error (no network / no permission) before polling again. */
  ERROR_BACKOFF_MS: 30_000,
  DEFAULT_CONCURRENCY: 1,
  DEFAULT_PAUSE_MS: 1_000,
} as const;
