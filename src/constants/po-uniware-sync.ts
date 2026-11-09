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
  /**
   * Lighter runs (2026-11-06; the first runs read 500 POs in 481 s with 2,016 queries, 401 of them "Not in Uniware yet"):
   * a PO not in Uniware yet is asked again only every NOT_FOUND_EVERY_MIN minutes (a timed run; Sync now reads it);
   * an answer that changes nothing is not written PO by PO: their lastSyncedAt is set TOUCH_CHUNK at a time at the end.
   */
  NOT_FOUND_EVERY_MIN: 120,
  TOUCH_CHUNK: 500,
  /**
   * Nothing missed, fewer calls (2026-11-09, user: "optimize and don't miss anything from Uniware"):
   *   - a PO not in Uniware yet is asked less often as it gets older (age = createdAt): NOT_FOUND_EVERY_MIN up to
   *     NOT_FOUND_YOUNG_DAYS, then NOT_FOUND_MID_EVERY_MIN up to NOT_FOUND_OLD_DAYS, then NOT_FOUND_OLD_EVERY_MIN;
   *   - a PO marked uploaded (or created by us) after its last read is read on the next run, whatever its age;
   *   - still not in Uniware UPLOADED_MISSING_HOURS after the upload mark: uniwareStatus UNIWARE_UPLOADED_MISSING;
   *   - done = Uniware's own answer (COMPLETE / CANCELLED / everything dispatched), never a status a person typed:
   *     uniwareDoneAt; then read once every AFTER_DONE_EVERY_MIN for AFTER_DONE_DAYS (returns, late changes), History
   *     shows Uniware's new status text; never again after that.
   */
  NOT_FOUND_YOUNG_DAYS: 2,
  NOT_FOUND_MID_EVERY_MIN: 360,
  NOT_FOUND_OLD_DAYS: 15,
  NOT_FOUND_OLD_EVERY_MIN: 1440,
  UPLOADED_MISSING_HOURS: 6,
  AFTER_DONE_EVERY_MIN: 1440,
  AFTER_DONE_DAYS: 15,
  /**
   * The "Sync from Uniware" button (2026-11-09, user): one click per BUTTON_EVERY_MIN for the whole team (counted from the
   * last click, kept under BUTTON_STATE_KEY); a click reads only what can move: POs in Uniware and not finished (not read
   * in the last BUTTON_FRESH_MIN), POs marked uploaded that Uniware did not have yet, never-read downloaded ones.
   * Never asked (button or timer): a PO whose sale order CSV was never downloaded and that is not marked uploaded and
   * not known to Uniware: it cannot be in Uniware. Found in Uniware but not marked uploaded: marked by the sync
   * (FOUND_REMARK), unless a person removed the mark before.
   */
  BUTTON_EVERY_MIN: 30,
  BUTTON_FRESH_MIN: 5,
  BUTTON_STATE_KEY: 'po-uniware:button',
  FOUND_REMARK: 'found in Uniware by the sync',
  /** Our own Uniware client (uniware-client.ts): saleorder/get (lower case: the camelCase path answers 404). */
  GET_SO: '/services/rest/v1/oms/saleorder/get',
  /** get of a code Uniware does not have (code 40005) = not uploaded yet. */
  INVALID_SALE_ORDER_CODE: 'INVALID_SALE_ORDER_CODE',
  HTTP_TIMEOUT_MS: 60_000,
  RETRIES_ON_429: 7,
  ROUTES: { SYNC: '/uniware-sync' },
} as const;

/** master_purchase_orders.uniwareStatus when Uniware does not know the sale order code (not uploaded yet). */
export const UNIWARE_NOT_FOUND = 'Not in Uniware yet';
/** uniwareStatus of a PO marked uploaded (or created by us) that Uniware still does not have after UPLOADED_MISSING_HOURS. */
export const UNIWARE_UPLOADED_MISSING = 'Marked uploaded, not in Uniware';

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
