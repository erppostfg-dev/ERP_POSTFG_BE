import { DataSource } from 'typeorm';
import { CHANNEL_MASTER_IDS, ChannelName, PO_VERIFY_ACTION, TABLES } from '../../constants';
import { DetailsChannel, MasterChannel, MasterChannelSku, MasterFacility, MasterPurchaseOrder, MasterSku } from '../../entities';
import { CodeIndex, codeIndex, EXACT_MATCH, matchKey } from '../masters/master-match';

export { matchKey };

/**
 * The master data one channel's POs are validated against, read once per run (read-only).
 * Keys are trimmed and lower-cased, so matching is case-insensitive (Zepto's codes are upper case in the master).
 */
export interface ChannelMasterData {
  channel: MasterChannel;
  /** master_channel_skus rows of this channel, by channel_code. Several rows for one code = ambiguous. */
  skusByCode: Map<string, MasterChannelSku[]>;
  /** The same rows by pep_code: what a reviewer can map a line to. */
  skusByPep: Map<string, MasterChannelSku[]>;
  /** details_channels rows (delivery locations) of this channel that are active. */
  locations: DetailsChannel[];
  /** master_facilities by id, code and alias: the Uniware facility code of a location. */
  facilities: CodeIndex<MasterFacility>;
  /** master_skus by pep_code: name, brand, GST, MRP. */
  skus: Map<string, MasterSku>;
  /** Is this PO number already saved for this channel? */
  poExists: (poNumber: string) => Promise<boolean>;
}

const groupBy = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
};

/** Reads (never writes) the master data, one channel at a time; master_skus is shared by all channels. */
export class MasterDataReader {
  private skus?: Map<string, MasterSku>;
  private facilities?: CodeIndex<MasterFacility>;
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
    const locations = await this.db.getRepository(DetailsChannel).findBy({ channelId: id, isActive: true });
    this.facilities ??= codeIndex(await this.db.getRepository(MasterFacility).find(), EXACT_MATCH);
    return {
      channel,
      skusByCode: groupBy(channelSkus, (s) => matchKey(s.channelCode)),
      skusByPep: groupBy(channelSkus, (s) => matchKey(s.pepCode)),
      locations,
      facilities: this.facilities,
      skus: this.skus,
      // A PO sent back from verification (po-verify) is cancelled: it no longer counts as a duplicate of itself.
      poExists: async (poNumber) => (await countLivePos(this.db, channel.displayName, poNumber)) > 0,
    };
  }
}

/**
 * Saved POs with this channel + PO number, leaving out those cancelled by a verification send-back
 * (po_verifications, 2026-10-22). Without that table (its migration not run yet) every saved PO counts, as before.
 */
const countLivePos = async (db: DataSource, channel: string, poNumber: string): Promise<number> => {
  const orders = db.getRepository(MasterPurchaseOrder);
  try {
    return await orders
      .createQueryBuilder('o')
      .where('o.channel = :channel AND o.poNumber = :poNumber', { channel, poNumber })
      .andWhere(`o.uid NOT IN (SELECT v.po_uid FROM ${TABLES.PO_VERIFICATIONS} v WHERE v.action = :sentBack AND v.po_uid IS NOT NULL)`, {
        sentBack: PO_VERIFY_ACTION.SENT_BACK,
      })
      .getCount();
  } catch (err) {
    if ((err as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw err;
    return orders.countBy({ channel, poNumber });
  }
};
