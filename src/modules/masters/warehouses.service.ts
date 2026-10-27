import { AppDataSource } from '../../config/data-source';
import { DetailsChannel } from '../../entities';

/*
 * The Warehouses screen, two lists:
 *   GET /masters/warehouses/channel   every channel delivery location (details_channels, about 320 rows), sorted by
 *                                     channel then location code. Values as stored; the address embeddings are not sent.
 *   GET /masters/warehouses/pep       our own facilities. There is NO warehouse table, so the list is built from
 *                                     details_channels.facility_code: one item per facility (spellings that differ
 *                                     only in upper / lower case are one facility), with the locations it serves.
 *                                     Entity, city, type, GSTINs, status have no column, so they are not sent.
 * City, appointment channel and an active flag of a channel location have no column either.
 */

export interface ChannelWarehouseItem {
  id: string;
  channelId: number;
  /** details_channels.channel_name as stored (may differ in case from master_channels.display_name). */
  channelName: string;
  /** The channel's own name for the location (DC / FC code), used to match a PO's location. */
  locationCode: string | null;
  uniwareCustomerCode: string | null;
  /** The Uniware channel the sale order goes to. */
  channelCode: string | null;
  /** The PEP facility (Uniware) that ships to this location. */
  facilityCode: string | null;
  consigneeName: string | null;
  consigneeState: string | null;
  consigneeGstNumber: string | null;
  consigneePinCode: string | null;
  shippingAddress: string | null;
  billingAddress: string | null;
  buyerType: string | null;
  buyerGstNumber: string | null;
  buyerState: string | null;
  buyerPinCode: string | null;
  tallyLedgerName: string | null;
  updatedAt: Date | null;
}

export interface PepWarehouseItem {
  /** The spelling most locations use. */
  facilityCode: string;
  /** Every spelling found in details_channels.facility_code, most used first (more than one = a data problem). */
  spellings: string[];
  /** Channel locations it serves. */
  locationCount: number;
  /** Channels it serves (details_channels.channel_name), distinct, sorted. */
  channels: string[];
}

export async function listChannelWarehouses(): Promise<ChannelWarehouseItem[]> {
  // Only the columns sent (2026-10-27): all columns pulled the two address embeddings too (0.8 MB for 514 rows, ~0.5 s).
  const rows = await AppDataSource.getRepository(DetailsChannel).find({
    select: {
      id: true, channelId: true, channelName: true, channelLocationCode: true, uniwareCustomerCode: true, channelCode: true,
      facilityCode: true, consigneeName: true, consigneeState: true, consigneeGstNumber: true, consigneePinCode: true,
      finalShippingAddress: true, finalBillingAddress: true, buyerType: true, buyerGstNumber: true, buyerState: true,
      buyerPinCode: true, tallyLedgerName: true, updatedAt: true,
    },
    // id last: rows with the same channel + location code keep one order (MySQL returns ties in any order)
    order: { channelName: 'ASC', channelLocationCode: 'ASC', id: 'ASC' },
  });
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    channelName: r.channelName,
    locationCode: r.channelLocationCode,
    uniwareCustomerCode: r.uniwareCustomerCode,
    channelCode: r.channelCode,
    facilityCode: r.facilityCode,
    consigneeName: r.consigneeName,
    consigneeState: r.consigneeState,
    consigneeGstNumber: r.consigneeGstNumber,
    consigneePinCode: r.consigneePinCode,
    shippingAddress: r.finalShippingAddress,
    billingAddress: r.finalBillingAddress,
    buyerType: r.buyerType,
    buyerGstNumber: r.buyerGstNumber,
    buyerState: r.buyerState,
    buyerPinCode: r.buyerPinCode,
    tallyLedgerName: r.tallyLedgerName,
    updatedAt: r.updatedAt,
  }));
}

export async function listPepWarehouses(): Promise<PepWarehouseItem[]> {
  const rows = await AppDataSource.getRepository(DetailsChannel).find({ select: { channelName: true, facilityCode: true } });
  const byFacility = new Map<string, { spellings: Map<string, number>; channels: Set<string>; count: number }>();
  for (const r of rows) {
    if (!r.facilityCode) continue;
    const key = r.facilityCode.trim().toUpperCase();
    const f = byFacility.get(key) ?? { spellings: new Map(), channels: new Set(), count: 0 };
    f.spellings.set(r.facilityCode, (f.spellings.get(r.facilityCode) ?? 0) + 1);
    f.channels.add(r.channelName);
    f.count += 1;
    byFacility.set(key, f);
  }
  return [...byFacility.values()]
    .map((f) => {
      const spellings = [...f.spellings.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
      return { facilityCode: spellings[0], spellings, locationCount: f.count, channels: [...f.channels].sort() };
    })
    .sort((a, b) => b.locationCount - a.locationCount);
}
