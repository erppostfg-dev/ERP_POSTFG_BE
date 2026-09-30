import { Router } from 'express';
import healthRoutes from './health.routes';
import poIntakeRoutes from './po-intake.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/po-intake', poIntakeRoutes);

export default router;
