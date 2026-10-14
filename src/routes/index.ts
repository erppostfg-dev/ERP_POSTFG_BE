import { Router } from 'express';
import authRoutes from './auth.routes';
import healthRoutes from './health.routes';
import mastersRoutes from './masters.routes';
import poIntakeRoutes from './po-intake.routes';
import poOverviewRoutes from './po-overview.routes';
import poReviewRoutes from './po-review.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/masters', mastersRoutes);
router.use('/po-intake', poIntakeRoutes);
router.use('/po-overview', poOverviewRoutes);
router.use('/po-review', poReviewRoutes);

export default router;
