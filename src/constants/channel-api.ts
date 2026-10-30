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
  /** Flipkart Seller Hub, read by our robot (2026-10-30). */
  FLIPKART_SELLER_HUB: 'flipkart_seller_hub',
} as const;
export type SourceSystem = (typeof SOURCE_SYSTEM)[keyof typeof SOURCE_SYSTEM];

/** Shown next to "API" on the screens (e.g. "API · Amazon"). */
export const SOURCE_SYSTEM_LABEL: Record<SourceSystem, string> = {
  [SOURCE_SYSTEM.AMAZON_SPAPI]: 'Amazon SP-API',
  [SOURCE_SYSTEM.FLIPKART_SELLER_HUB]: 'Flipkart Seller Hub',
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
 * India marketplace on the EU endpoint. A shipment becomes a PO + sale order code ONLY while WORKING, as soon as we first
 * see it (user, 2026-10-19 / 21); past WORKING it is tracked only, never made a PO; lines that change later are caught
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
  /**
   * Only in WORKING does a shipment become a PO + sale order code (user, 2026-10-21: "work on shipments when it's in
   * working phase only"). A shipment first seen in any later status is tracking only (Amazon Inbound page), never a PO.
   */
  SALE_ORDER_STATUSES: ['WORKING'],
  /** Never made into a PO: final statuses (the connector also skips everything past WORKING, see above). */
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

/*
 * Flipkart scheduled consignments (user, 2026-10-30; port of Kunal's rpa-channel-codes/flipkart_rpa): our stock sent to a
 * Flipkart warehouse. One consignment = one PO, made a PO + sale order as soon as it is SCHEDULED (the robot reads the
 * Scheduled tab only). The robot (modules/channel-api/flipkart, run as an In-transit job: one Seller Hub login, one
 * browser job at a time) reads every row of the Scheduled table, downloads each NEW consignment's CSV (its lines) and
 * the Bulk Consignment File (warehouse, creation date, status of every consignment). Each consignment is kept in
 * channel_pull_items; the connector turns it into a PO like Amazon's (S3 channel-api/FY.../<month>/flipkart/<id>/).
 * A consignment is taken once: a later change is not read again (user, 2026-10-30; backlog G6).
 */
export const FLIPKART = {
  CHANNEL: CHANNELS.FLIPKART,
  /** Seller Hub's Scheduled consignments list. */
  SCHEDULED_URL: 'https://seller.flipkart.com/index.html#dashboard/fa/consignmentsView?stateView=scheduled',
  /** One table row per consignment; its id shows as "ID: 205149496". */
  ROWS: 'table tbody tr',
  ROW_ID: /ID:\s*(\d+)/,
  /** The 3-dots button in a row (its accessible name) and the menu option that downloads the consignment's CSV. */
  MENU_BUTTON: 'icon',
  MENU_ITEM: 'option-item-Download CSV-story',
  MENU_OPTIONS: "[data-testid^='option-item-']",
  /** Rows per page asked for (10 / 20 / 40 offered); every page is read anyway. */
  PAGE_SIZE: '20',
  /** The table footer: "1-16 of 16 items 1 of 1 pages". */
  PAGER_ITEMS: /of\s+(\d+)\s+items/,
  PAGER_PAGES: /of\s+(\d+)\s+pages/,
  /** The consignment CSV's columns (by name; renamed / missing ones go to review, never guessed). */
  CSV: {
    NAME: 'Product Name',
    FSN: 'FSN',
    SKU_ID: 'SKU Id',
    BRAND: 'Brand',
    QTY_SENT: 'Quantity Sent',
    QTY_RECEIVED: 'Quantity Received',
    COST: 'Cost Price',
  },
  /** The Bulk Consignment File's columns (FK_GRN.csv, the same file the In-transit robot downloads). */
  BULK: {
    ID: 'Consignment Id',
    CREATED: 'Creation Date',
    WAREHOUSE: 'Warehouse Id',
    STATUS: 'Consignment Status',
    DISPATCH_TYPE: 'Dispatch Type',
    PICKUP_DATE: 'Scheduled Pick Up Date',
    DROP_DATE: 'Scheduled Drop In Date',
    PROMISED_QTY: 'Promised Qty',
  },
  /** A consignment whose status matches this never becomes a PO. */
  SKIP_STATUS: /CANCEL/i,
  /** Minutes between the connector's looks at the fetched consignments (cheap: the DB only), FLIPKART_POLL_MINUTES overrides. */
  POLL_MINUTES: 15,
  /** A robot run at most this long (one browser job; then it is stopped and failed). */
  ROBOT_TIMEOUT_MS: 30 * 60_000,
  /** File names kept in the consignment's folder (and S3). */
  CSV_FILE: (id: string) => `${id}.csv`,
  INPUT_TYPE: 'rpa',
  /** The In-transit worker's job kind for the robot (run-worker.ts). */
  ROBOT_JOB: 'flipkart-consignments',
  PO_TYPE: 'Flipkart consignment',
} as const;
/*
 * Channel Pulls page (2026-10-30, user: replaces Amazon Inbound in the sidebar; one place for every channel pulled by API
 * or robot, with buttons to pull and process). Same page key as Amazon Inbound (PAGE.AMAZON_INBOUND): nobody's access
 * changes. Viewer reads; editor runs the robot, processes, sets the schedule.
 */
export const CHANNEL_PULLS = {
  BASE: '/channel-pulls',
  ROUTES: {
    LIST: '/',
    ITEMS: '/:key/items',
    ROBOT: '/:key/robot',
    PROCESS: '/:key/process',
    SCHEDULE: '/:key/schedule',
  },
  BODY: { EVERY_HOURS: 'robotEveryHours' },
  /** The schedule: every 1-24 hours, or null = only by Run now. */
  MAX_EVERY_HOURS: 24,
  /** How often the server looks whether a scheduled robot run is due. */
  SCHEDULE_TICK_MS: 5 * 60_000,
  /** app_state key of an API connector's poll schedule (null = its default). */
  POLL_KEY: (key: string) => `channel-pull:${key}:poll`,
  /** Recent consignments listed on the page. */
  ITEMS_MAX: 200,
} as const;