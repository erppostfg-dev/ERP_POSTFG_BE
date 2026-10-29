import { Router } from 'express';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';
import { HEALTH_STATUS } from '../constants';

const router = Router();

router.get('/', async (_req, res) => {
  let database: string = HEALTH_STATUS.DISABLED;
  if (env.db.enabled) {
    database = HEALTH_STATUS.DOWN;
    if (AppDataSource.isInitialized) {
      try {
        // a DB that does not answer in DB_HEALTH_TIMEOUT_MS counts as down, so /health never hangs
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('health check timed out')), env.db.healthTimeoutMs);
        });
        await Promise.race([AppDataSource.query('SELECT 1'), timeout]).finally(() => clearTimeout(timer));
        database = HEALTH_STATUS.UP;
      } catch {
        database = HEALTH_STATUS.DOWN;
      }
    }
  }

  res.json({
    data: {
      status: HEALTH_STATUS.OK,
      database,
      emailListener: env.pubsub.enabled ? HEALTH_STATUS.ENABLED : HEALTH_STATUS.DISABLED,
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
