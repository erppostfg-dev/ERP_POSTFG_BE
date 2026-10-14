import { DataSource, EntityManager } from 'typeorm';
import { DetailsChannel, MasterChannel, MasterCourierPartner, MasterFacility, MasterPurchaseOrder } from '../../entities';
import { codeIndex, matchKey } from './master-match';

/*
 * masters:link: fills the link columns from the text next to them, so the links follow whatever the masters hold now.
 * Run after every masters:load; safe to run again.
 *   details_channels.facility_id            <- facility_code       (master_facilities code or alias)
 *   master_purchase_orders.facilityId        <- facility            (same)
 *   master_purchase_orders.locationId        <- channel + location  (details_channels of that channel by location code;
 *                                              several -> the one with the PO's customerCode; none -> by customerCode)
 *   master_purchase_orders.first/second/thirdTransporterId <- first/second/thirdTransporter (courier partner code or alias)
 * A link is only set or changed when the text matches; a link whose text no longer matches is kept and reported.
 * The text columns are never changed.
 */

export interface LinkChange {
  id: string;
  from: string | null;
  to: string;
  text: string;
}

export interface LinkTarget {
  /** e.g. "master_purchase_orders.facilityId <- facility" */
  name: string;
  changes: LinkChange[];
  same: number;
  /** Rows with text and no link that could not be matched: text -> how many rows. */
  unmatched: Map<string, number>;
  /** Rows that keep a link although their text matches nothing now. */
  kept: number;
  /** Rows with no text (nothing to link). */
  empty: number;
}

export interface LinkPlan {
  targets: LinkTarget[];
  apply: (m: EntityManager) => Promise<void>;
}

const target = (name: string): LinkTarget => ({ name, changes: [], same: 0, unmatched: new Map(), kept: 0, empty: 0 });

/** Compares the current link with the matched one and records the outcome. */
const record = (t: LinkTarget, id: string, current: string | number | null, text: string | null, matched: string | number | null | undefined, why?: string) => {
  if (!matchKey(text)) { t.empty++; return; }
  if (matched === null || matched === undefined) {
    if (current !== null) t.kept++;
    else { const k = why ? `${text} (${why})` : String(text); t.unmatched.set(k, (t.unmatched.get(k) ?? 0) + 1); }
    return;
  }
  if (current !== null && String(current) === String(matched)) { t.same++; return; }
  t.changes.push({ id, from: current === null ? null : String(current), to: String(matched), text: String(text) });
};

export const planLinks = async (db: DataSource): Promise<LinkPlan> => {
  const facilities = codeIndex(await db.getRepository(MasterFacility).find());
  const partners = codeIndex(await db.getRepository(MasterCourierPartner).find());
  const channelId = new Map((await db.getRepository(MasterChannel).find()).map((c) => [matchKey(c.displayName), c.id]));
  const locations = await db.getRepository(DetailsChannel).find({
    select: ['id', 'channelId', 'channelLocationCode', 'uniwareCustomerCode', 'facilityCode', 'facilityId', 'isActive'],
  });
  const pos = await db.getRepository(MasterPurchaseOrder).find({
    select: ['uid', 'channel', 'location', 'customerCode', 'facility', 'facilityId', 'locationId',
      'firstTransporter', 'secondTransporter', 'thirdTransporter', 'firstTransporterId', 'secondTransporterId', 'thirdTransporterId'],
  });

  const dcFacility = target('details_channels.facility_id <- facility_code');
  for (const l of locations) record(dcFacility, l.id, l.facilityId, l.facilityCode, facilities.find(l.facilityCode)?.id);

  const poFacility = target('master_purchase_orders.facilityId <- facility');
  const poLocation = target('master_purchase_orders.locationId <- channel + location');
  const transporters = ([
    ['firstTransporter', 'firstTransporterId'],
    ['secondTransporter', 'secondTransporterId'],
    ['thirdTransporter', 'thirdTransporterId'],
  ] as const).map(([text, link]) => ({ text, link, t: target(`master_purchase_orders.${link} <- ${text}`) }));

  for (const po of pos) {
    record(poFacility, po.uid, po.facilityId, po.facility, facilities.find(po.facility)?.id);

    const cid = channelId.get(matchKey(po.channel));
    const ofChannel = locations.filter((l) => l.channelId === cid);
    let found = ofChannel.filter((l) => matchKey(l.channelLocationCode) === matchKey(po.location));
    if (found.length > 1) found = found.filter((l) => matchKey(l.uniwareCustomerCode) === matchKey(po.customerCode));
    if (found.length > 1) found = found.filter((l) => l.isActive);
    if (!found.length && matchKey(po.customerCode)) found = ofChannel.filter((l) => matchKey(l.uniwareCustomerCode) === matchKey(po.customerCode));
    const why = cid === undefined ? 'channel not in master_channels' : found.length > 1 ? `${found.length} locations match` : 'no location matches';
    record(poLocation, po.uid, po.locationId, po.location, found.length === 1 ? found[0].id : null, why);

    for (const { text, link, t } of transporters) record(t, po.uid, po[link], po[text], partners.find(po[text])?.id);
  }

  const targets = [dcFacility, poFacility, poLocation, ...transporters.map((x) => x.t)];
  return {
    targets,
    apply: async (m) => {
      for (const c of dcFacility.changes) await m.getRepository(DetailsChannel).update(c.id, { facilityId: Number(c.to) });
      for (const c of poFacility.changes) await m.getRepository(MasterPurchaseOrder).update(c.id, { facilityId: Number(c.to) });
      for (const c of poLocation.changes) await m.getRepository(MasterPurchaseOrder).update(c.id, { locationId: c.to });
      for (const { link, t } of transporters) for (const c of t.changes) await m.getRepository(MasterPurchaseOrder).update(c.id, { [link]: Number(c.to) });
    },
  };
};
