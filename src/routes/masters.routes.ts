import { NextFunction, Request, Response, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, MASTER_ROUTES, PAGE } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { addChannel, addChannelLocation, addChannelSku, addPepSku, formOptions } from '../modules/masters/master-add.service';
import { appError } from '../utils/AppError';
import { listChannelCustomers } from '../modules/masters/channel-customers.service';
import { listChannelSkus } from '../modules/masters/channel-skus.service';
import { listPepSkus } from '../modules/masters/pep-skus.service';
import { listChannelWarehouses, listPepWarehouses } from '../modules/masters/warehouses.service';

/*
 * Masters routes: ALL master-data endpoints live here, one block per screen, each guarded by its own page key.
 *   GET /masters/pep-skus   every PEP SKU (master_skus), sorted by pep_code. Viewer on /masters/pep-skus.
 *                           { data: PepSkuItem[], meta: { total } }
 *   GET /masters/channel-skus   every channel SKU mapping (master_channel_skus), sorted by channel, channel code.
 *                               Viewer on /masters/channel-skus. { data: ChannelSkuItem[], meta: { total } }
 *   GET /masters/channel-customers   every channel (master_channels) with its location count, Uniware channel codes and
 *                                    facilities (from details_channels). Viewer on /masters/channel-customers.
 *   GET /masters/warehouses/pep       our facilities, built from details_channels.facility_code (no warehouse table).
 *                                    Viewer on /masters/warehouses.
 *   GET /masters/channel-locations   every channel delivery location (details_channels). Viewer on /masters/channel-locations
 *                                    (Channel Location Master, 2026-10-16; was /masters/warehouses/channel).
 * All: { data: Item[], meta: { total } }.
 *
 * Add forms (2026-10-27; admin / developer only, every field required; 400 VALIDATION_FAILED with details
 * [{ field, code, message }] lists every problem, nothing saved; 403 MASTER_ADD_NOT_ALLOWED for other roles):
 *   GET  /masters/form-options     dropdowns: channels, active facilities, PEP SKUs, SKU types, GST rates, states, Yes / No
 *   POST /masters/pep-skus          { pepCode, productName, brand, productType, mrp, gstTaxType, eanCode, hsnCode,
 *                                     lengthMm, widthMm, heightMm, weightG, shelfLife, isActive } -> 201 { id, pepCode }
 *   POST /masters/channel-skus      { channelId, channelCode, pepCode, productName, brand, mrp, marginPercent,
 *                                     rateAfterMargin, eanCode } -> 201 { id, channel }; re-checks that channel's POs in review
 *   POST /masters/channels          { displayName, slug, aliases[], isActive } -> 201 { id, displayName }
 *   POST /masters/channel-locations { channelId, locationCode, uniwareCustomerCode, uniwareChannelCode, facilityCode,
 *                                     consigneeName, consigneeGstNumber, consigneeState, consigneePinCode, shippingAddress,
 *                                     billingAddress, buyerType, buyerGstNumber, buyerState, buyerPinCode, tallyLedgerName,
 *                                     appointmentChannel } -> 201 { id, channel }; re-checks that channel's POs in review
 */

const router = Router();

/** Adding to the masters: admin / developer only for now (user, 2026-10-27). */
const requireMasterAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r))) {
    return next(appError(ERROR_CODES.MASTER_ADD_NOT_ALLOWED, USER_ADMIN_ROLES.join(' / ')));
  }
  next();
};
const actor = (req: Request) => ({ id: req.auth!.user.id, email: req.auth!.user.email });
const created = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req).then((data) => res.status(201).json({ data })).catch(next);
};

router.get(MASTER_ROUTES.FORM_OPTIONS, requireAuth, requireMasterAdmin, (_req, res, next) => {
  formOptions().then((data) => res.json({ data })).catch(next);
});
router.post(MASTER_ROUTES.PEP_SKUS, requireAuth, requireMasterAdmin, created((req) => addPepSku(req.body, actor(req))));
router.post(MASTER_ROUTES.CHANNEL_SKUS, requireAuth, requireMasterAdmin, created((req) => addChannelSku(req.body, actor(req))));
router.post(MASTER_ROUTES.CHANNELS, requireAuth, requireMasterAdmin, created((req) => addChannel(req.body, actor(req))));
router.post(MASTER_ROUTES.CHANNEL_LOCATIONS, requireAuth, requireMasterAdmin, created((req) => addChannelLocation(req.body, actor(req))));

// ---- PEP SKU master ---------------------------------------------------------
router.get(MASTER_ROUTES.PEP_SKUS, requireAuth, requirePage(PAGE.PEP_SKUS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await listPepSkus();
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- Channel SKU master -----------------------------------------------------
router.get(MASTER_ROUTES.CHANNEL_SKUS, requireAuth, requirePage(PAGE.CHANNEL_SKUS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await listChannelSkus();
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- Channel / Customer master ----------------------------------------------
router.get(MASTER_ROUTES.CHANNEL_CUSTOMERS, requireAuth, requirePage(PAGE.CHANNEL_CUSTOMERS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await listChannelCustomers();
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- Warehouses (PEP facilities + channel locations) -------------------------
router.get(MASTER_ROUTES.PEP_WAREHOUSES, requireAuth, requirePage(PAGE.WAREHOUSES, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await listPepWarehouses();
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

router.get(MASTER_ROUTES.CHANNEL_LOCATIONS, requireAuth, requirePage(PAGE.CHANNEL_LOCATIONS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await listChannelWarehouses();
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

export default router;
