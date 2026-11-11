/*
 * Bulk Orders portal (2026-11-11, user; requirements in PROJECT_HISTORY "Bulk Orders portal requirements", design in
 * figma-make-bulk-orders/). Marketing and Institutional people order stock in bulk for shops (NOT channels: no channel
 * masters are used) from their OWN frontend (POST_FG_FE `npm run dev:bulk`), same backend, same Google login.
 *   - Who may do what = page access (as every POST_FG page): editor on BULK_PAGE.MARKETING creates Marketing orders, on
 *     BULK_PAGE.INSTITUTIONAL Institutional ones; viewer sees that type's orders; BULK_PAGE.APPROVE = approvals (step 2).
 *     Three fixed roles give them (ROLE_CATALOG: bulk-marketing, bulk-institutional, bulk-approver), nothing else, so
 *     these people open no POST_FG page and the backend refuses every POST_FG API for them.
 *   - Price = the SKU's MRP from our PEP SKU master (read on the server, never taken from the request) less the
 *     requester's discount % per SKU; no margins, no discount limit (user). MRP, discount and price are kept on the
 *     line as they were at ordering (a later MRP change never changes an order).
 *   - PO number MKT-2026-0001 / INST-2026-0001: taken from bulk_order_counters in the SAME transaction as the order
 *     (one atomic UPDATE per type + year), plus a unique key on bulk_orders.po_number (user: "100% unique").
 *   - Locations: typed once in the order form, optionally saved (bulk_locations, per type) and picked next time.
 * Step 1 (this): create + list + one order + SKU search + locations. Later: approval (approver may change discount /
 * qty, the requested values stay on the line), POST_FG Bulk orders section + hand-off to sale order / CSV, proof of
 * payment, timeline, M1 (Uniware customer code).
 */

/** The two kinds of bulk order (stored value). */
export const BULK_ORDER_TYPE = {
  MARKETING: 'marketing',
  INSTITUTIONAL: 'institutional',
} as const;
export type BulkOrderType = (typeof BULK_ORDER_TYPE)[keyof typeof BULK_ORDER_TYPE];
export const BULK_ORDER_TYPES = Object.values(BULK_ORDER_TYPE) as BulkOrderType[];

/** PO number prefix per type: MKT-2026-0001. */
export const BULK_PO_PREFIX: Record<BulkOrderType, string> = {
  [BULK_ORDER_TYPE.MARKETING]: 'MKT',
  [BULK_ORDER_TYPE.INSTITUTIONAL]: 'INST',
};

/** Page keys (constants/auth.ts PAGES) that decide access. */
export const BULK_PAGE = {
  ROOT: '/bulk-orders',
  MARKETING: '/bulk-orders/marketing',
  INSTITUTIONAL: '/bulk-orders/institutional',
  APPROVE: '/bulk-orders/approve',
} as const;

/** The page that gives access to a type's orders. */
export const BULK_TYPE_PAGE: Record<BulkOrderType, string> = {
  [BULK_ORDER_TYPE.MARKETING]: BULK_PAGE.MARKETING,
  [BULK_ORDER_TYPE.INSTITUTIONAL]: BULK_PAGE.INSTITUTIONAL,
};

/**
 * Order status. pending_approval: may be edited / cancelled by its type's people (user 2026-11-11) and approved /
 * rejected by an approver; the other three are final (later steps add processing -> dispatch after approved).
 */
export const BULK_ORDER_STATUS = {
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
} as const;
export type BulkOrderStatus = (typeof BULK_ORDER_STATUS)[keyof typeof BULK_ORDER_STATUS];
export const BULK_ORDER_STATUSES = Object.values(BULK_ORDER_STATUS) as BulkOrderStatus[];

/** Timeline rows (bulk_order_events.action), one per change of an order, in the same transaction as the change. */
export const BULK_EVENT = {
  CREATED: 'created',
  EDITED: 'edited',
  CANCELLED: 'cancelled',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type BulkEventAction = (typeof BULK_EVENT)[keyof typeof BULK_EVENT];

/** The design's markers (figma-make-bulk-orders types.ts): delivery mode (Marketing only) and priority. */
export const BULK_DELIVERY_MODES = ['Porter', 'Courier', 'Self pickup'] as const;
export const BULK_PRIORITIES = ['Standard', 'Fast-track'] as const;

export const BULK_ORDERS = {
  BASE: '/bulk-orders',
  ROUTES: {
    LIST: '/',
    CREATE: '/',
    SKUS: '/skus',
    LOCATIONS: '/locations',
    ONE: '/:id',
    EDIT: '/:id',
    CANCEL: '/:id/cancel',
    APPROVE: '/:id/approve',
    REJECT: '/:id/reject',
  },
  /** Lines per order. */
  LINES_MAX: 200,
  /** Units per line. */
  QTY_MAX: 1_000_000,
  /** Discount % (0-100, 2 decimals). No business limit (user): only what makes sense. */
  DISCOUNT_MAX: 100,
  /** SKU search: at least this many characters, at most this many answers. */
  SKU_QUERY_MIN: 2,
  SKU_RESULTS_MAX: 20,
  /** Orders per page of the list. */
  PAGE_SIZE: 50,
  PAGE_SIZE_MAX: 200,
  /** Saved locations per type returned (newest first). */
  LOCATIONS_MAX: 500,
  /** Text limits (= the columns). */
  NAME_MAX: 150,
  LABEL_MAX: 100,
  ADDRESS_MAX: 500,
  CITY_MAX: 100,
  NOTE_MAX: 1000,
  /** 10 digits after spaces / dashes and a +91 or leading 0 are removed. */
  PHONE_RE: /^\d{10}$/,
  PINCODE_RE: /^[1-9]\d{5}$/,
  /** Serial width in the PO number (MKT-2026-0001); more orders simply get more digits. */
  SERIAL_DIGITS: 4,
} as const;

/** Our team's read-only view in PO Processing & Review > Bulk Orders (step 3a; PO review page access). */
export const BULK_ORDERS_TEAM = {
  BASE: '/po-review/bulk-orders',
  ROUTES: { LIST: '/', ONE: '/:id' },
} as const;

/** Request body fields (also the `field` of a VALIDATION_FAILED detail). */
export const BULK_BODY = {
  TYPE: 'type',
  ORDERED_BY: 'orderedBy',
  RECEIVER_NAME: 'receiverName',
  RECEIVER_PHONE: 'receiverPhone',
  LOCATION_ID: 'locationId',
  ADDRESS: 'address',
  SAVE_LOCATION_AS: 'saveLocationAs',
  NEEDED_BY: 'neededBy',
  MODE: 'mode',
  PRIORITY: 'priority',
  NOTE: 'note',
  LINES: 'lines',
  LABEL: 'label',
  PEP_CODE: 'pepCode',
  QTY: 'qty',
  DISCOUNT: 'discountPct',
  LINE: 'line',
  CITY: 'city',
  STATE: 'state',
  PINCODE: 'pincode',
  REASON: 'reason',
  LINE_NO: 'lineNo',
  REMOVE_LINES: 'removeLines',
} as const;
