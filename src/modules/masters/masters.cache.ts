import { CACHE_NS } from '../../constants/cache';
import { forgetCache } from '../cache/cache.service';

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
