import { CHANNELS } from './channels';

/*
 * Channel API connectors (2026-10-16, user): POs that come from a channel's API instead of an email. Each connector
 * (modules/channel-api/<name>) pulls what changed, saves the raw data + processed.json like an email folder, and the
 * SAME chain takes it from there (validation, PO Review, PO tables, sale order, Uniware CSV). Amazon first; Flipkart
 * and others later = one more connector + its constants here.
 */

/** po_uploads.source_system and channel_api_sync.connector: which connector a PO came from. */
export const SOURCE_SYSTEM = {
  AMAZON_SPAPI: 'amazon_spapi',
} as const;
export type SourceSystem = (typeof SOURCE_SYSTEM)[keyof typeof SOURCE_SYSTEM];

/** Shown next to "API" on the screens (e.g. "API · Amazon"). */
export const SOURCE_SYSTEM_LABEL: Record<SourceSystem, string> = {
  [SOURCE_SYSTEM.AMAZON_SPAPI]: 'Amazon SP-API',
};

/** The scheduler: a connector that fails this many runs in a row waits longer (MAX_BACKOFF_MS at most) before retrying. */
export const CHANNEL_API = {
  /** Default minutes between polls when the connector's own env value is not set. */
  DEFAULT_POLL_MINUTES: 15,
  /** A run looks back this much before the last successful check, so nothing on the edge is missed (ms). */
  OVERLAP_MS: 10 * 60_000,
  /** The newest few minutes are left for the next run: Amazon's list can lag behind (ms). */
  SETTLE_MS: 2 * 60_000,
  /** First run of a connector (no check point yet): look back this far (ms). */
  FIRST_LOOKBACK_MS: 30 * 864e5,
  MAX_BACKOFF_MS: 60 * 60_000,
  ERROR_MAX: 500,
} as const;

/*
 * Amazon SP-API, FBA inbound (user, 2026-10-15/16): our stock sent to Amazon FCs. One shipment (FBA15...) = one PO.
 * India marketplace on the EU endpoint. A shipment becomes a PO + sale order code at WORKING, as soon as we first see it
 * (user, 2026-10-19: punched separately on its own date, maybe while still WORKING); lines that change later are caught
 * by the inbound tracking (constants/inbound.ts). Polled every 2 hours by default (user, 2026-10-19).
 */
export const AMAZON = {
  CHANNEL: CHANNELS.AMAZON,
  MARKETPLACE_IN: 'A21TJRUUN4KGV',
  LWA_TOKEN_URL: 'https://api.amazon.com/auth/o2/token',
  HOSTS: {
    NA: 'https://sellingpartnerapi-na.amazon.com',
    EU: 'https://sellingpartnerapi-eu.amazon.com',
    FE: 'https://sellingpartnerapi-fe.amazon.com',
  } as Record<string, string>,
  SHIPMENTS_PATH: '/fba/inbound/v0/shipments',
  ITEMS_PATH: (shipmentId: string) => `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`,
  /** Inbound plans (Fulfillment Inbound v2024-03-20). */
  INBOUND_V2024_PATH: '/inbound/fba/2024-03-20/inboundPlans',
  PLANS_PAGE_SIZE: 30,
  /** v0 "shipments by id": at most this many ids per call. */
  IDS_PER_CALL: 50,
  /** Minutes between polls when AMAZON_POLL_MINUTES is not set (user: every 2 hours). */
  POLL_MINUTES: 120,
  /** Every status: the tracking also follows shipments that close or are cancelled. */
  ALL_STATUSES: ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED', 'CANCELLED', 'DELETED'],
  /** Statuses the poll asks for (all but the final ones). */
  POLL_STATUSES: ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING'],
  /** In these a shipment becomes a PO + sale order code (from WORKING: user, 2026-10-19). */
  SALE_ORDER_STATUSES: ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING'],
  /** Never made into a PO. */
  SKIP_STATUSES: ['CANCELLED', 'DELETED', 'CLOSED'],
  /** Calls: a short pause between them, retries on 429 (throttled) with a growing wait. */
  CALL_GAP_MS: 600,
  RETRIES: 5,
  RETRY_BASE_MS: 2_000,
  /** Pages per list call at most (the shipment items API repeats its last page: stop when nothing new comes). */
  MAX_PAGES: 20,
  /** Pages of the shipment change list at most (50 per page): 30 days of changes were more than 1,000 (2026-10-19). */
  MAX_LIST_PAGES: 300,
  /** "FBA STA (28/09/2026 08:57)-LKO1" -> 28/09/2026: the shipment's creation date (the only date v0 gives). */
  NAME_DATE: /\((\d{2})\/(\d{2})\/(\d{4})/,
  /** input_type in processed.json for an API PO. */
  INPUT_TYPE: 'api',
} as const;
