import 'reflect-metadata';
import app from './app';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';
import { startEmailListener } from './modules/email-intake/pubsub.listener';
import { queueExtractPo } from './modules/ocr/extract-po.service';
import { applyResume, planResume } from './modules/po-pipeline/resume.service';
import { startChannelApis } from './modules/channel-api/scheduler';
import { resumeManualQueue } from './modules/manual-upload/manual-upload.service';
import { recheckInReview } from './modules/po-review/recheck.service';
import { holdForIntake, kickRelease } from './modules/po-intake-control/intake-release.service';
import { PO_INTAKE, REVIEW_RECHECK } from './constants';
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

  // Re-check of POs in review after master fixes (2026-10-22): every RECHECK_MINUTES (0 = off), first one a minute after
  // start. A run never overlaps the previous one.
  let recheckTimer: NodeJS.Timeout | undefined;
  if (env.recheck.minutes > 0 && AppDataSource.isInitialized) {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      void runJob('recheck', () => recheckInReview({ trigger: REVIEW_RECHECK.TRIGGER.TIMER })).catch(() => undefined).finally(() => { running = false; });
    };
    setTimeout(tick, REVIEW_RECHECK.FIRST_DELAY_MS);
    recheckTimer = setInterval(tick, env.recheck.minutes * 60_000);
  }

  // PO intake per channel (2026-10-23): held POs of channels that are ON with room today go on, one by one; a new day
  // frees the limit, so this looks again every RELEASE_EVERY_MINUTES.
  let releaseTimer: NodeJS.Timeout | undefined;
  if (AppDataSource.isInitialized) {
    setTimeout(kickRelease, PO_INTAKE.RELEASE_FIRST_DELAY_MS);
    releaseTimer = setInterval(kickRelease, PO_INTAKE.RELEASE_EVERY_MINUTES * 60_000);
  }

  // Resume unfinished POs from po_uploads (PIPELINE_RESUME=true, database connected), within PIPELINE_LIMIT.
  // The OCR is queued only when OCR_ENABLED; otherwise those emails stay queued for the next start.
  if (env.pipeline.resumeOnStart && AppDataSource.isInitialized) {
    void runJob('resume', async () => {
      const items = await planResume(AppDataSource);
      log.info(LOG_SOURCE.APP, `[resume] ${items.length} unfinished email(s) in po_uploads`);
      await applyResume(AppDataSource, items, {
        // OCR work waits for the admin's PO intake switch + limit (held -> released one by one), not .env alone.
        holdOcr: holdForIntake,
        runOcr: async (folder) => {
          if (env.ocr.enabled) queueExtractPo(folder);
          else log.info(LOG_SOURCE.OCR, `[resume] OCR_ENABLED=false: ${folder} stays queued`);
        },
      });
      kickRelease();
    }).catch(() => undefined); // JOB_FAILED is logged by runJob; the next start resumes again
  }

  const shutdown = async (signal: string): Promise<void> => {
    logEvent('PROCESS_STOP', `${signal} received, shutting down`, { uptimeMin: Math.round(process.uptime() / 60) });
    monitor.stop();
    await listener?.stop();
    channelApis?.stop();
    if (recheckTimer) clearInterval(recheckTimer);
    if (releaseTimer) clearInterval(releaseTimer);
    server.close(async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void start();
