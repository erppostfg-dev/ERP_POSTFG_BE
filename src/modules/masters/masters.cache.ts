import { AppDataSource } from '../../config/data-source';
import { CACHE_NS } from '../../constants/cache';
import { MasterSku } from '../../entities';
import { cached, forgetCache } from '../cache/cache.service';

/*
 * Masters in the shared cache (2026-11-10, modules/cache): the Masters lists and the Add form choices (CACHE_NS.MASTERS)
 * and the PO Overview dropdowns that read facilities / couriers (CACHE_NS.PO_OVERVIEW_FILTERS). Every master add / edit /
 * switch / approval calls forgetMasters() after its commit; loaders outside the server (npm run masters:*, other teams'
 * uploads) show within CACHE_TTL_SECONDS.
 */
export const forgetMasters = async (): Promise<void> => {
  await forgetCache(CACHE_NS.MASTERS);
  await forgetCache(CACHE_NS.PO_OVERVIEW_FILTERS);
};

/**
 * Every PEP SKU (master_skus, all columns) from the shared cache (2026-11-11): ONE DB read per CACHE_TTL_SECONDS for the
 * whole team, dropped at once by forgetMasters(). For SHOWING / SEARCHING only (PO review panels, Bulk Orders SKU search):
 * decisions (PO validation, submit, approve, re-check, a bulk order's price) read master_skus fresh from the DB.
 * Comes back as JSON: dates are text.
 */
export const cachedPepSkus = (): Promise<MasterSku[]> =>
  cached(CACHE_NS.MASTERS, 'panel:skus', () => AppDataSource.getRepository(MasterSku).find());
