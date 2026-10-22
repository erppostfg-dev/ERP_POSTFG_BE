import { Router } from 'express';
import { INBOUND_ROUTES, PO_VERIFY } from '../constants';
import poVerifyGate from '../modules/po-verify/po-verify.gate';
import adminRoutes from './admin.routes';
import amazonInboundRoutes from './amazon-inbound.routes';
import approvalsRoutes from './approvals.routes';
import authRoutes from './auth.routes';
import healthRoutes from './health.routes';
import mastersRoutes from './masters.routes';
import poIntakeRoutes from './po-intake.routes';
import poOverviewRoutes from './po-overview.routes';
import poReviewRoutes from './po-review.routes';
import poVerifyRoutes from './po-verify.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/approvals', approvalsRoutes);
router.use('/admin', adminRoutes);
router.use(INBOUND_ROUTES.BASE, amazonInboundRoutes);
router.use('/masters', mastersRoutes);
router.use('/po-intake', poIntakeRoutes);
router.use('/po-overview', poOverviewRoutes);
// The verification gate runs first and only for the Uniware hand-off calls; the review routes are unchanged.
router.use('/po-review', poVerifyGate);
router.use('/po-review', poReviewRoutes);
router.use(PO_VERIFY.BASE, poVerifyRoutes);

export default router;
