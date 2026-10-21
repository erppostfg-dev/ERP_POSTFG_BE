import { env } from '../../../config/env';
import { AMAZON, CHANNEL_API, SOURCE_SYSTEM } from '../../../constants';
import { ProcessedLine, ProcessedPo } from '../../po-processing/common/processed-po';
import { ChannelMasterData, matchKey } from '../../po-validation/master-data';
import { ChannelConnector, ExternalPo, ExternalRef } from '../connector';
import { spapiConfigured, spapiGet } from './spapi.client';

/*
 * Amazon FBA inbound shipments (SP-API v0, 2026-10-16). One shipment (FBA15...) = one PO, to one Amazon FC.
 *   change list: GET /fba/inbound/v0/shipments, QueryType DATE_RANGE + LastUpdatedAfter/Before, all open statuses.
 *   lines:       GET /fba/inbound/v0/shipments/{id}/items (it always returns a NextToken that repeats the page: we stop
 *                when a page adds nothing new).
 * Amazon sends no price, MRP or expiry: MRP and rate come from our Amazon channel SKU master (user: "use what's in the
 * db"), found by the FNSKU (master_channel_skus.channel_code), else by the seller SKU when it is one of our PEP codes.
 * Lines found by neither keep their codes and go to review like any unmapped SKU.
 */

interface V0Shipment {
  ShipmentId: string;
  ShipmentName?: string;
  ShipFromAddress?: { Name?: string; PostalCode?: string };
  DestinationFulfillmentCenterId?: string;
  ShipmentStatus: string;
}
interface V0Item {
  ShipmentId?: string;
  SellerSKU: string;
  FulfillmentNetworkSKU?: string;
  QuantityShipped: number;
  QuantityReceived?: number;
  QuantityInCase?: number;
}
type ListPage = { payload?: { ShipmentData?: V0Shipment[]; NextToken?: string } };
type ItemsPage = { payload?: { ItemData?: V0Item[]; NextToken?: string } };

const M = AMAZON.MARKETPLACE_IN;
const refOf = (s: V0Shipment): ExternalRef => ({
  externalId: s.ShipmentId,
  status: s.ShipmentStatus,
  label: `${s.ShipmentName ?? s.ShipmentId} (${s.DestinationFulfillmentCenterId ?? '?'})`,
  raw: s,
});

const listPages = async (first: string): Promise<V0Shipment[]> => {
  const out: V0Shipment[] = [];
  let page = await spapiGet<ListPage>(first);
  for (let n = 1; ; n++) {
    out.push(...(page.payload?.ShipmentData ?? []));
    const next = page.payload?.NextToken;
    if (!next || n >= AMAZON.MAX_PAGES) break;
    page = await spapiGet<ListPage>(`${AMAZON.SHIPMENTS_PATH}?MarketplaceId=${M}&QueryType=NEXT_TOKEN&NextToken=${encodeURIComponent(next)}`);
  }
  return out;
};

/** "FBA STA (28/09/2026 08:57)-LKO1" -> 2026-09-28; else today. */
const createdOf = (s: V0Shipment): string => {
  const m = s.ShipmentName?.match(AMAZON.NAME_DATE);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : new Date().toISOString().slice(0, 10);
};

export const amazonConnector: ChannelConnector = {
  key: SOURCE_SYSTEM.AMAZON_SPAPI,
  channel: AMAZON.CHANNEL,
  label: 'Amazon SP-API (FBA inbound)',
  pollMinutes: () => env.channelApi.amazon.pollMinutes || AMAZON.POLL_MINUTES,
  configured: spapiConfigured,
  isReady: (status) => (AMAZON.SALE_ORDER_STATUSES as readonly string[]).includes(status),
  isSkipped: (status) => (AMAZON.SKIP_STATUSES as readonly string[]).includes(status),

  async listChanged(since, until) {
    const q = `${AMAZON.SHIPMENTS_PATH}?MarketplaceId=${M}&QueryType=DATE_RANGE&ShipmentStatusList=${AMAZON.POLL_STATUSES.join(',')}` +
      `&LastUpdatedAfter=${encodeURIComponent(since.toISOString())}&LastUpdatedBefore=${encodeURIComponent(until.toISOString())}`;
    return (await listPages(q)).map(refOf);
  },

  async listByIds(ids) {
    if (!ids.length) return [];
    const q = `${AMAZON.SHIPMENTS_PATH}?MarketplaceId=${M}&QueryType=SHIPMENT&ShipmentIdList=${ids.map(encodeURIComponent).join(',')}`;
    return (await listPages(q)).map(refOf);
  },

  async fetch(ref) {
    const s = ref.raw as V0Shipment;
    const items: V0Item[] = [];
    let page = await spapiGet<ItemsPage>(`${AMAZON.ITEMS_PATH(s.ShipmentId)}?MarketplaceId=${M}`);
    for (let n = 1; ; n++) {
      const fresh = (page.payload?.ItemData ?? []).filter((it) => !items.some((x) => x.SellerSKU === it.SellerSKU));
      items.push(...fresh);
      const next = page.payload?.NextToken;
      if (!next || !fresh.length || n >= AMAZON.MAX_PAGES) break;
      page = await spapiGet<ItemsPage>(`${AMAZON.ITEMS_PATH(s.ShipmentId)}?MarketplaceId=${M}&NextToken=${encodeURIComponent(next)}`);
    }
    return { ...ref, poNumber: s.ShipmentId, createdAt: createdOf(s), rawFull: { shipment: s, items } };
  },

  toProcessed(po, master) {
    const { shipment: s, items } = po.rawFull as { shipment: V0Shipment; items: V0Item[] };
    const sources: Record<string, string> = {};
    let total = 0;
    let priced = true;
    const lines: ProcessedLine[] = items.map((it, i) => {
      // The FNSKU first (that is what our Amazon SKU master holds); else the seller SKU when it is one of our PEP codes.
      const fn = (it.FulfillmentNetworkSKU ?? '').trim();
      const byFn = master?.skusByCode.get(matchKey(fn)) ?? [];
      const byPep = byFn.length ? [] : (master?.skusByPep.get(matchKey(it.SellerSKU)) ?? []);
      const row = byFn.length === 1 ? byFn[0] : byPep.find((r) => r.rateAfterMargin !== null) ?? byPep[0];
      const code = byFn.length ? fn : row ? row.channelCode : fn || it.SellerSKU;
      const rate = row?.rateAfterMargin ?? null;
      const mrp = row?.mrp ?? null;
      const qty = Number(it.QuantityShipped) || 0;
      const lineTotal = rate === null ? '' : Math.round(rate * qty * 100) / 100;
      if (lineTotal === '') priced = false;
      else total += lineTotal;
      return {
        line_no: i + 1,
        pep_sku_code: '',
        listing_sku_code: it.SellerSKU,
        channel_sku_code: code ?? '',
        ean: '',
        description: it.SellerSKU,
        qty,
        free_qty: '',
        pep_mrp: '',
        channel_mrp: mrp === null ? '' : Number(mrp),
        landing_rate: rate === null ? '' : Number(rate),
        unit_cost: '',
        line_total: lineTotal,
        margin: '',
        hsn: '',
        gst: '',
        unmapped: {
          seller_sku: it.SellerSKU,
          fnsku: fn,
          quantity_received: String(it.QuantityReceived ?? ''),
          quantity_in_case: String(it.QuantityInCase ?? ''),
          price_from: row ? 'master_channel_skus' : '',
        },
      };
    });
    for (const f of ['po_number', 'po_date', 'delivery_facility_code', 'total_qty']) sources[f] = 'api';
    for (const f of ['po_value', 'net_amount', 'line_items.channel_mrp', 'line_items.landing_rate']) sources[f] = 'master';
    const value = priced ? Math.round(total * 100) / 100 : '';
    return {
      'subject line if email': s.ShipmentName ?? '',
      channel_name: AMAZON.CHANNEL,
      input_type: AMAZON.INPUT_TYPE,
      ref_file_urls: [],
      po_number: s.ShipmentId,
      po_date: po.createdAt,
      type_delivery_facility: '',
      delivery_facility_code: s.DestinationFulfillmentCenterId ?? '',
      'shipping address': '',
      delivery_pincode: '',
      total_line_items: lines.length,
      total_qty: lines.reduce((n, l) => n + (Number(l.qty) || 0), 0),
      po_value: value,
      expected_date: '',
      appointment_date: '',
      expiry_date: '',
      delivery_gstin: '',
      vendor_gstin: '',
      cart_discount: 0,
      net_amount: value,
      po_type: 'FBA inbound',
      revised: false,
      revision_of: '',
      line_items: lines,
      unmapped: { amazon_status: s.ShipmentStatus, ship_from: s.ShipFromAddress?.Name ?? '', shipment_name: s.ShipmentName ?? '' },
      field_sources: sources,
      cross_checks: [],
      warnings: [],
      processed_at: new Date().toISOString(),
    };
  },
};
