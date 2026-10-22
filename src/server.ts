import 'reflect-metadata';
import app from './app';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';
import { startEmailListener } from './modules/email-intake/pubsub.listener';
import { queueExtractPo } from './modules/ocr/extract-po.service';
import { applyResume, planResume } from './modules/po-pipeline/resume.service';
import { startChannelApis } from './modules/channel-api/scheduler';
import { resumeManualQueue } from './modules/manual-upload/manual-upload.service';
import { LOG_SOURCE } from './constants/logging';
import { logError } from './utils/classify-error';
import { runJob } from './utils/log-call';
import { log, logEvent } from './utils/logger';
import { logCrashes, startProcessMonitor } from './utils/process-monitor';

const start = async (): Promise<void> => {
  logCrashes();
  if (env.db.enabled) {
    try {
      await AppDataSource.initialize();
      log.info(LOG_SOURCE.DB, `database connected: ${env.db.host}:${env.db.port}/${env.db.name}`);
    } catch (err) {
      logError(LOG_SOURCE.DB, 'could not connect to the database: the server stops (pm2 restarts it)', err, { host: env.db.host, database: env.db.name });
      process.exit(1);
    }
  } else {
    log.warn(LOG_SOURCE.DB, 'database disabled (DB_ENABLED=false)');
  }

  const server = app.listen(env.port);
  // The email listener posts to our own endpoint, so wait until we are listening.
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  // What is switched on (no secrets): the first line to check in CloudWatch after a deploy or restart.
  logEvent('PROCESS_START', `server running on port ${env.port}${env.apiPrefix}`, {
    nodeEnv: env.nodeEnv, node: process.version, pid: process.pid, database: env.db.enabled ? env.db.name : 'off',
    pubsub: env.pubsub.enabled, ocr: env.ocr.enabled, s3: env.s3.enabled, channelApi: env.channelApi.enabled,
    resume: env.pipeline.resumeOnStart, pipelineLimit: env.pipeline.limit,
    log: { level: env.log.level, format: env.log.format, dbSlowMs: env.log.dbSlowMs, apiSlowMs: env.log.apiSlowMs, extSlowMs: env.log.extSlowMs },
  });
  const monitor = startProcessMonitor();

  // Gmail watch + Pub/Sub pull: labelled emails are sent to their route's endpoint.
  let listener: { stop: () => Promise<void> } | undefined;
  if (env.pubsub.enabled) {
    try {
      listener = await startEmailListener();
    } catch (err) {
      logError(LOG_SOURCE.PUBSUB, 'email listener did not start (restart the server after fixing)', err);
    }
  } else {
    log.info(LOG_SOURCE.PUBSUB, 'email listener disabled (PUBSUB_ENABLED=false)');
  }

  // Channel API connectors (Amazon SP-API ...): each polls on its own timer and feeds the same chain (2026-10-16).
  let channelApis: { stop: () => void } | undefined;
  if (env.channelApi.enabled && AppDataSource.isInitialized) channelApis = startChannelApis();
  else log.info(LOG_SOURCE.AMAZON, 'channel API connectors disabled (CHANNEL_API_ENABLED=false)');

  // Manual uploads (2026-10-22): ones queued by a Process click (or cut off while processing) continue, one at a time.
  // "uploaded" ones wait for a Process click.
  if (AppDataSource.isInitialized) void resumeManualQueue();

  // Resume unfinished POs from po_uploads (PIPELINE_RESUME=true, database connected), within PIPELINE_LIMIT.
  // The OCR is queued only when OCR_ENABLED; otherwise those emails stay queued for the next start.
  if (env.pipeline.resumeOnStart && AppDataSource.isInitialized) {
    void runJob('resume', async () => {
      const items = await planResume(AppDataSource);
      log.info(LOG_SOURCE.APP, `[resume] ${items.length} unfinished email(s) in po_uploads`);
      await applyResume(AppDataSource, items, {
        runOcr: async (folder) => {
          if (env.ocr.enabled) queueExtractPo(folder);
          else log.info(LOG_SOURCE.OCR, `[resume] OCR_ENABLED=false: ${folder} stays queued`);
        },
      });
    }).catch(() => undefined); // JOB_FAILED is logged by runJob; the next start resumes again
  }

  const shutdown = async (signal: string): Promise<void> => {
    logEvent('PROCESS_STOP', `${signal} received, shutting down`, { uptimeMin: Math.round(process.uptime() / 60) });
    monitor.stop();
    await listener?.stop();
    channelApis?.stop();
    server.close(async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void start();
