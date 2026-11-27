import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { ACCESS_LEVEL, CACHE_NS, ERROR_CODES, MASTER_LOG_TYPE, MASTER_ROUTES, MasterLogType, PAGE, ROUTE_UPLOAD } from '../constants';
import { USER_ADMIN_ROLES } from '../constants/users';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { accessFrom, allows, loadAccess } from '../modules/auth/access.service';
import { cached } from '../modules/cache/cache.service';
import { forgetMasters } from '../modules/masters/masters.cache';
import { addChannel, addChannelLocation, addChannelSku, addPepSku, formOptions } from '../modules/masters/master-add.service';
import { isMasterLogType, recentChanges, rowHistory } from '../modules/masters/master-history.service';
import { editRow, setActive } from '../modules/masters/master-edit.service';
import { bulkApply, bulkCheck, bulkCurrent, bulkFormat } from '../modules/masters/master-bulk.service';
import { appError } from '../utils/AppError';
import { listChannelCustomers } from '../modules/masters/channel-customers.service';
import { listChannelSkus } from '../modules/masters/channel-skus.service';
import { listPepSkus } from '../modules/masters/pep-skus.service';
import { listChannelWarehouses, listPepWarehouses } from '../modules/masters/warehouses.service';
import { editTransferRoute, listTransferRoutes } from '../modules/masters/transfer-routes.service';
import { importRoutesUpload, previewRoutesUpload, routesTemplateCsv, UploadFile } from '../modules/masters/transfer-routes-upload';
import { env } from '../config/env';
import { readSettings } from '../modules/d2c-transfers/settings';
import { testCodesOf } from '../modules/d2c-transfers/test-mode';

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
 *                                    Each row has allowInternalTransfer (D2C transfers, 2026-11-03; edited as Yes / No).
 *   GET /masters/channel-locations   every channel delivery location (details_channels). Viewer on /masters/channel-locations
 *                                    (Channel Location Master, 2026-10-16; was /masters/warehouses/channel).
 * All: { data: Item[], meta: { total } }.
 *
 * Add forms (2026-10-27; admin / developer, or EDITOR on that master's page since 2026-11-25; every field required; 400 VALIDATION_FAILED with details
 * [{ field, code, message }] lists every problem, nothing saved; 403 MASTER_ADD_NOT_ALLOWED for everyone else):
 *   GET  /masters/form-options     (editor of any Masters page) dropdowns: channels, active facilities, PEP SKUs, SKU types, GST rates, states, Yes / No
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
 * Edit + switch on / off (2026-10-28; admin / developer, or EDITOR on that master's page since 2026-11-25; keys locked; one master_change_logs row per change):
 *   PATCH /masters/edit/:type/:id    { changes: { field: value }, original: { field: value seen }, remark? }
 *                                    -> { changed: string[] }; 400 VALIDATION_FAILED (FIELD_LOCKED / FIELD_NOT_EDITABLE /
 *                                    the Add rules), 404 MASTER_ROW_NOT_FOUND, 409 MASTER_EDIT_CONFLICT [{ field, now }]
 *   POST  /masters/active/:type/:id  { active: boolean, remark? } -> { active, changed }
 *   Re-checks the POs in review afterwards (that channel; every channel for a PEP SKU / warehouse).
 *
 * D2C internal transfer routes (2026-11-03; d2c_transfer_routes, loaded by npm run d2c:routes-load):
 *   GET   /masters/transfer-routes      every route (sender, channel, location, receiving facility, PO prefix, Uniware
 *                                       channel / customer / vendor codes, active, missingVendor / missingCustomer /
 *                                       missingChannel). Viewer on /masters/warehouses. { data: TransferRouteItem[], meta: { total, testOnly, testFacilities } }
 *   PATCH /masters/transfer-routes/:id  { changes: { uniwareChannelCode?, customerCode?, vendorCode?, isActive? }, original?,
 *                                       remark? } -> { changed: string[] }; admin / developer or Warehouses editor; logged (history type
 *                                       transfer_route); 400 / 404 / 409 as the edit above. The location's PO prefix and
 *                                       receiving facility: PATCH /masters/edit/location/:locationId (transferPoPrefix,
 *                                       transferFacilityId).
 *   GET   /masters/transfer-routes/template          (viewer) the upload .csv: header + one real route as the example
 *   POST  /masters/transfer-routes/upload/preview    (Warehouses editor) multipart "file" (.csv) -> every row: new / update /
 *                                                    same / error, its changes, warehouses to switch on; nothing saved
 *   POST  /masters/transfer-routes/upload/import     the same file (+ remark) -> 201 { added, updated, unchanged, switchedOn };
 *                                                    all or nothing: 422 ROUTE_UPLOAD_INVALID [{ row, message }] (transfer-routes-upload.ts)
 */

const router = Router();

/** The Masters page whose access decides who may read / change a master (history, add, edit, switch). */
const MASTER_PAGE: Record<MasterLogType, string> = {
  [MASTER_LOG_TYPE.PEP_SKU]: PAGE.PEP_SKUS,
  [MASTER_LOG_TYPE.CHANNEL_SKU]: PAGE.CHANNEL_SKUS,
  [MASTER_LOG_TYPE.CHANNEL]: PAGE.CHANNEL_CUSTOMERS,
  [MASTER_LOG_TYPE.LOCATION]: PAGE.CHANNEL_LOCATIONS,
  [MASTER_LOG_TYPE.FACILITY]: PAGE.WAREHOUSES,
  [MASTER_LOG_TYPE.TRANSFER_ROUTE]: PAGE.TRANSFER_ROUTES,
};
const EDITABLE_PAGES = [...new Set(Object.values(MASTER_PAGE))];
const isMasterAdmin = (req: Request) => !!req.auth?.roles.some((r) => (USER_ADMIN_ROLES as readonly string[]).includes(r));

/*
 * Changing the masters (add / edit / switch on-off): admin / developer always; anyone else needs EDITOR on that master's
 * page (Users & Roles -> Roles, or their own page access). Was admin / developer only (2026-10-27); user 2026-11-25:
 * "the role's page access must work" (Saurabh, Operations Executive, Editor on Channel SKUs, had no Edit / Add).
 * Margin / rate changes still wait for their approvals (margin-requests.ts), whoever asks.
 */
const requireMasterEditor = (pages: (req: Request) => string[] | null) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) return next(appError(ERROR_CODES.UNAUTHENTICATED));
  if (isMasterAdmin(req)) return next();
  const wanted = pages(req);
  if (!wanted) return next(); // unknown master type: the service answers 400 (nothing is written)
  loadAccess(req.auth.user.id, req.auth.roles)
    .then((rows) => {
      if (wanted.some((p) => allows(accessFrom(rows, p), ACCESS_LEVEL.EDITOR))) return next();
      next(appError(ERROR_CODES.MASTER_ADD_NOT_ALLOWED, `admin / developer or an editor of ${wanted.join(' / ')}`));
    })
    .catch(next);
};
/** Editor of this one page. */
const editorOf = (page: string) => requireMasterEditor(() => [page]);
/** Editor of the page of the :type in the address (edit / switch). */
const editorOfType = requireMasterEditor((req) => (isMasterLogType(req.params.type) ? [MASTER_PAGE[req.params.type]] : null));
const actor = (req: Request) => ({ id: req.auth!.user.id, email: req.auth!.user.email });
// every write drops the cached Masters lists before it answers (the screen reloads right after; 2026-11-10)
const created = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req).then(async (data) => { await forgetMasters(); res.status(201).json({ data }); }).catch(next);
};

// the Add / Edit forms' dropdowns: an editor of any Masters page
router.get(MASTER_ROUTES.FORM_OPTIONS, requireAuth, requireMasterEditor(() => EDITABLE_PAGES), (_req, res, next) => {
  cached(CACHE_NS.MASTERS, 'form-options', formOptions).then((data) => res.json({ data })).catch(next);
});
router.post(MASTER_ROUTES.PEP_SKUS, requireAuth, editorOf(PAGE.PEP_SKUS), created((req) => addPepSku(req.body, actor(req))));
router.post(MASTER_ROUTES.CHANNEL_SKUS, requireAuth, editorOf(PAGE.CHANNEL_SKUS), created((req) => addChannelSku(req.body, actor(req))));
router.post(MASTER_ROUTES.CHANNELS, requireAuth, editorOf(PAGE.CHANNEL_CUSTOMERS), created((req) => addChannel(req.body, actor(req))));
router.post(MASTER_ROUTES.CHANNEL_LOCATIONS, requireAuth, editorOf(PAGE.CHANNEL_LOCATIONS), created((req) => addChannelLocation(req.body, actor(req))));

// ---- Edit + switch on / off (2026-10-28) -------------------------------------
const ok = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req).then(async (data) => { await forgetMasters(); res.json({ data }); }).catch(next);
};
router.patch(MASTER_ROUTES.EDIT, requireAuth, editorOfType, ok((req) => editRow(req.params.type, req.params.id, req.body, actor(req))));
router.post(MASTER_ROUTES.ACTIVE, requireAuth, editorOfType, ok((req) => setActive(req.params.type, req.params.id, req.body, actor(req))));

// ---- History (2026-10-28) ---------------------------------------------------
router.get(MASTER_ROUTES.HISTORY, requireAuth, (req, res, next) => {
  const type = req.params.type;
  // an unknown type is answered by rowHistory (400); a known one needs that master's page
  if (!isMasterLogType(type)) return void rowHistory(type, req.params.id).catch(next);
  void requirePage(MASTER_PAGE[type], ACCESS_LEVEL.VIEWER)(req, res, (err?: unknown) => {
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
    const items = await cached(CACHE_NS.MASTERS, 'pep-skus', listPepSkus);
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- Channel SKU master -----------------------------------------------------
router.get(MASTER_ROUTES.CHANNEL_SKUS, requireAuth, requirePage(PAGE.CHANNEL_SKUS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await cached(CACHE_NS.MASTERS, 'channel-skus', listChannelSkus);
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- Channel / Customer master ----------------------------------------------
router.get(MASTER_ROUTES.CHANNEL_CUSTOMERS, requireAuth, requirePage(PAGE.CHANNEL_CUSTOMERS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await cached(CACHE_NS.MASTERS, 'channel-customers', listChannelCustomers);
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- Warehouses (PEP facilities + channel locations) -------------------------
router.get(MASTER_ROUTES.PEP_WAREHOUSES, requireAuth, requirePage(PAGE.WAREHOUSES, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await cached(CACHE_NS.MASTERS, 'pep-warehouses', listPepWarehouses);
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

router.get(MASTER_ROUTES.CHANNEL_LOCATIONS, requireAuth, requirePage(PAGE.CHANNEL_LOCATIONS, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await cached(CACHE_NS.MASTERS, 'channel-locations', listChannelWarehouses);
    res.json({ data: items, meta: { total: items.length } });
  } catch (err) {
    next(err);
  }
});

// ---- D2C internal transfer routes (2026-11-03) ---------------------------------
router.get(MASTER_ROUTES.TRANSFER_ROUTES, requireAuth, requirePage(PAGE.TRANSFER_ROUTES, ACCESS_LEVEL.VIEWER), async (_req, res, next) => {
  try {
    const items = await listTransferRoutes();
    // testOnly: local D2C test mode (env.d2c.testOnly), the tab shows a "TEST_FACILITY only" banner
    res.json({ data: items, meta: { total: items.length, testOnly: env.d2c.testOnly, testFacilities: env.d2c.testOnly ? testCodesOf(await readSettings()) : [] } });
  } catch (err) {
    next(err);
  }
});
router.patch(MASTER_ROUTES.TRANSFER_ROUTE, requireAuth, editorOf(PAGE.TRANSFER_ROUTES), ok((req) => editTransferRoute(req.params.id, req.body, actor(req))));

// Transfer routes bulk upload (2026-11-25): the template (a real route as the example), preview, import (all or nothing)
const routesFile = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: ROUTE_UPLOAD.MAX_BYTES } }).single(ROUTE_UPLOAD.FIELD);
const fileOf = (req: Request): UploadFile | undefined => (req.file ? { originalname: req.file.originalname, buffer: req.file.buffer } : undefined);
router.get(MASTER_ROUTES.TRANSFER_ROUTES_TEMPLATE, requireAuth, requirePage(PAGE.TRANSFER_ROUTES, ACCESS_LEVEL.VIEWER), (_req, res, next) => {
  routesTemplateCsv().then((csv) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transfer-routes-template.csv"');
    res.send(csv);
  }).catch(next);
});
router.post(MASTER_ROUTES.TRANSFER_ROUTES_PREVIEW, requireAuth, editorOf(PAGE.TRANSFER_ROUTES), routesFile, (req, res, next) => {
  previewRoutesUpload(fileOf(req)).then((data) => res.json({ data })).catch(next);
});
router.post(MASTER_ROUTES.TRANSFER_ROUTES_IMPORT, requireAuth, editorOf(PAGE.TRANSFER_ROUTES), routesFile,
  created((req) => importRoutesUpload(fileOf(req), req.body, actor(req))));

// Bulk upload (2026-11-27, master-bulk.service.ts): format + current data for viewers of that master's page; check
// (nothing saved) + apply (all or nothing) for its editors, the same people as Add / Edit. Rows come as JSON (the browser
// reads the Excel). An unknown :type -> 400 MASTER_BULK_NOT_SUPPORTED.
const viewerOfType = (req: Request, res: Response, next: NextFunction) =>
  (isMasterLogType(req.params.type) ? requirePage(MASTER_PAGE[req.params.type], ACCESS_LEVEL.VIEWER)(req, res, next) : next());
// reads + the check write nothing: answered without dropping the Masters cache (apply drops it, as every write)
const answer = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req).then((data) => res.json({ data })).catch(next);
};
router.get(MASTER_ROUTES.BULK_FORMAT, requireAuth, viewerOfType, answer((req) => bulkFormat(req.params.type)));
router.get(MASTER_ROUTES.BULK_CURRENT, requireAuth, viewerOfType, answer((req) => bulkCurrent(req.params.type)));
router.post(MASTER_ROUTES.BULK_CHECK, requireAuth, editorOfType, answer((req) => bulkCheck(req.params.type, req.body ?? {}, actor(req))));
router.post(MASTER_ROUTES.BULK_APPLY, requireAuth, editorOfType, ok((req) => bulkApply(req.params.type, req.body ?? {}, actor(req))));

export default router;
