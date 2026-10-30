import { Router } from 'express';
import { CHANNEL_PULLS, FEEDBACK, INBOUND_ROUTES, MAIL_LISTS_ROUTES, MANUAL_UPLOAD, PO_INTAKE, PO_ISSUES, PO_VERIFY, PRICE_DIFFS } from '../constants';
import poVerifyGate from '../modules/po-verify/po-verify.gate';
import adminRoutes from './admin.routes';
import amazonInboundRoutes from './amazon-inbound.routes';
import channelPullsRoutes from './channel-pulls.routes';
import approvalsRoutes from './approvals.routes';
import authRoutes from './auth.routes';
import feedbackRoutes from './feedback.routes';
import healthRoutes from './health.routes';
import intransitRoutes from './intransit.routes';
import mailListsRoutes from './mail-lists.routes';
import manualUploadRoutes from './manual-upload.routes';
import mastersRoutes from './masters.routes';
import poIntakeRoutes from './po-intake.routes';
import poIntakeControlRoutes from './po-intake-control.routes';
import poIssuesRoutes from './po-issues.routes';
import priceDifferencesRoutes from './price-differences.routes';
import poOverviewRoutes from './po-overview.routes';
import poReviewRoutes from './po-review.routes';
import poVerifyRoutes from './po-verify.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/approvals', approvalsRoutes);
router.use(PO_INTAKE.BASE, poIntakeControlRoutes);
router.use(MAIL_LISTS_ROUTES.BASE, mailListsRoutes);
router.use('/admin', adminRoutes);
router.use(INBOUND_ROUTES.BASE, amazonInboundRoutes);
router.use(CHANNEL_PULLS.BASE, channelPullsRoutes);
router.use('/intransit', intransitRoutes);
router.use('/masters', mastersRoutes);
router.use('/po-intake', poIntakeRoutes);
router.use('/po-overview', poOverviewRoutes);
// PO issues (a PO review tab, 2026-10-29): before the review routes, so /po-review/issues is not an upload id.
router.use(PO_ISSUES.BASE, poIssuesRoutes);
router.use(PRICE_DIFFS.BASE, priceDifferencesRoutes);
// The verification gate runs first and only for the Uniware hand-off calls; the review routes are unchanged.
router.use('/po-review', poVerifyGate);
router.use('/po-review', poReviewRoutes);
router.use(PO_VERIFY.BASE, poVerifyRoutes);
router.use(MANUAL_UPLOAD.BASE, manualUploadRoutes);
router.use(FEEDBACK.BASE, feedbackRoutes);

export default router;
