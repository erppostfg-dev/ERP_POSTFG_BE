import { Router } from 'express';
import { AppDataSource } from '../config/data-source';

const router = Router();

router.get('/', async (_req, res) => {
  let database = 'disconnected';
  if (AppDataSource.isInitialized) {
    try {
      await AppDataSource.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'error';
    }
  }

  res.json({
    success: true,
    status: 'ok',
    database,
    timestamp: new Date().toISOString(),
  });
});

export default router;
