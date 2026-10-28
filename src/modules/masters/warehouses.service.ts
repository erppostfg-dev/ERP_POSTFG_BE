import { AppDataSource } from '../../config/data-source';
import { DetailsChannel, MasterFacility } from '../../entities';

/*
 * The Warehouses screen, two lists:
 *   GET /masters/warehouses/channel   every channel delivery location (details_channels, about 320 rows), sorted by
 *                                     channel then location code. Values as stored; the address embeddings are not sent.
 *   GET /masters/warehouses/pep       our own facilities: EVERY master_facilities row (2026-10-28: was built from the
 *                                     locations' facility codes, which listed only the 2 in use), with its columns
 *                                     and the locations / channels it serves (exact code: upper / lower case = main /
 *                                     child warehouse). A code used by locations but missing from master_facilities
 *                                     is listed too (inMaster false). City has no column.
 * Locations send city, drop location, in-transit location, appointment and status too (2026-10-28: the data was there).
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
  city: string | null;
  /** Where the channel drops the stock (In-transit report). */
  dropLocation: string | null;
  /** The In-transit report's location name. */
  intransitLocation: string | null;
  /** Appointment needed (Yes / No) and its type (B2B / B2C). */
  appointmentChannel: string | null;
  appointmentChannelType: string | null;
  isActive: boolean;
}

export interface PepWarehouseItem {
  /** master_facilities.id; null for a code only the locations use (no facility row, no history). */
  id: number | null;
  /** master_facilities.code (exact). */
  facilityCode: string;
  /** Location facility codes equal to it ignoring letter case, most used first (another spelling = a child warehouse or a data problem). */
  spellings: string[];
  /** Channel locations it serves (exact code). */
  locationCount: number;
  /** Channels it serves (details_channels.channel_name), distinct, sorted. */
  channels: string[];
  /** false: a code used by locations that master_facilities does not have. */
  inMaster: boolean;
  name: string | null;
  entity: string | null;
  pickupLocation: string | null;
  state: string | null;
  facilityType: string | null;
  billToGstin: string | null;
  shipToGstin: string | null;
  remarks: string | null;
  isActive: boolean;
  /** pepims / uniware / manual. */
  source: string | null;
  /** The main warehouse of a child one (its code). */
  mainFacilityCode: string | null;
  intransitGroup: string | null;
  intransitType: string | null;
  /** Exported by the In-transit Uniware fetch. */
  uniwareExport: boolean;
}

export async function listChannelWarehouses(): Promise<ChannelWarehouseItem[]> {
  // Only the columns sent (2026-10-27): all columns pulled the two address embeddings too (0.8 MB for 514 rows, ~0.5 s).
  const rows = await AppDataSource.getRepository(DetailsChannel).find({
    select: {
      id: true, channelId: true, channelName: true, channelLocationCode: true, uniwareCustomerCode: true, channelCode: true,
      facilityCode: true, consigneeName: true, consigneeState: true, consigneeGstNumber: true, consigneePinCode: true,
      finalShippingAddress: true, finalBillingAddress: true, buyerType: true, buyerGstNumber: true, buyerState: true,
      buyerPinCode: true, tallyLedgerName: true, updatedAt: true, city: true, dropLocation: true, intransitLocation: true,
      appointmentChannel: true, appointmentChannelType: true, isActive: true,
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
    city: r.city,
    dropLocation: r.dropLocation,
    intransitLocation: r.intransitLocation,
    appointmentChannel: r.appointmentChannel,
    appointmentChannelType: r.appointmentChannelType,
    isActive: r.isActive,
  }));
}

export async function listPepWarehouses(): Promise<PepWarehouseItem[]> {
  const [facilities, locations] = await Promise.all([
    AppDataSource.getRepository(MasterFacility).find({
      select: {
        id: true, code: true, name: true, entity: true, pickupLocation: true, state: true, facilityType: true, billToGstin: true,
        shipToGstin: true, remarks: true, isActive: true, source: true, parentFacilityId: true, intransitGroup: true,
        intransitType: true, uniwareExport: true,
      },
      order: { code: 'ASC' },
    }),
    AppDataSource.getRepository(DetailsChannel).find({ select: { channelName: true, facilityCode: true } }),
  ]);
  const used = new Map<string, { channels: Set<string>; count: number }>();
  for (const l of locations) {
    const code = l.facilityCode?.trim();
    if (!code) continue;
    const u = used.get(code) ?? { channels: new Set(), count: 0 };
    u.channels.add(l.channelName);
    u.count += 1;
    used.set(code, u);
  }
  const codeById = new Map(facilities.map((f) => [f.id, f.code]));
  const spellingsOf = (code: string) => [...used.entries()].filter(([c]) => c.toUpperCase() === code.toUpperCase()).sort((a, b) => b[1].count - a[1].count).map(([c]) => c);
  const items: PepWarehouseItem[] = facilities.map((f) => ({
    id: f.id,
    facilityCode: f.code,
    spellings: spellingsOf(f.code),
    locationCount: used.get(f.code)?.count ?? 0,
    channels: [...(used.get(f.code)?.channels ?? [])].sort(),
    inMaster: true,
    name: f.name, entity: f.entity, pickupLocation: f.pickupLocation, state: f.state, facilityType: f.facilityType,
    billToGstin: f.billToGstin, shipToGstin: f.shipToGstin, remarks: f.remarks, isActive: f.isActive, source: f.source ?? null,
    mainFacilityCode: f.parentFacilityId !== null ? codeById.get(f.parentFacilityId) ?? null : null,
    intransitGroup: f.intransitGroup, intransitType: f.intransitType, uniwareExport: f.uniwareExport,
  }));
  // codes the locations use that master_facilities lacks (a data problem: shown, flagged)
  const known = new Set(facilities.map((f) => f.code));
  for (const [code, u] of used) {
    if (known.has(code)) continue;
    items.push({
      id: null, facilityCode: code, spellings: [code], locationCount: u.count, channels: [...u.channels].sort(), inMaster: false,
      name: null, entity: null, pickupLocation: null, state: null, facilityType: null, billToGstin: null, shipToGstin: null, remarks: null,
      isActive: false, source: null, mainFacilityCode: null, intransitGroup: null, intransitType: null, uniwareExport: false,
    });
  }
  // the ones serving locations first, then by code
  return items.sort((a, b) => b.locationCount - a.locationCount || a.facilityCode.localeCompare(b.facilityCode));
}
