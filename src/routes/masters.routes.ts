import { Router } from 'express';
import { ACCESS_LEVEL, MASTER_ROUTES, PAGE } from '../constants';
import { requireAuth, requirePage } from '../modules/auth/auth.middleware';
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
 * All: { data: Item[], meta: { total } }. Next (not built): add/edit once the approvals flow exists.
 */

const router = Router();

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
