import { Router } from 'express';
import multer from 'multer';
import { ACCESS_LEVEL, BULK_DOCS, BULK_ORDERS_TEAM, PAGE } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { teamBulkOrder, teamBulkOrders } from '../modules/bulk-orders/bulk-orders.service';
import { teamOpenBulkDocument, teamSetBulkPayment, teamUploadBulkDocument } from '../modules/bulk-orders/bulk-documents.service';
import { bulkProcessOptions, processBulkOrder } from '../modules/bulk-orders/bulk-process.service';
import { sendDocument } from './bulk-documents.send';

/*
 * PO Processing & Review > Bulk Orders (2026-11-11, Bulk Orders step 3a): our team sees the portal's Marketing /
 * Institutional orders, READ ONLY, with PO review access (the portal's bulk roles are not needed; portal people, who have
 * no PO review page, are refused). Processing an approved order (warehouse, customer code, Create PO) = step 3b.
 *   GET /po-review/bulk-orders?type=&status=&q=&page=&pageSize=   orders of both types, newest first;
 *                                                                  meta.waiting = approved orders per type (tab count)
 *   GET /po-review/bulk-orders/:id                                 one order with lines + timeline + documents
 *   POST /po-review/bulk-orders/:id/documents                      multipart kind + file (PO review EDITOR; 2026-11-12)
 *   GET /po-review/bulk-orders/:id/documents/:docId                the file (streamed from S3)
 *   GET /po-review/bulk-orders/:id/process-options                 warehouses + matching saved customers (EDITOR; 3b)
 *   POST /po-review/bulk-orders/:id/process                        { facilityCode, uniwareChannel, customerCode } ->
 *                                                                  sale order (EDITOR; 2026-11-12, bulk-process.service)
 *   POST /po-review/bulk-orders/:id/payment                        { action: verify | refuse | not_needed, note? } (PO review
 *                                                                  VIEWER + special permission "Bulk Orders: verify payments":
 *                                                                  admin / developer, or a role it is on for; 2026-11-13)
 * Mounted BEFORE the PO review routes (routes/index.ts), so "bulk-orders" is never read as an upload id.
 */
const router = Router();
const viewer = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER)];
const editor = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.EDITOR)];
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: BULK_DOCS.MAX_BYTES } }).single(BULK_DOCS.FIELD_FILE);

router.get(BULK_ORDERS_TEAM.ROUTES.LIST, ...viewer, async (req, res, next) => {
  try {
    const { items, meta } = await teamBulkOrders(req.query);
    res.json({ data: items, meta });
  } catch (err) {
    next(err);
  }
});
router.get(BULK_ORDERS_TEAM.ROUTES.ONE, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await teamBulkOrder(String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});
router.post(BULK_ORDERS_TEAM.ROUTES.DOCUMENTS, ...editor, upload, async (req, res, next) => {
  try {
    const file = req.file ? { originalname: req.file.originalname, buffer: req.file.buffer } : undefined;
    res.status(201).json({ data: await teamUploadBulkDocument(req.auth!.user.id, String(req.params.id), (req.body ?? {}) as Record<string, unknown>, file) });
  } catch (err) {
    next(err);
  }
});
router.get(BULK_ORDERS_TEAM.ROUTES.DOCUMENT, ...viewer, sendDocument((req) => teamOpenBulkDocument(String(req.params.id), String(req.params.docId))));
router.post(BULK_ORDERS_TEAM.ROUTES.PAYMENT, ...viewer, async (req, res, next) => {
  try {
    res.json({ data: await teamSetBulkPayment({ id: req.auth!.user.id, roles: req.auth!.roles }, String(req.params.id), (req.body ?? {}) as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});
router.get(BULK_ORDERS_TEAM.ROUTES.PROCESS_OPTIONS, ...editor, async (req, res, next) => {
  try {
    res.json({ data: await bulkProcessOptions(String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});
router.post(BULK_ORDERS_TEAM.ROUTES.PROCESS, ...editor, async (req, res, next) => {
  try {
    const u = req.auth!.user;
    res.json({ data: await processBulkOrder({ id: u.id, email: u.email }, String(req.params.id), (req.body ?? {}) as Record<string, unknown>) });
  } catch (err) {
    next(err);
  }
});

export default router;
