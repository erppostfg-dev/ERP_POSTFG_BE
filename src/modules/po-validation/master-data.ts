import { DataSource } from 'typeorm';
import { CHANNEL_MASTER_IDS, ChannelName } from '../../constants';
import { DetailsChannel, MasterChannel, MasterChannelSku, MasterPurchaseOrder, MasterSku } from '../../entities';

/**
 * The master data one channel's POs are validated against, read once per run (read-only).
 * Keys are trimmed and lower-cased, so matching is case-insensitive (Zepto's codes are upper case in the master).
 */
export interface ChannelMasterData {
  channel: MasterChannel;
  /** master_channel_skus rows of this channel, by channel_code. Several rows for one code = ambiguous. */
  skusByCode: Map<string, MasterChannelSku[]>;
  /** details_channels rows (delivery locations) of this channel. */
  locations: DetailsChannel[];
  /** master_skus by pep_code: name, brand, GST, MRP. */
  skus: Map<string, MasterSku>;
  /** Is this PO number already saved for this channel? */
  poExists: (poNumber: string) => Promise<boolean>;
}

export const matchKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

const groupBy = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
};

/** Reads (never writes) the master data, one channel at a time; master_skus is shared by all channels. */
export class MasterDataReader {
  private skus?: Map<string, MasterSku>;
  private readonly byChannel = new Map<ChannelName, ChannelMasterData | null>();

  constructor(private readonly db: DataSource) {}

  /** null when the channel has no master_channels row (or no id in constants/validation.ts). */
  async forChannel(name: ChannelName): Promise<ChannelMasterData | null> {
    if (!this.byChannel.has(name)) this.byChannel.set(name, await this.load(name));
    return this.byChannel.get(name) ?? null;
  }

  private async load(name: ChannelName): Promise<ChannelMasterData | null> {
    const id = CHANNEL_MASTER_IDS[name];
    const channel = id === undefined ? null : await this.db.getRepository(MasterChannel).findOneBy({ id });
    if (!channel) return null;
    this.skus ??= new Map((await this.db.getRepository(MasterSku).find()).map((s) => [matchKey(s.pepCode), s]));
    const channelSkus = await this.db.getRepository(MasterChannelSku).findBy({ channelId: id });
    const locations = await this.db.getRepository(DetailsChannel).findBy({ channelId: id });
    const orders = this.db.getRepository(MasterPurchaseOrder);
    return {
      channel,
      skusByCode: groupBy(channelSkus, (s) => matchKey(s.channelCode)),
      locations,
      skus: this.skus,
      poExists: async (poNumber) => (await orders.countBy({ channel: channel.displayName, poNumber })) > 0,
    };
  }
}
