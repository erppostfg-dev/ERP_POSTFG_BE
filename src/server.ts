import 'reflect-metadata';
import app from './app';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';
import { startEmailListener } from './modules/email-intake/pubsub.listener';
import { queueExtractPo } from './modules/ocr/extract-po.service';
import { migrateFlatInputs } from './modules/intransit/input-store';
import { startPeriodKeeper, stopPeriodKeeper } from './modules/intransit/s3/periods';
import { startQueue, stopQueue } from './modules/intransit/s3/queue';
import { clearJobs } from './modules/intransit/s3/run-store';
import { storageOn, storageProblems, writeScope } from './modules/intransit/s3/scope';
import { expireStaleRuns, recoverRuns } from './modules/intransit/runs.service';
import { applyResume, planResume } from './modules/po-pipeline/resume.service';

const start = async (): Promise<void> => {
  if (env.db.enabled) {
    try {
      await AppDataSource.initialize();
      console.log(`Database connected: ${env.db.host}:${env.db.port}/${env.db.name}`);
    } catch (err) {
      console.error('Failed to connect to the database', err);
      process.exit(1);
    }
  } else {
    console.log('Database disabled (DB_ENABLED=false)');
  }

  // In-transit inputs from the flat inputs/ folder move to masters/ and daily/<day>/ (once; later starts find nothing).
  await migrateFlatInputs()
    .then((moved) => moved.length && console.log(`[intransit] moved ${moved.length} input(s) to masters/ and daily/: ${moved.join(', ')}`))
    .catch((err) => console.error('[intransit] could not move the inputs:', err instanceof Error ? err.message : err));

  // In-transit jobs that were queued/running when the server stopped will never finish: mark them failed.
  if (AppDataSource.isInitialized) {
    await recoverRuns()
      .then((n) => n && console.log(`[intransit] ${n} unfinished run(s) marked failed`))
      .catch((err) => console.error('[intransit] could not check unfinished runs:', err instanceof Error ? err.message : err));
    // runs of another machine that stopped answering (machines share the database)
    setInterval(() => void expireStaleRuns()
      .then((n) => n && console.log(`[intransit] ${n} run(s) of a stopped machine marked failed`))
      .catch(() => undefined), 5 * 60_000).unref();
    // nothing of a stopped job stays on the server
    await clearJobs().catch(() => undefined);
  }

  // In-transit store in S3 (INTRANSIT_S3_ENABLED): the queue of files waiting for S3, and on the live server the
  // weekly/monthly copies. Without it the page works from the disk as before.
  if (storageOn()) {
    console.log(`[intransit-s3] on: writes ${writeScope() === 'prod' ? 'inventory/ (live)' : 'inventory-test/ (test machine)'}`);
    await startQueue().catch((err) => console.error('[intransit-s3] queue did not start:', err instanceof Error ? err.message : err));
    startPeriodKeeper();
  } else console.log(`[intransit] disk store (S3 off: ${storageProblems().join(', ')})`);

  const server = app.listen(env.port);
  // The email listener posts to our own endpoint, so wait until we are listening.
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(`Server running on http://localhost:${env.port}${env.apiPrefix}`);

  // Gmail watch + Pub/Sub pull: labelled emails are sent to their route's endpoint.
  let listener: { stop: () => Promise<void> } | undefined;
  if (env.pubsub.enabled) {
    try {
      listener = await startEmailListener();
    } catch (err) {
      console.error('Email listener did not start:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('Email listener disabled (PUBSUB_ENABLED=false)');
  }

  // Resume unfinished POs from po_uploads (PIPELINE_RESUME=true, database connected), within PIPELINE_LIMIT.
  // The OCR is queued only when OCR_ENABLED; otherwise those emails stay queued for the next start.
  if (env.pipeline.resumeOnStart && AppDataSource.isInitialized) {
    void (async () => {
      const items = await planResume(AppDataSource);
      console.log(`[resume] ${items.length} unfinished email(s) in po_uploads`);
      await applyResume(AppDataSource, items, {
        runOcr: async (folder) => {
          if (env.ocr.enabled) queueExtractPo(folder);
          else console.log(`[resume] OCR_ENABLED=false: ${folder} stays queued`);
        },
      });
    })().catch((err) => console.error('[resume] failed:', err instanceof Error ? err.message : err));
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, shutting down...`);
    await listener?.stop();
    stopPeriodKeeper();
    await stopQueue().catch(() => undefined); // what still waits is sent at the next start
    server.close(async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void start();
