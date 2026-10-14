import { AppDataSource } from '../../config/data-source';
import { MasterChannelSku } from '../../entities';

/*
 * GET /masters/channel-skus: every row of master_channel_skus (about 2,300), sorted by channel then channel code.
 * The page searches and filters in the browser, so no paging yet. Values are sent as stored: an empty column is null.
 * A channel code is unique only within its channel (104 codes are used by more than one channel), so `id` is the key.
 * The page's status (Live / Discontinued / Unmapped) has no column in master_channel_skus, so it is not sent.
 */

export interface ChannelSkuItem {
  id: string;
  channelId: number | null;
  /** master_channels.display_name. */
  channelName: string | null;
  /** The channel's own SKU code (Blinkit item id, Purplle PPLB..., Reliance article no). */
  channelCode: string | null;
  pepCode: string;
  productName: string | null;
  brand: string | null;
  mrp: number | null;
  /** As stored: a fraction of MRP (0.27 = 27 %). */
  margin: number | null;
  rateAfterMargin: number | null;
  eanCode: string | null;
}

export async function listChannelSkus(): Promise<ChannelSkuItem[]> {
  const rows = await AppDataSource.getRepository(MasterChannelSku).find({ order: { channelName: 'ASC', channelCode: 'ASC' } });
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    channelName: r.channelName,
    channelCode: r.channelCode,
    pepCode: r.pepCode,
    productName: r.productName,
    brand: r.brandName,
    mrp: r.mrp,
    margin: r.margin,
    rateAfterMargin: r.rateAfterMargin,
    eanCode: r.eanCode,
  }));
}
