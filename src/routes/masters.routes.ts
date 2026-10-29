import { NextFunction, Request, Response, Router } from 'express';
import { ACCESS_LEVEL, ERROR_CODES, MASTER_LOG_TYPE, MASTER_ROUTES, MasterLogType, PAGE } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { addChannel, addChannelLocation, addChannelSku, addPepSku, formOptions } from '../modules/masters/master-add.service';
import { isMasterLogType, recentChanges, rowHistory } from '../modules/masters/master-history.service';
import { editRow, setActive } from '../modules/masters/master-edit.service';
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
 *   Every add takes an optional `remark` (2026-10-28) and writes a master_change_logs "created" row.
 *
 * History (2026-10-28; read-only, newest first, master_change_logs + the in-transit uploads' intransit_master_changes):
 *   GET /masters/history/:type/:id   one row's history; type pep_sku | channel_sku | channel | location | facility,
 *                                    id = the row's DB id; viewer on that master's page. { data: MasterHistoryItem[] }
 *   GET /masters/changes?type=&days= every master's changes of the last `days` days (default 7, max 365), at most 500;
 *                                    viewer on /masters. { data: MasterHistoryItem[] }
 *   400 MASTER_HISTORY_BAD_REQUEST for an unknown type / bad id / bad days.
 *
 * Edit + switch on / off (2026-10-28; admin / developer; keys locked; one master_change_logs row per change):
 *   PATCH /masters/edit/:type/:id    { changes: { field: value }, original: { field: value seen }, remark? }
 *                                    -> { changed: string[] }; 400 VALIDATION_FAILED (FIELD_LOCKED / FIELD_NOT_EDITABLE /
 *                                    the Add rules), 404 MASTER_ROW_NOT_FOUND, 409 MASTER_EDIT_CONFLICT [{ field, now }]
 *   POST  /masters/active/:type/:id  { active: boolean, remark? } -> { active, changed }
 *   Re-checks the POs in review afterwards (that channel; every channel for a PEP SKU / warehouse).
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

// ---- Edit + switch on / off (2026-10-28) -------------------------------------
const ok = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req).then((data) => res.json({ data })).catch(next);
};
router.patch(MASTER_ROUTES.EDIT, requireAuth, requireMasterAdmin, ok((req) => editRow(req.params.type, req.params.id, req.body, actor(req))));
router.post(MASTER_ROUTES.ACTIVE, requireAuth, requireMasterAdmin, ok((req) => setActive(req.params.type, req.params.id, req.body, actor(req))));

// ---- History (2026-10-28) ---------------------------------------------------
/** The page whose viewers may read a master's history. */
const HISTORY_PAGE: Record<MasterLogType, string> = {
  [MASTER_LOG_TYPE.PEP_SKU]: PAGE.PEP_SKUS,
  [MASTER_LOG_TYPE.CHANNEL_SKU]: PAGE.CHANNEL_SKUS,
  [MASTER_LOG_TYPE.CHANNEL]: PAGE.CHANNEL_CUSTOMERS,
  [MASTER_LOG_TYPE.LOCATION]: PAGE.CHANNEL_LOCATIONS,
  [MASTER_LOG_TYPE.FACILITY]: PAGE.WAREHOUSES,
};
router.get(MASTER_ROUTES.HISTORY, requireAuth, (req, res, next) => {
  const type = req.params.type;
  // an unknown type is answered by rowHistory (400); a known one needs that master's page
  if (!isMasterLogType(type)) return void rowHistory(type, req.params.id).catch(next);
  void requirePage(HISTORY_PAGE[type], ACCESS_LEVEL.VIEWER)(req, res, (err?: unknown) => {
    if (err) return next(err);
    rowHistory(type, req.params.id).then((data) => res.json({ data })).catch(next);
  });
});
router.get(MASTER_ROUTES.CHANGES, requireAuth, requirePage(PAGE.MASTERS, ACCESS_LEVEL.VIEWER), (req, res, next) => {
  recentChanges({ type: req.query.type, days: req.query.days }).then((data) => res.json({ data })).catch(next);
});

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
