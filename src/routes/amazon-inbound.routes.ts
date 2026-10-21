import { Request, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, errorMessage, INBOUND_LIMIT_DAYS, INBOUND_ROUTES, PAGE } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { getPlan, getShipment, listLimits, listPlans, listShipments, syncState, updateLimit } from '../modules/channel-api/amazon/inbound-read.service';
import { refreshShipment } from '../modules/channel-api/amazon/inbound-sync.service';
import { spapiConfigured } from '../modules/channel-api/amazon/spapi.client';
import { appError } from '../utils/AppError';

/*
 * Amazon Inbound page (2026-10-19; page key /operations/amazon-inbound). Reads only our tables; Refresh asks Amazon for
 * one shipment.
 *   GET   /amazon/inbound/plans                      plans with their picture (by status, units, received, stuck, attention)
 *                                                    { data: PlanItem[], meta: { totals } }
 *   GET   /amazon/inbound/plans/:planId              { data: { plan, shipments, events } }
 *   GET   /amazon/inbound/shipments                  every shipment { data: ShipmentItem[], meta: { total } }
 *   GET   /amazon/inbound/shipments/:externalId      { data: { shipment, lines, events } }
 *   POST  /amazon/inbound/shipments/:externalId/refresh   editor: this shipment from Amazon now (status, lines, received)
 *   GET   /amazon/inbound/limits                     stuck limits; PATCH /limits/:id { maxDays } editor
 *   GET   /amazon/inbound/sync                       the tracking run's health (last run / success / error)
 */

const router = Router();
const viewer = [requireAuth, requirePage(PAGE.AMAZON_INBOUND, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.AMAZON_INBOUND, ACCESS_LEVEL.EDITOR)];

router.get(INBOUND_ROUTES.PLANS, ...viewer, async (_req, res, next) => {
  try {
    const { items, totals } = await listPlans();
    res.json({ data: items, meta: { total: items.length, totals } });
  } catch (err) { next(err); }
});

router.get(INBOUND_ROUTES.PLAN, ...viewer, async (req, res, next) => {
  try { res.json({ data: await getPlan(String(req.params.planId)) }); } catch (err) { next(err); }
});

router.get(INBOUND_ROUTES.SHIPMENTS, ...viewer, async (_req, res, next) => {
  try {
    const items = await listShipments();
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) { next(err); }
});

router.get(INBOUND_ROUTES.SHIPMENT, ...viewer, async (req, res, next) => {
  try { res.json({ data: await getShipment(String(req.params.externalId)) }); } catch (err) { next(err); }
});

router.post(INBOUND_ROUTES.REFRESH, ...editor, async (req, res, next) => {
  try {
    if (!spapiConfigured()) throw appError(ERROR_CODES.SPAPI_NOT_CONFIGURED);
    const externalId = String(req.params.externalId);
    const report = await refreshShipment(externalId);
    res.json({ data: { ...(await getShipment(externalId)), changes: report.changes, calls: report.calls } });
  } catch (err) { next(err); }
});

router.get(INBOUND_ROUTES.LIMITS, ...viewer, async (_req, res, next) => {
  try { res.json({ data: await listLimits() }); } catch (err) { next(err); }
});

const daysOf = (req: Request): number => {
  const v = (req.body ?? {})[INBOUND_LIMIT_DAYS.FIELD];
  const n = Number(v);
  if (!Number.isInteger(n) || n < INBOUND_LIMIT_DAYS.MIN || n > INBOUND_LIMIT_DAYS.MAX) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{
      field: INBOUND_LIMIT_DAYS.FIELD, code: ERROR_CODES.FIELD_NOT_INT_RANGE,
      message: errorMessage(ERROR_CODES.FIELD_NOT_INT_RANGE, INBOUND_LIMIT_DAYS.FIELD, INBOUND_LIMIT_DAYS.MIN, INBOUND_LIMIT_DAYS.MAX),
    }]);
  }
  return n;
};

router.patch(INBOUND_ROUTES.LIMIT, ...editor, async (req, res, next) => {
  try { res.json({ data: await updateLimit(Number(req.params.id), daysOf(req), req.auth!.user.id) }); } catch (err) { next(err); }
});

router.get(INBOUND_ROUTES.SYNC, ...viewer, async (_req, res, next) => {
  try { res.json({ data: await syncState() }); } catch (err) { next(err); }
});

export default router;
