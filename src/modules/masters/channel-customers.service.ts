import { AppDataSource } from '../../config/data-source';
import { DetailsChannel, MasterChannel } from '../../entities';

/*
 * GET /masters/channel-customers: every channel of master_channels (about 25), sorted by id, with what its delivery
 * locations (details_channels) say about it: how many there are, their Uniware channel codes and the PEP facilities
 * that serve them. Values are sent as stored: an empty column is null, an empty list is [].
 * The page's legal name, type, billing GSTIN, payment terms, default margin and PO source have no column in
 * master_channels (billing details exist only per location, in details_channels), so they are not sent.
 * Channel type and expiry days (added 2026-10-28 with the new masters) are sent.
 */

export interface ChannelCustomerItem {
  id: number;
  /** Short code used by the software (e.g. blinkit). */
  slug: string;
  /** The name every other table's channel column uses. */
  displayName: string;
  /** Other spellings of the name the intake accepts. */
  aliases: string[];
  isActive: boolean;
  /** details_channels rows of this channel (by channel_id). */
  locationCount: number;
  /** details_channels.channel_code values of its locations (the Uniware channel), distinct, sorted. */
  channelCodes: string[];
  /** details_channels.facility_code values of its locations (the PEP warehouse in Uniware), distinct, sorted. */
  facilityCodes: string[];
  /** B2B / B2C. */
  channelType: string | null;
  /** Expiry the channel accepts, in days ("8 - 12 days" = 8 / 12). */
  expiryDaysMin: number | null;
  expiryDaysMax: number | null;
}

const distinctSorted = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort();

export async function listChannelCustomers(): Promise<ChannelCustomerItem[]> {
  const [channels, locations] = await Promise.all([
    AppDataSource.getRepository(MasterChannel).find({ order: { id: 'ASC' } }),
    AppDataSource.getRepository(DetailsChannel).find({ select: { channelId: true, channelCode: true, facilityCode: true } }),
  ]);
  return channels.map((c) => {
    const own = locations.filter((l) => l.channelId === c.id);
    return {
      id: c.id,
      slug: c.slug,
      displayName: c.displayName,
      aliases: c.dbAliases ?? [],
      isActive: c.isActive,
      locationCount: own.length,
      channelCodes: distinctSorted(own.map((l) => l.channelCode)),
      facilityCodes: distinctSorted(own.map((l) => l.facilityCode)),
      channelType: c.channelType,
      expiryDaysMin: c.expiryDaysMin,
      expiryDaysMax: c.expiryDaysMax,
    };
  });
}
