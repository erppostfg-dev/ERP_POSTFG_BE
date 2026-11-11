import { Router } from 'express';
import { ACCESS_LEVEL, BULK_ORDERS_TEAM, PAGE } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
import { teamBulkOrder, teamBulkOrders } from '../modules/bulk-orders/bulk-orders.service';

/*
 * PO Processing & Review > Bulk Orders (2026-11-11, Bulk Orders step 3a): our team sees the portal's Marketing /
 * Institutional orders, READ ONLY, with PO review access (the portal's bulk roles are not needed; portal people, who have
 * no PO review page, are refused). Processing an approved order (warehouse, customer code, Create PO) = step 3b.
 *   GET /po-review/bulk-orders?type=&status=&q=&page=&pageSize=   orders of both types, newest first;
 *                                                                  meta.waiting = approved orders per type (tab count)
 *   GET /po-review/bulk-orders/:id                                 one order with lines + timeline
 * Mounted BEFORE the PO review routes (routes/index.ts), so "bulk-orders" is never read as an upload id.
 */
const router = Router();
const viewer = [requireAuth, requirePage(PAGE.PO_REVIEW, ACCESS_LEVEL.VIEWER)];

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

export default router;
