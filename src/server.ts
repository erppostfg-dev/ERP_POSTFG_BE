import 'reflect-metadata';
import app from './app';
import { AppDataSource } from './config/data-source';
import { env } from './config/env';

const start = async (): Promise<void> => {
  try {
    await AppDataSource.initialize();
    console.log(`Database connected: ${env.db.host}:${env.db.port}/${env.db.name}`);
  } catch (err) {
    console.error('Failed to connect to the database', err);
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    console.log(`Server running on http://localhost:${env.port}${env.apiPrefix}`);  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, shutting down...`);
    server.close(async () => {
      if (AppDataSource.isInitialized) await AppDataSource.destroy();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

void start();
