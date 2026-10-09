import 'reflect-metadata';
import app from './app';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';
import { startEmailListener } from './modules/email-intake/pubsub.listener';
import { queueExtractPo } from './modules/ocr/extract-po.service';
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
    server.close(async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void start();
