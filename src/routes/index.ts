import { Router } from 'express';
import authRoutes from './auth.routes';
import healthRoutes from './health.routes';
import poIntakeRoutes from './po-intake.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/po-intake', poIntakeRoutes);

export default router;
