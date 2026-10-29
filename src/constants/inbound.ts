/*
 * Inbound plan + shipment tracking (user, 2026-10-19). A channel's inbound plan (Amazon: one "Send to Amazon"
 * replenishment) is split by the channel into shipments (Amazon: one per FC, FBA15...). We keep one record per plan and
 * per shipment, the shipment's lines (planned / received), and every change we see (Amazon gives no history: the date of
 * a change is when we first saw it). One shipment = one PO = one sale order; the plan is the grouping for tracking.
 * Generic names + source_system so another channel (Flipkart ...) can reuse the tables.
 */

/** What a shipment history row records. */
export const INBOUND_EVENT = {
  /** First time we saw the shipment (with its plan, FC, lines). */
  DISCOVERED: 'discovered',
  STATUS_CHANGED: 'status_changed',
  /** SKUs / quantities differ from what we held. */
  LINES_CHANGED: 'lines_changed',
  /** Received quantities read (RECEIVING / CLOSED). */
  RECEIVED_UPDATED: 'received_updated',
  /** Linked to our PO (po_uploads row) once the PO chain took it. */
  PO_LINKED: 'po_linked',
  /** Something a person must look at (lines changed after punching, cancelled after punching ...). */
  ATTENTION: 'attention',
} as const;
export type InboundEventKind = (typeof INBOUND_EVENT)[keyof typeof INBOUND_EVENT];

/** Where a change was seen. */
export const INBOUND_EVENT_SOURCE = {
  POLL: 'poll',
  /** The daily check of every open shipment. */
  SWEEP: 'sweep',
  /** A person pressed Refresh (or the re-check before a CSV download). */
  REFRESH: 'refresh',
  /** The first load / the command line. */
  SCRIPT: 'script',
} as const;
export type InboundEventSource = (typeof INBOUND_EVENT_SOURCE)[keyof typeof INBOUND_EVENT_SOURCE];

/** Amazon shipment statuses in their order (the screens draw the path in this order). */
export const AMAZON_SHIPMENT_STATUS_ORDER = [
  'WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED',
] as const;
/** Lines can still change in these (before the shipment is shipped). */
export const AMAZON_EDITABLE_STATUSES = ['WORKING', 'READY_TO_SHIP'] as const;
/** Received quantities are worth reading in these. */
export const AMAZON_RECEIVING_STATUSES = ['RECEIVING', 'CLOSED'] as const;
/** Finished: no more polling of lines (status still followed for CLOSED -> nothing after). */
export const AMAZON_FINAL_STATUSES = ['CLOSED', 'CANCELLED', 'DELETED'] as const;

/**
 * "Stuck" limits (user, 2026-10-19): a shipment longer than this many days in a status gets a warning. Editable
 * (inbound_status_limits); later per courier for IN_TRANSIT (courier_partner_id). These are the defaults the migration
 * writes.
 */
export const INBOUND_DEFAULT_LIMITS: readonly { status: string; maxDays: number }[] = [
  { status: 'WORKING', maxDays: 7 },
  { status: 'IN_TRANSIT', maxDays: 10 },
  { status: 'RECEIVING', maxDays: 15 },
];

export const INBOUND_SYNC = {
  /** channel_api_sync.connector of the tracking run (its own check point next to the PO runner's). */
  CONNECTOR_KEY: 'amazon_inbound',
  /** First load: plans created in the last N days (user, 2026-10-19: 90). */
  FIRST_LOOKBACK_DAYS: 90,
  /** Plans listed per page (Amazon max 30). */
  PLANS_PAGE_SIZE: 30,
  /** A plan with no shipments yet is looked at again each run for at most this many days. */
  UNSPLIT_RECHECK_DAYS: 14,
  /** Received quantities of a RECEIVING shipment are read at most once per this many hours. */
  RECEIVED_REFRESH_HOURS: 24,
  /** Longest text kept for an event value / an attention reason. */
  TEXT_MAX: 200,
} as const;

/** Attention reasons shown on the shipment (a person acts; the sale order in Uniware is never changed by us). */
export const INBOUND_TEXT = {
  LINES_CHANGED_AFTER_PUNCH: 'Lines changed at Amazon after the sale order was punched: add a top-up or cancel items in Uniware',
  LINES_CHANGED_BEFORE_PUNCH: 'Lines changed at Amazon: check the PO before downloading its CSV',
  CANCELLED_AFTER_PUNCH: (status: string) => `Shipment ${status.toLowerCase()} at Amazon after the sale order was punched: cancel it in Uniware`,
} as const;

/** Routes under /amazon/inbound (routes/amazon-inbound.routes.ts). */
export const INBOUND_ROUTES = {
  BASE: '/amazon/inbound',
  PLANS: '/plans',
  PLAN: '/plans/:planId',
  SHIPMENTS: '/shipments',
  SHIPMENT: '/shipments/:externalId',
  REFRESH: '/shipments/:externalId/refresh',
  LIMITS: '/limits',
  LIMIT: '/limits/:id',
  SYNC: '/sync',
} as const;

/** A stuck limit is 1..365 days. */
export const INBOUND_LIMIT_DAYS = { MIN: 1, MAX: 365, FIELD: 'maxDays' } as const;

