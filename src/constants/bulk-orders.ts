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
  /** Step 3b (2026-11-12): our team created its sale order in POST_FG (PO rows + erp_ code + Uniware CSV). */
  PROCESSING: 'processing',
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
  /** A document uploaded (changes: { kind, fileName, replaced? }). */
  DOCUMENT_ADDED: 'document_added',
  /** The payment check changed (changes: { status: [old, new] }). */
  PAYMENT: 'payment',
  /** Our team created the sale order (changes: { saleOrderCode, facilityCode, uniwareChannel, customerCode, uploadId }). */
  PROCESSED: 'processed',
  /** The Verify step sent the sale order back (cancelled, kept): the order is approved again, to be processed again. */
  SENT_BACK: 'sent_back',
} as const;
export type BulkEventAction = (typeof BULK_EVENT)[keyof typeof BULK_EVENT];

/**
 * Payment check (user 2026-11-12). Per order type a setting (bulk_type_settings.payment_check, admin ON / OFF; now ON for
 * Institutional only): ON = the order gets a payment status at creation (awaiting_proof); OFF = none (NULL, no payment
 * line). Payment NEVER blocks approval or processing; the proof may come any time; the APPROVER validates it.
 * A setting change applies to orders created after it.
 */
export const BULK_PAYMENT_STATUS = {
  AWAITING_PROOF: 'awaiting_proof',
  PROOF_UPLOADED: 'proof_uploaded',
  VERIFIED: 'verified',
  REFUSED: 'refused',
  NOT_NEEDED: 'not_needed',
} as const;
export type BulkPaymentStatus = (typeof BULK_PAYMENT_STATUS)[keyof typeof BULK_PAYMENT_STATUS];

/** What the approver does on POST /bulk-orders/:id/payment -> the new payment status. */
export const BULK_PAYMENT_ACTION = {
  VERIFY: 'verify',
  REFUSE: 'refuse',
  NOT_NEEDED: 'not_needed',
} as const;
export type BulkPaymentAction = (typeof BULK_PAYMENT_ACTION)[keyof typeof BULK_PAYMENT_ACTION];
export const BULK_PAYMENT_ACTIONS = Object.values(BULK_PAYMENT_ACTION) as BulkPaymentAction[];

/** Documents on an order (bulk_order_documents.kind). A new one of a kind marks the older ones of that kind replaced. */
export const BULK_DOC_KIND = {
  PROFORMA_INVOICE: 'proforma_invoice',
  INVOICE: 'invoice',
  PAYMENT_PROOF: 'payment_proof',
} as const;
export type BulkDocKind = (typeof BULK_DOC_KIND)[keyof typeof BULK_DOC_KIND];
export const BULK_DOC_KINDS = Object.values(BULK_DOC_KIND) as BulkDocKind[];

export const BULK_DOCS = {
  /** One file per upload, multipart field name. */
  FIELD_FILE: 'file',
  MAX_BYTES: 10 * 1024 * 1024,
  /** S3: bulk-orders/<PO number>/<uuid>.<ext> */
  S3_FOLDER: 'bulk-orders',
} as const;

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
    DOCUMENTS: '/:id/documents',
    DOCUMENT: '/:id/documents/:docId',
    PAYMENT: '/:id/payment',
    /** Per-type settings (admin: editor on BULK_PAGE.ROOT). Before '/:id' in the router. */
    SETTINGS: '/settings',
    SETTING: '/settings/:type',
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

/** Our team's view in PO Processing & Review > Bulk Orders (step 3a read; 3b process = PO review EDITOR). */
export const BULK_ORDERS_TEAM = {
  BASE: '/po-review/bulk-orders',
  ROUTES: {
    LIST: '/', ONE: '/:id', DOCUMENTS: '/:id/documents', DOCUMENT: '/:id/documents/:docId',
    PROCESS_OPTIONS: '/:id/process-options', PROCESS: '/:id/process',
  },
} as const;

/**
 * Step 3b, processing an approved order into a sale order (user 2026-11-12). Institutional first, Marketing next.
 *   - Our team member types the warehouse (facility), the Uniware channel and the Uniware customer code (both change
 *     often: he creates the customer in Uniware himself and types the code; POST_FG never creates customers).
 *   - Customer book (bulk_customers): every processed order saves / updates its customer (the requester's institution
 *     name, GSTIN, billing address + the typed channel / code); a later order with the same GSTIN, or the same name +
 *     billing pincode, gets them suggested.
 *   - The sale order is a normal saved PO: master / details_purchase_orders + erp_ code + Uniware CSV (Selling Price =
 *     the approved price, MRP less discount %, with GST) + a po_uploads row (source bulk) -> Processed tab, Uniware
 *     hand-off, PO Overview. NO Verify step (user: typed by hand, no OCR): the CSV is unlocked at once. Payment never
 *     blocks it (user).
 *   - The (optional) Verify panel's "Send back" undoes a wrong one: that sale order cancelled (kept, Inactive), the order
 *     approved again.
 */
export const BULK_SALE = {
  /** Order types our team can process now (Marketing next, user). */
  TYPES: [BULK_ORDER_TYPE.INSTITUTIONAL] as BulkOrderType[],
  /** po_uploads.source_system; external_id = the saved PO's number (SALE_PO). */
  SOURCE_SYSTEM: 'bulk_orders',
  /**
   * The saved PO's number of the n-th sale order of an order: INST-2026-0001, then INST-2026-0001-2 after a send back
   * (the cancelled one stays, and channel + PO number is unique on master_purchase_orders).
   */
  SALE_PO: (poNumber: string, n: number) => (n <= 1 ? poNumber : `${poNumber}-${n}`),
  /** master_purchase_orders.channel / po_uploads.channel (our name; the Uniware channel is typed per order). */
  CHANNEL: { [BULK_ORDER_TYPE.MARKETING]: 'Bulk Marketing', [BULK_ORDER_TYPE.INSTITUTIONAL]: 'Bulk Institutional' } as Record<BulkOrderType, string>,
  /**
   * master_channels ids of those two names (migration BulkOrderProcessing, switched OFF): there only for the saved PO's
   * channel FK; the Masters pages / forms leave them out (not a channel the masters team keeps).
   */
  CHANNEL_IDS: [9101, 9102] as number[],
  /** processed.json channel_name. */
  CHANNEL_NAME: { [BULK_ORDER_TYPE.MARKETING]: 'bulk_marketing', [BULK_ORDER_TYPE.INSTITUTIONAL]: 'bulk_institutional' } as Record<BulkOrderType, string>,
  /** S3: bulk-orders/<PO number>/sale-order-<n>/ (order.json = the "PO file", processed.json, the Uniware CSV). */
  S3_SUB: (n: number) => `sale-order-${n}`,
  ORDER_FILE: 'order.json',
  CODE_MAX: 100,
  CUSTOMERS_MAX: 5,
  FACILITIES_MAX: 500,
} as const;

/** Institutional requester details (portal; user 2026-11-12: "name and all details are from the requester only"). */
export const BULK_INSTITUTION = {
  NAME_MAX: 200,
  EMAIL_MAX: 150,
  /** 15 characters: 2-digit state, PAN (5 letters, 4 digits, 1 letter), entity, Z, check. */
  GSTIN_RE: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
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
  KIND: 'kind',
  ACTION: 'action',
  PAYMENT_CHECK: 'paymentCheck',
  INSTITUTION: 'institutionName',
  GSTIN: 'gstin',
  EMAIL: 'contactEmail',
  BILLING: 'billingAddress',
  BILLING_SAME: 'billingSameAsDelivery',
  FACILITY: 'facilityCode',
  UNIWARE_CHANNEL: 'uniwareChannel',
  CUSTOMER_CODE: 'customerCode',
} as const;
