import { AMAZON } from '../../../constants';
import { spapiGet } from './spapi.client';

/*
 * The Amazon SP-API calls of the inbound tracking (GET only, 2026-10-19). spapiGet keeps the call gap, retries 429 /
 * 5xx and logs every call (AMAZON_CALL / _SLOW / _<FAILURE>). Each call made here is counted in `calls`, so a run can
 * report how many it used.
 *   v2024-03-20: plans (newest first), one plan with all its shipments' statuses, a plan's items, one shipment (its FBA id).
 *   v0:          shipments updated in a time window (all statuses), shipments by FBA ids (50 per call), a shipment's items
 *                (shipped + received quantities).
 */

export const calls = { count: 0 };
const get = <T>(path: string): Promise<T> => {
  calls.count++;
  return spapiGet<T>(path);
};

const M = AMAZON.MARKETPLACE_IN;
const V2024 = AMAZON.INBOUND_V2024_PATH;

export interface PlanListItem { inboundPlanId: string; status?: string; createdAt?: string; lastUpdatedAt?: string; name?: string }
export interface Address { name?: string; companyName?: string; city?: string; postalCode?: string }
export interface Plan extends PlanListItem { sourceAddress?: Address; shipments?: { shipmentId: string; status?: string }[] }
export interface PlanItem { msku: string; fnsku?: string; asin?: string; quantity: number }
export interface Shipment2024 {
  shipmentId: string;
  shipmentConfirmationId?: string;
  name?: string;
  status?: string;
  destination?: { warehouseId?: string; address?: Address };
}
export interface V0Shipment { ShipmentId: string; ShipmentName?: string; ShipmentStatus: string; DestinationFulfillmentCenterId?: string; ShipFromAddress?: Address & { Name?: string; PostalCode?: string } }
export interface V0Item { SellerSKU: string; FulfillmentNetworkSKU?: string; QuantityShipped: number; QuantityReceived?: number }

/** One page of plans, newest created first. */
export const listPlansPage = (token?: string) =>
  get<{ inboundPlans?: PlanListItem[]; pagination?: { nextToken?: string } }>(
    `${V2024}?pageSize=${AMAZON.PLANS_PAGE_SIZE}&sortBy=CREATION_TIME&sortOrder=DESC${token ? `&paginationToken=${encodeURIComponent(token)}` : ''}`,
  );

/** One plan with every shipment's id + status (one call). */
export const getPlan = (planId: string) => get<Plan>(`${V2024}/${encodeURIComponent(planId)}`);

/** What the plan asked for (all pages). */
export const getPlanItems = async (planId: string): Promise<PlanItem[]> => {
  const out: PlanItem[] = [];
  let token: string | undefined;
  for (let n = 0; n < AMAZON.MAX_PAGES; n++) {
    const page = await get<{ items?: PlanItem[]; pagination?: { nextToken?: string } }>(
      `${V2024}/${encodeURIComponent(planId)}/items?pageSize=1000${token ? `&paginationToken=${encodeURIComponent(token)}` : ''}`,
    );
    out.push(...(page.items ?? []));
    token = page.pagination?.nextToken;
    if (!token) break;
  }
  return out;
};

/** One shipment of a plan: its FBA id (shipmentConfirmationId), name, FC and address. */
export const getShipment = (planId: string, shipmentId: string) =>
  get<Shipment2024>(`${V2024}/${encodeURIComponent(planId)}/shipments/${encodeURIComponent(shipmentId)}`);

type V0List = { payload?: { ShipmentData?: V0Shipment[]; NextToken?: string } };
const v0Pages = async (first: string): Promise<V0Shipment[]> => {
  const out: V0Shipment[] = [];
  let page = await get<V0List>(first);
  for (let n = 1; ; n++) {
    out.push(...(page.payload?.ShipmentData ?? []));
    const next = page.payload?.NextToken;
    if (!next || n >= AMAZON.MAX_LIST_PAGES) break;
    page = await get<V0List>(`${AMAZON.SHIPMENTS_PATH}?MarketplaceId=${M}&QueryType=NEXT_TOKEN&NextToken=${encodeURIComponent(next)}`);
  }
  return out;
};

/** Shipments updated in [since, until), every status (closed / cancelled too: we track them). */
export const listChangedShipments = (since: Date, until: Date) =>
  v0Pages(`${AMAZON.SHIPMENTS_PATH}?MarketplaceId=${M}&QueryType=DATE_RANGE&ShipmentStatusList=${AMAZON.ALL_STATUSES.join(',')}` +
    `&LastUpdatedAfter=${encodeURIComponent(since.toISOString())}&LastUpdatedBefore=${encodeURIComponent(until.toISOString())}`);

/** Shipments by FBA id (the daily check, a person's refresh): 50 ids per call. */
export const shipmentsByIds = async (ids: string[]): Promise<V0Shipment[]> => {
  const out: V0Shipment[] = [];
  for (let i = 0; i < ids.length; i += AMAZON.IDS_PER_CALL) {
    const chunk = ids.slice(i, i + AMAZON.IDS_PER_CALL).map(encodeURIComponent).join(',');
    out.push(...(await v0Pages(`${AMAZON.SHIPMENTS_PATH}?MarketplaceId=${M}&QueryType=SHIPMENT&ShipmentIdList=${chunk}&ShipmentStatusList=${AMAZON.ALL_STATUSES.join(',')}`)));
  }
  return out;
};

/** A shipment's lines with shipped + received quantities. Amazon repeats its last page: stop when nothing new comes. */
export const shipmentItems = async (fbaId: string): Promise<V0Item[]> => {
  const items: V0Item[] = [];
  let page = await get<{ payload?: { ItemData?: V0Item[]; NextToken?: string } }>(`${AMAZON.ITEMS_PATH(fbaId)}?MarketplaceId=${M}`);
  for (let n = 1; ; n++) {
    const fresh = (page.payload?.ItemData ?? []).filter((it) => !items.some((x) => x.SellerSKU === it.SellerSKU));
    items.push(...fresh);
    const next = page.payload?.NextToken;
    if (!next || !fresh.length || n >= AMAZON.MAX_PAGES) break;
    page = await get(`${AMAZON.ITEMS_PATH(fbaId)}?MarketplaceId=${M}&NextToken=${encodeURIComponent(next)}`);
  }
  return items;
};
