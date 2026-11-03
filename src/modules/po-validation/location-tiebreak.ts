import { LOCATION_TIEBREAK } from '../../constants';
import { DetailsChannel } from '../../entities';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { matchKey } from './master-data';

/*
 * Several delivery locations match the PO (two warehouses share a pincode: Blinkit Bengaluru B4 / B5 562114, Ranchi R1 /
 * R2 834010, ...; user 2026-11-02). The PO itself usually says which one; checked in this order, the first step that
 * leaves exactly ONE location wins, otherwise null (the PO goes to review as before; equals are never guessed):
 *   1. name: the location code's words in the PO's facility text ("BCPL - Bengaluru B5 Feeder Warehouse" -> "Bengaluru
 *      B5"): the location with the most words found, and one of them is a word the other locations do not have;
 *   2. GSTIN: the PO's delivery GSTIN = consignee_gst_number of exactly one location;
 *   3. address: the PO's delivery address vs final_shipping_address (shared words / the smaller word count): one clearly
 *      best (at least ADDRESS_MIN, ADDRESS_MARGIN ahead of the next).
 */

export type LocationPickedBy = 'name' | 'gstin' | 'address';

const words = (s: string | null | undefined): Set<string> =>
  new Set((s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const byName = (rows: DetailsChannel[], facility: string): DetailsChannel | null => {
  const po = words(facility);
  if (!po.size) return null;
  const scored = rows.map((r) => {
    const own = words(r.channelLocationCode);
    const others = rows.filter((o) => o !== r).map((o) => words(o.channelLocationCode));
    const found = [...own].filter((w) => po.has(w));
    const distinct = found.some((w) => others.every((o) => !o.has(w)));
    return { r, score: found.length, distinct };
  });
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  return best > 0 && top.length === 1 && top[0].distinct ? top[0].r : null;
};

const byGstin = (rows: DetailsChannel[], gstin: string): DetailsChannel | null => {
  const key = matchKey(gstin);
  if (!key) return null;
  const hits = rows.filter((r) => matchKey(r.consigneeGstNumber) === key);
  return hits.length === 1 ? hits[0] : null;
};

const byAddress = (rows: DetailsChannel[], address: string): DetailsChannel | null => {
  const po = words(address);
  if (po.size < LOCATION_TIEBREAK.ADDRESS_MIN_WORDS) return null;
  const scored = rows
    .map((r) => {
      const own = words(r.finalShippingAddress);
      const shared = [...own].filter((w) => po.has(w)).length;
      return { r, score: own.size ? shared / Math.min(own.size, po.size) : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  return first.score >= LOCATION_TIEBREAK.ADDRESS_MIN && first.score - (second?.score ?? 0) >= LOCATION_TIEBREAK.ADDRESS_MARGIN ? first.r : null;
};

/** The one location the PO names among several that match, and how it was told apart; null = still a tie (review). */
export const pickOneLocation = (rows: DetailsChannel[], po: ProcessedPo): { row: DetailsChannel; by: LocationPickedBy } | null => {
  if (rows.length < 2) return null;
  const name = byName(rows, po.delivery_facility_code);
  if (name) return { row: name, by: 'name' };
  const gstin = byGstin(rows, po.delivery_gstin);
  if (gstin) return { row: gstin, by: 'gstin' };
  const address = byAddress(rows, po['shipping address']);
  if (address) return { row: address, by: 'address' };
  return null;
};
