import { Router } from 'express';
import { AppDataSource } from '../config/data-source';
import { env } from '../config/env';

const router = Router();

router.get('/', async (_req, res) => {
  let database = 'disabled';
  if (env.db.enabled) {
    database = 'down';
    if (AppDataSource.isInitialized) {
      try {
        await AppDataSource.query('SELECT 1');
        database = 'up';
      } catch {
        database = 'down';
      }
    }
  }

  res.json({
    data: {
      status: 'ok',
      database,
      emailListener: env.pubsub.enabled ? 'enabled' : 'disabled',
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
