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
        await AppDataSource.query('SELECT 1');
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
