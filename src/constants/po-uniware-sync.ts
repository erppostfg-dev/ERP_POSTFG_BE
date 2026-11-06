/*
 * Uniware sale order status for channel POs (2026-11-06, user: "check Uniware for the status of the sale order, the same
 * as ERP POST_FG's D2C transfers"). Read-only on Uniware (saleorder/get, as d2c-transfers/sync.service.ts). Rules (user):
 *   - every channel PO with a sale order code (master_purchase_orders.orderNo1, transferCode IS NULL) until it is fully
 *     dispatched or cancelled in Uniware; one not uploaded yet answers INVALID_SALE_ORDER_CODE = "Not in Uniware yet";
 *   - Uniware moves Status (Warehouse) FORWARD only (Picking -> Packed -> RTS -> Dispatched) and Status (Logistics) to
 *     Dispatched once everything is dispatched; never backwards, never over a Cancelled / Hold / other team status;
 *     delivery (OFD / Delivered) stays manual;
 *   - RTS date, dispatch date and the invoice (number, date, value) are filled only when still empty (a person's value
 *     is kept).
 */

export const PO_UNIWARE_SYNC = {
  /** MySQL lock: one server runs a pass at a time (not the D2C lock: the two syncs are independent). */
  LOCK: 'po-uniware-sync',
  JOB: 'po-uniware-sync',
  /** app_state key of the last run (shown as "synced N min ago"). */
  STATE_KEY: 'po-uniware:sync',
  /** Minutes between timed runs, and the first one after a server start. */
  EVERY_MIN: 30,
  FIRST_DELAY_MS: 120_000,
  /** A timed run skips POs read less than (EVERY_MIN - this) minutes ago. */
  FRESH_SLACK_MIN: 2,
  MAX_DELAY_MIN: 120,
  /** The API user is shared with in-transit and D2C: gentle (as D2C_SYNC). */
  CONCURRENCY: 2,
  CALL_GAP_MS: 500,
  MAX_PER_RUN: 500,
  /** A manual "Sync now" for picked POs. */
  MANUAL_MAX_IDS: 200,
  ROUTES: { SYNC: '/uniware-sync' },
} as const;

/** master_purchase_orders.uniwareStatus when Uniware does not know the sale order code (not uploaded yet). */
export const UNIWARE_NOT_FOUND = 'Not in Uniware yet';

/** Status (Warehouse) values Uniware may set, in order: it only ever moves a PO to a later one. */
export const UNIWARE_WAREHOUSE_LADDER = ['Confirmed', 'Picking', 'Packed', 'Label Pending', 'RTS', 'Dispatched'] as const;
/** Status (Planning) values that let Uniware move the statuses (anything else, e.g. Hold / Cancelled: the team decides). */
export const UNIWARE_PLANNING_OPEN: readonly string[] = ['Confirmed'];
/** Status (Logistics) values Uniware may move to Dispatched. */
export const UNIWARE_LOGISTICS_OPEN: readonly string[] = ['Confirmed'];
export const UNIWARE_DISPATCHED = 'Dispatched';

/** Uniware shipping package statuses -> the warehouse step they mean. */
export const UNIWARE_PACKAGE_STEP: Record<string, (typeof UNIWARE_WAREHOUSE_LADDER)[number]> = {
  CREATED: 'Picking', PICKING: 'Picking', PICKED: 'Picking', PACKED: 'Packed',
  READY_TO_SHIP: 'RTS', MANIFESTED: 'RTS',
  DISPATCHED: 'Dispatched', SHIPPED: 'Dispatched', DELIVERED: 'Dispatched', RETURN_EXPECTED: 'Dispatched', RETURNED: 'Dispatched',
};
/** Sale order statuses after which nothing more happens in Uniware: the PO is not read again. */
export const UNIWARE_SO_DONE: readonly string[] = ['COMPLETE', 'CANCELLED'];
