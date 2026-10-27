import 'reflect-metadata';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';
import { LOG_SOURCE } from './constants/logging';
import { usesSqs } from './modules/po-jobs/po-jobs.queue';
import { startPoWorker } from './modules/po-jobs/po-jobs.worker';
import { logError } from './utils/classify-error';
import { log, logEvent } from './utils/logger';
import { logCrashes, startProcessMonitor } from './utils/process-monitor';

/*
 * The PO jobs worker as its own process (2026-10-26): `npm run worker` (EC2: pm2 process "postfg-worker", next to the
 * API server). It only takes jobs from the SQS queue (QUEUE_MODE=sqs) and runs them one at a time (WORKER_CONCURRENCY);
 * it serves no website and reads no Gmail. Same .env as the server.
 */
const start = async (): Promise<void> => {
  logCrashes();
  if (!usesSqs()) {
    log.warn(LOG_SOURCE.SQS, 'worker: QUEUE_MODE is not sqs (or SQS_PO_JOBS_ARN is empty): nothing to do, stopping');
    process.exit(0);
  }
  try {
    await AppDataSource.initialize();
    log.info(LOG_SOURCE.DB, `worker: database connected: ${env.db.host}:${env.db.port}/${env.db.name}`);
  } catch (err) {
    logError(LOG_SOURCE.DB, 'worker: could not connect to the database: stopping (pm2 restarts it)', err);
    process.exit(1);
  }
  logEvent('PROCESS_START', 'PO jobs worker running', {
    pid: process.pid, database: env.db.name, ocr: env.ocr.enabled, s3: env.s3.enabled,
    concurrency: env.queue.concurrency, pauseMs: env.queue.pauseMs,
  });
  const monitor = startProcessMonitor();
  const worker = startPoWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logEvent('PROCESS_STOP', `worker: ${signal} received, finishing the current job`, { uptimeMin: Math.round(process.uptime() / 60) });
    monitor.stop();
    await worker.stop();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void start();
