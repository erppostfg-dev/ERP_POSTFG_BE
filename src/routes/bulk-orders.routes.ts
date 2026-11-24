import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { BULK_DOCS, BULK_ORDERS } from '../constants';
import { requireAuth } from '../modules/auth/auth.middleware';
import {
  addBulkLocation,
  approveBulkOrder,
  BulkActor,
  cancelBulkOrder,
  checkBulkReceiverRows,
  createBulkOrder,
  getBulkOrder,
  listBulkLocations,
  listBulkOrders,
  needAnyBulk,
  rejectBulkOrder,
  remindBulkOrder,
  searchBulkSkus,
  updateBulkOrder,
} from '../modules/bulk-orders/bulk-orders.service';
import {
  DocFile, listBulkSettings, needSettingsAdmin, openBulkDocument, setBulkPayment, updateBulkSetting, uploadBulkDocument,
} from '../modules/bulk-orders/bulk-documents.service';
import { readNotifySettings, saveNotifySettings } from '../modules/bulk-orders/bulk-notify.service';
import {
  addInstitutionCustomer, addInstitutionCustomerAddress, listInstitutionCustomers, updateInstitutionCustomer, updateInstitutionCustomerAddress,
  verifyInstitutionCustomerGstin,
} from '../modules/bulk-orders/bulk-institution-customers.service';
import { sendDocument } from './bulk-documents.send';

/*
 * Bulk Orders portal step 1 (2026-11-11, constants/bulk-orders.ts, modules/bulk-orders). Signed in; access = the
 * Bulk Orders pages (editor on a type creates, viewer sees; no page = 403 BULK_NO_ORDER_ACCESS). Who am I + access:
 * GET /auth/me (its access map has the /bulk-orders pages).
 *   GET  /bulk-orders?type=&status=&q=&page=&pageSize=   orders of the types I may see, newest first (+ meta total)
 *   POST /bulk-orders                                     create (editor on its type) -> 201 the order with lines
 *   GET  /bulk-orders/skus?q=                             active PEP SKUs with MRP (code / name / EAN), max 20
 *   GET  /bulk-orders/locations?type=                     saved locations of a type (viewer on it)
 *   POST /bulk-orders/locations                           save one { type, label, address } (editor on the type)
 *   GET  /bulk-orders/:id                                 one order with its lines + timeline (404 if not mine to see)
 * Step 2 (2026-11-11), only while pending_approval (else 409 BULK_ORDER_NOT_PENDING):
 *   PUT  /bulk-orders/:id                                 edit (create's body, type fixed; editor on its type)
 *   POST /bulk-orders/:id/cancel                          { reason? } (editor on its type)
 *   POST /bulk-orders/:id/approve                         { lines?: [{ lineNo, qty?, discountPct? }], removeLines?, note? }
 *                                                         (approver; priced on today's MRP)
 *   POST /bulk-orders/:id/reject                          { reason } (approver)
 * Payment + documents (2026-11-12; any status except rejected / cancelled, else 409 BULK_ORDER_CLOSED):
 *   POST /bulk-orders/:id/documents                       multipart: kind (proforma_invoice | invoice | payment_proof) + file
 *                                                         (PDF / PNG / JPG, 10 MB; editor on its type or approver)
 *   GET  /bulk-orders/:id/documents/:docId                the file (streamed from S3; anyone who sees the order)
 *   POST /bulk-orders/:id/payment                         { action: verify | refuse | not_needed, note? } (special permission
 *                                                         "Bulk Orders: verify payments", 2026-11-13; was the approver)
 * Settings (admin = editor on /bulk-orders):
 *   GET  /bulk-orders/settings                            per type: paymentCheck, approvalOverUnits
 *   PUT  /bulk-orders/settings/:type                      { paymentCheck?, approvalOverUnits? } (orders created after it)
 */

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: BULK_DOCS.MAX_BYTES } }).single(BULK_DOCS.FIELD_FILE);
const fileOf = (req: Request): DocFile | undefined => (req.file ? { originalname: req.file.originalname, buffer: req.file.buffer } : undefined);
const actor = (req: Request): BulkActor => ({ id: req.auth!.user.id, roles: req.auth!.roles });
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const send = (fn: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(status).json({ data: await fn(req) });
  } catch (err) {
    next(err);
  }
};

router.get(BULK_ORDERS.ROUTES.LIST, requireAuth, async (req, res, next) => {
  try {
    const { items, meta } = await listBulkOrders(actor(req), req.query);
    res.json({ data: items, meta });
  } catch (err) {
    next(err);
  }
});
router.post(BULK_ORDERS.ROUTES.CREATE, requireAuth, send((req) => createBulkOrder(actor(req), body(req)), 201));
router.get(BULK_ORDERS.ROUTES.SKUS, requireAuth, send(async (req) => {
  await needAnyBulk(actor(req));
  return searchBulkSkus(req.query.q, req.query.brand);
}));
// v2 piece 2: an uploaded receivers file checked (nothing saved); before the /:id routes
router.post(BULK_ORDERS.ROUTES.RECEIVERS_CHECK, requireAuth, send((req) => checkBulkReceiverRows(actor(req), body(req))));
// v2 piece 5a: Institutional customers (before the /:id routes)
router.get(BULK_ORDERS.ROUTES.CUSTOMERS, requireAuth, send((req) => listInstitutionCustomers(actor(req))));
router.post(BULK_ORDERS.ROUTES.CUSTOMERS, requireAuth, send((req) => addInstitutionCustomer(actor(req), body(req)), 201));
router.put(BULK_ORDERS.ROUTES.CUSTOMER, requireAuth, send((req) => updateInstitutionCustomer(actor(req), String(req.params.customerId), body(req))));
router.post(BULK_ORDERS.ROUTES.CUSTOMER_ADDRESSES, requireAuth, send((req) => addInstitutionCustomerAddress(actor(req), String(req.params.customerId), body(req)), 201));
router.post(BULK_ORDERS.ROUTES.CUSTOMER_GSTIN, requireAuth, send((req) => verifyInstitutionCustomerGstin(actor(req), String(req.params.customerId), body(req))));
router.put(BULK_ORDERS.ROUTES.CUSTOMER_ADDRESS, requireAuth, send((req) => updateInstitutionCustomerAddress(actor(req), String(req.params.customerId), String(req.params.addressId), body(req))));
router.get(BULK_ORDERS.ROUTES.LOCATIONS, requireAuth, send((req) => listBulkLocations(actor(req), req.query.type)));
router.post(BULK_ORDERS.ROUTES.LOCATIONS, requireAuth, send((req) => addBulkLocation(actor(req), body(req)), 201));
// before '/:id', which would take "settings" as an id
// v2 piece 3: email switches (admin; before SETTING)
router.get(BULK_ORDERS.ROUTES.NOTIFY_SETTINGS, requireAuth, send(async (req) => { await needSettingsAdmin(actor(req)); return readNotifySettings(); }));
router.put(BULK_ORDERS.ROUTES.NOTIFY_SETTINGS, requireAuth, send(async (req) => { await needSettingsAdmin(actor(req)); return saveNotifySettings(body(req), actor(req).id); }));
router.get(BULK_ORDERS.ROUTES.SETTINGS, requireAuth, send((req) => listBulkSettings(actor(req))));
router.put(BULK_ORDERS.ROUTES.SETTING, requireAuth, send((req) => updateBulkSetting(actor(req), String(req.params.type), body(req))));
// v2 piece 3: the requester reminds our team to place it
router.post(BULK_ORDERS.ROUTES.REMIND, requireAuth, send((req) => remindBulkOrder(actor(req), String(req.params.id))));
router.get(BULK_ORDERS.ROUTES.ONE, requireAuth, send((req) => getBulkOrder(actor(req), String(req.params.id))));
router.put(BULK_ORDERS.ROUTES.EDIT, requireAuth, send((req) => updateBulkOrder(actor(req), String(req.params.id), body(req))));
router.post(BULK_ORDERS.ROUTES.CANCEL, requireAuth, send((req) => cancelBulkOrder(actor(req), String(req.params.id), body(req))));
router.post(BULK_ORDERS.ROUTES.APPROVE, requireAuth, send((req) => approveBulkOrder(actor(req), String(req.params.id), body(req))));
router.post(BULK_ORDERS.ROUTES.REJECT, requireAuth, send((req) => rejectBulkOrder(actor(req), String(req.params.id), body(req))));
// auth first, so the file is read only for a signed-in person
router.post(BULK_ORDERS.ROUTES.DOCUMENTS, requireAuth, upload, send((req) => uploadBulkDocument(actor(req), String(req.params.id), body(req), fileOf(req)), 201));
router.get(BULK_ORDERS.ROUTES.DOCUMENT, requireAuth, sendDocument((req) => openBulkDocument(actor(req), String(req.params.id), String(req.params.docId))));
router.post(BULK_ORDERS.ROUTES.PAYMENT, requireAuth, send((req) => setBulkPayment(actor(req), String(req.params.id), body(req))));

export default router;
