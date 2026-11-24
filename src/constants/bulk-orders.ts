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

/** The kinds of bulk order (stored value). */
export const BULK_ORDER_TYPE = {
  MARKETING: 'marketing',
  /** Head office (office use; Bulk Orders Portal v2, 2026-11-23): works exactly like Marketing (MARKETING_LIKE_TYPES). */
  HEAD_OFFICE: 'head_office',
  INSTITUTIONAL: 'institutional',
} as const;
export type BulkOrderType = (typeof BULK_ORDER_TYPE)[keyof typeof BULK_ORDER_TYPE];
export const BULK_ORDER_TYPES = Object.values(BULK_ORDER_TYPE) as BulkOrderType[];

/**
 * Types that behave like Marketing (user 2026-11-23: "if it works like marketing then build like marketing"): same
 * people (the Marketing page / role raises both), same approvers, fixed unit price (no amounts on the portal), delivery
 * mode, no institution details, no payment check, the saved PO in channel "Bulk Marketing" (group Marketing). A rule
 * written for Marketing uses isMarketingLike() so it covers Head office too.
 */
export const MARKETING_LIKE_TYPES: readonly BulkOrderType[] = [BULK_ORDER_TYPE.MARKETING, BULK_ORDER_TYPE.HEAD_OFFICE];
export const isMarketingLike = (type: string | null | undefined): boolean => MARKETING_LIKE_TYPES.includes(type as BulkOrderType);

/** PO number prefix per type: MKT-2026-0001, HO-2026-0001, INST-2026-0001. */
export const BULK_PO_PREFIX: Record<BulkOrderType, string> = {
  [BULK_ORDER_TYPE.MARKETING]: 'MKT',
  [BULK_ORDER_TYPE.HEAD_OFFICE]: 'HO',
  [BULK_ORDER_TYPE.INSTITUTIONAL]: 'INST',
};

/** Page keys (constants/auth.ts PAGES) that decide access. */
export const BULK_PAGE = {
  ROOT: '/bulk-orders',
  MARKETING: '/bulk-orders/marketing',
  INSTITUTIONAL: '/bulk-orders/institutional',
  APPROVE: '/bulk-orders/approve',
} as const;

/** The page that gives access to a type's orders (Head office = the Marketing page: the same people, user 2026-11-23). */
export const BULK_TYPE_PAGE: Record<BulkOrderType, string> = {
  [BULK_ORDER_TYPE.MARKETING]: BULK_PAGE.MARKETING,
  [BULK_ORDER_TYPE.HEAD_OFFICE]: BULK_PAGE.MARKETING,
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
  /**
   * v2 1c (2026-11-23): with our team, no approval needed (BULK_APPROVAL). Editable / cancellable by its type until the
   * sale order is made, like a pending one; processed like an approved one.
   */
  SUBMITTED: 'submitted',
  /**
   * v2 1g (2026-11-24, user "1G A"): saved before submitting, in the app (only its creator sees it), number DRAFT-<id>,
   * fields may be empty; Submit checks everything, applies the approval rules and gives it its real number.
   */
  DRAFT: 'draft',
  /** v2 piece 4 (2026-11-24): set from Uniware's shipping packages by the sync (never by hand; bulk-tracking.service). */
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
} as const;
export type BulkOrderStatus = (typeof BULK_ORDER_STATUS)[keyof typeof BULK_ORDER_STATUS];
export const BULK_ORDER_STATUSES = Object.values(BULK_ORDER_STATUS) as BulkOrderStatus[];

/** Statuses whose order our team may turn into a sale order (approved, or submitted = no approval needed). */
export const BULK_PROCESSABLE_STATUSES: readonly string[] = [BULK_ORDER_STATUS.APPROVED, BULK_ORDER_STATUS.SUBMITTED];
/** List filter `status=ready` (v2 1c): every order our team may process (BULK_PROCESSABLE_STATUSES), the team tab's default. */
export const BULK_LIST_READY = 'ready';
/** Statuses the requester may still edit / cancel (before approval, or before the sale order when none is needed). */
export const BULK_EDITABLE_STATUSES: readonly string[] = [BULK_ORDER_STATUS.PENDING_APPROVAL, BULK_ORDER_STATUS.SUBMITTED, BULK_ORDER_STATUS.DRAFT];
/**
 * Courier tracking (v2 piece 4, 2026-11-24, READ-ONLY on Uniware): the channel PO sync's saleorder/get answer fills a bulk
 * order's tracking. Package status words are Uniware's; cancelled packages are ignored.
 */
export const BULK_TRACKING = {
  DISPATCHED: ['DISPATCHED', 'SHIPPED', 'MANIFESTED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] as readonly string[],
  DELIVERED: ['DELIVERED'] as readonly string[],
  CANCELLED: ['CANCELLED'] as readonly string[],
  /** Orders the sync updates (placed, dispatched; delivered = final). */
  TRACKED_STATUSES: ['processing', 'dispatched'] as readonly string[],
  /** Timeline rows written by the sync (no person). */
  SYSTEM_USER: 0,
  TEXT_MAX: 255,
} as const;

/**
 * Notifications (v2 piece 3, 2026-11-24; modules/bulk-orders/bulk-notify.service.ts). Bell always (notices); email per
 * event behind switches (POST_FG Users & Roles > Settings > Bulk Orders > Notifications; app_state SETTINGS_KEY).
 * Remind: the requester nudges our team (COPT) REMIND_AFTER_H after the request (after the approval when one was
 * needed) while not placed, then at most every REMIND_COOLDOWN_H.
 */
export type BulkNotifyEvent = 'approval_needed' | 'approved' | 'rejected' | 'for_team' | 'remind';
export interface BulkNotifySettings { emails: boolean; approvalNeeded: boolean; decision: boolean; remind: boolean }
/** The settings' body fields (booleans). */
export const BULK_ORDERS_BODY_NOTIFY = ['emails', 'approvalNeeded', 'decision', 'remind'] as const;
export const BULK_NOTIFY = {
  SETTINGS_KEY: 'bulk-notify:settings',
  DEFAULTS: { emails: true, approvalNeeded: true, decision: true, remind: true } as BulkNotifySettings,
  /** Which switch sends an event's email (none = bell only: our team works in POST_FG all day). */
  EMAIL_SWITCH: { approval_needed: 'approvalNeeded', approved: 'decision', rejected: 'decision', for_team: null, remind: 'remind' } as Record<BulkNotifyEvent, 'approvalNeeded' | 'decision' | 'remind' | null>,
  APPROVER_ROLE: 'bulk-approver',
  /** POST_FG page of our team's Bulk Orders tab (the bell link + email link for COPT). */
  TEAM_LINK: '/operations/po-review?tab=bulk',
  REMIND_AFTER_H: 6,
  REMIND_COOLDOWN_H: 6,
  REMIND_STATUSES: ['submitted', 'approved'] as readonly string[],
  TEXT: {
    approval_needed: (po: string, units: number) => `Bulk order ${po} (${units} units) needs your approval in the Bulk Orders portal.`,
    approved: (po: string) => `Your bulk order ${po} was approved. Our team will place it.`,
    rejected: (po: string, _u: number, why: string) => `Your bulk order ${po} was rejected${why ? `: ${why}` : '.'}`,
    for_team: (po: string, units: number) => `New bulk order ${po} (${units} units) to place: Bulk Orders tab.`,
    remind: (po: string, units: number) => `Reminder: bulk order ${po} (${units} units) is still waiting to be placed.`,
  } as Record<BulkNotifyEvent, (po: string, units: number, extra: string) => string>,
  SUBJECT: {
    approval_needed: (po: string) => `Bulk order ${po} needs your approval`,
    approved: (po: string) => `Bulk order ${po} approved`,
    rejected: (po: string) => `Bulk order ${po} rejected`,
    for_team: (po: string) => `New bulk order ${po} to place`,
    remind: (po: string) => `Reminder: bulk order ${po} waiting to be placed`,
  } as Record<BulkNotifyEvent, (po: string) => string>,
} as const;

/** List filter `status=active` (v2 1g): open orders (submitted, pending approval, approved): the worklist's "Active" card. */
export const BULK_LIST_ACTIVE = 'active';
export const BULK_ACTIVE_STATUSES: readonly string[] = [BULK_ORDER_STATUS.SUBMITTED, BULK_ORDER_STATUS.PENDING_APPROVAL, BULK_ORDER_STATUS.APPROVED];
/**
 * Archive (v2 1g): closed orders (rejected, cancelled; delivered once tracking comes) not changed for DAYS leave the
 * normal lists; `archived=1` lists only them (search + CSV export in the portal).
 */
export const BULK_ARCHIVE = {
  DAYS: 30,
  STATUSES: ['rejected', 'cancelled', 'delivered'] as readonly string[],
  /** Draft numbers until Submit gives the real one (DRAFT-<id>). */
  DRAFT_PREFIX: 'DRAFT-',
} as const;

/**
 * Approval rules (Bulk Orders Portal v2 piece 1c, 2026-11-23; user: "go with the suggestions"). An order needs approval
 * when EITHER: its total units are MORE than its type's bulk_type_settings.approval_over_units (admin setting in POST_FG
 * Users & Roles > Settings > Bulk Orders; Marketing + Head office 100, Institutional NULL = never), OR its delivery mode is
 * in MODES (Marketing-like types only: Institutional has no mode). Otherwise SUBMITTED: straight to our team. Fast-track
 * alone never needs approval. Checked on create and again on every edit (an edit can move it either way).
 */
export const BULK_APPROVAL = {
  /** Default of a type's threshold (the migration seeds it; the admin changes it). */
  DEFAULT_OVER_UNITS: 100,
  /** Threshold limits on the settings form. */
  OVER_UNITS_MAX: 1_000_000,
  MODES: ['Porter'] as readonly string[],
  /** Why words on the timeline / API (approval.why). */
  WHY_UNITS: (units: number, over: number) => `${units} units (over ${over})`,
  WHY_MODE: (mode: string) => `${mode} delivery`,
} as const;

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
  /** v2 piece 3: the requester reminded our team to place it. */
  REMINDED: 'reminded',
  /** v2 piece 4: Uniware moved the order (changes: { status: [old, new], awb, courier }). */
  TRACKING: 'tracking',
  /** v2 1g: a draft was submitted (changes: { approval: why[] , poNumber }). */
  SUBMITTED: 'submitted',
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
export const BULK_PAYMENT_STATUSES = Object.values(BULK_PAYMENT_STATUS) as BulkPaymentStatus[];

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
/**
 * v2 1d (2026-11-23, user: "go with the suggestions"): modes Porter / Regular (Courier + Self pickup -> Regular, the
 * migration renames old orders), priority Normal / Fast-track (Standard -> Normal). Fast-track: remarks required (why it
 * is urgent) and a Needed by date; Normal: Needed by optional. Purpose: Marketing orders only (optional).
 */
export const BULK_DELIVERY_MODES = ['Porter', 'Regular'] as const;
export const BULK_PRIORITIES = ['Normal', 'Fast-track'] as const;
export const BULK_PRIORITY = { NORMAL: 'Normal', FAST_TRACK: 'Fast-track' } as const;

/**
 * Price of every unit of a Marketing / Head office order in Uniware (Bulk Orders Portal v2, user 2026-11-23: "keep this
 * 0.01 as a constant ... so we can change in future by taking the confirmation"; v1 was ₹1 from 2026-11-13). Not yet
 * confirmed that Uniware takes 0.01: if it refuses, change ONLY this value. The portal shows no amount on these orders
 * ("Free order"); our team sees this price in POST_FG and the Uniware CSV Selling Price = it.
 */
export const MARKETING_UNIT_PRICE = 0.01;

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
    /** v2 piece 3: email switches (before SETTING, which would take "notifications" as a type). */
    NOTIFY_SETTINGS: '/settings/notifications',
    SETTING: '/settings/:type',
    /** v2 piece 3: the requester nudges our team. */
    REMIND: '/:id/remind',
  },
  /** Lines per order. */
  LINES_MAX: 200,
  /** Units per line. */
  QTY_MAX: 1_000_000,
  /** Discount %: 0 up to BELOW this (2 decimals). v2 (2026-11-23): 100% is not allowed (a free line is not an order). */
  DISCOUNT_MAX: 100,
  /** v2 (2026-11-23): every line of a priced order (Institutional) must come to at least this many rupees. */
  LINE_TOTAL_MIN: 1,
  /**
   * Fixed price per unit by type (user 2026-11-13, Marketing: "don't show the amount, just put 1 rupee per SKU, one item,
   * same for everything, no discounts"): every unit at this price (with GST), no discount (a discount sent = 400), the
   * Uniware CSV Selling Price = this; the portal shows no money on these orders. A type not listed = MRP less discount %.
   */
  FIXED_UNIT_PRICE: { [BULK_ORDER_TYPE.MARKETING]: MARKETING_UNIT_PRICE, [BULK_ORDER_TYPE.HEAD_OFFICE]: MARKETING_UNIT_PRICE } as Partial<Record<BulkOrderType, number>>,
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
  /**
   * v2 1f (2026-11-24, user: "check the brand name from that column and show only one brand"): the brand = the PEP SKU
   * master's brand_name, as it is (no guessing from the code), compared without case; empty / "0" = no brand (such a SKU
   * is offered under no brand until the masters team fills it). One brand per order.
   */
  NO_BRAND: ['', '0'] as readonly string[],
  BRAND_MAX: 100,
  /** v2 1e: an edit's remark. */
  EDIT_REMARK_MAX: 500,
  /** v2 1d: Fast-track remarks + Marketing purpose (= their columns). */
  FAST_TRACK_REMARKS_MAX: 500,
  PURPOSE_MAX: 200,
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
    /** Payment check by our team (2026-11-13; CAPABILITY.BULK_PAYMENT_VERIFY). */
    PAYMENT: '/:id/payment',
    /** "Don't suggest again" on a saved address of the customer book (2026-11-13). */
    CUSTOMER_HIDE: '/customers/:customerId/hide',
  },
} as const;

/**
 * Step 3b, processing an approved order into a sale order (user 2026-11-12). Institutional first; Marketing 2026-11-13 the
 * same way (user: Uniware channel (e.g. Jiva) + customer code typed for now, auto-filled later), every unit at MARKETING_UNIT_PRICE (₹1 then; ₹0.01 since v2 2026-11-23)
 * (BULK_ORDERS.FIXED_UNIT_PRICE).
 *   - Our team member types the warehouse (facility), the Uniware channel and the Uniware customer code (both change
 *     often: he creates the customer in Uniware himself and types the code; POST_FG never creates customers).
 *   - Customer book = ADDRESS BOOK (bulk_customers; 2026-11-13, user: "save the addresses so we can suggest the customer
 *     code if the same address came before"): one row per order type + delivery address + Uniware channel + customer
 *     code (a Uniware customer code holds one address). Every processed order (Marketing + Institutional) adds its row or
 *     counts one more use of it; nothing is overwritten (same address + a NEW code = a new row, newest suggested first).
 *     Suggested on a later order of the same type: same delivery address first (the panel FILLS channel + code, the
 *     person ticks "checked" before creating), then same GSTIN, then same name + pincode. "Don't suggest again" hides a
 *     row (hidden_at; never deleted); typing that code for that address again shows it again.
 *   - The sale order is a normal saved PO: master / details_purchase_orders + erp_ code + Uniware CSV (Selling Price =
 *     the approved price, MRP less discount %, with GST) + a po_uploads row (source bulk) -> Processed tab, Uniware
 *     hand-off, PO Overview. NO Verify step (user: typed by hand, no OCR): the CSV is unlocked at once. Payment never
 *     blocks it (user).
 *   - The (optional) Verify panel's "Send back" undoes a wrong one: that sale order cancelled (kept, Inactive), the order
 *     approved again.
 */
export const BULK_SALE = {
  /** Order types our team can process now (Institutional 2026-11-12, Marketing 2026-11-13). */
  TYPES: [BULK_ORDER_TYPE.INSTITUTIONAL, BULK_ORDER_TYPE.MARKETING, BULK_ORDER_TYPE.HEAD_OFFICE] as BulkOrderType[],
  /** Types whose processed address + code goes into the customer book (bulk_customers): both since 2026-11-13 (user). */
  CUSTOMER_BOOK_TYPES: [BULK_ORDER_TYPE.INSTITUTIONAL, BULK_ORDER_TYPE.MARKETING, BULK_ORDER_TYPE.HEAD_OFFICE] as BulkOrderType[],
  /** po_uploads.source_system; external_id = the saved PO's number (SALE_PO). */
  SOURCE_SYSTEM: 'bulk_orders',
  /**
   * The saved PO's number of the n-th sale order of an order: INST-2026-0001, then INST-2026-0001-2 after a send back
   * (the cancelled one stays, and channel + PO number is unique on master_purchase_orders).
   */
  SALE_PO: (poNumber: string, n: number) => (n <= 1 ? poNumber : `${poNumber}-${n}`),
  /** master_purchase_orders.channel / po_uploads.channel (our name; the Uniware channel is typed per order). */
  /** Head office shares Marketing's channel (and so group Marketing in PO Overview; user 2026-11-23). */
  CHANNEL: {
    [BULK_ORDER_TYPE.MARKETING]: 'Bulk Marketing', [BULK_ORDER_TYPE.HEAD_OFFICE]: 'Bulk Marketing', [BULK_ORDER_TYPE.INSTITUTIONAL]: 'Bulk Institutional',
  } as Record<BulkOrderType, string>,
  /**
   * master_channels ids of those two names (migration BulkOrderProcessing, switched OFF): there only for the saved PO's
   * channel FK; the Masters pages / forms leave them out (not a channel the masters team keeps).
   */
  CHANNEL_IDS: [9101, 9102] as number[],
  /** processed.json channel_name. */
  CHANNEL_NAME: {
    [BULK_ORDER_TYPE.MARKETING]: 'bulk_marketing', [BULK_ORDER_TYPE.HEAD_OFFICE]: 'bulk_marketing', [BULK_ORDER_TYPE.INSTITUTIONAL]: 'bulk_institutional',
  } as Record<BulkOrderType, string>,
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
  /** Shown as "Special instructions" (v2 1d; the field keeps its name). */
  NOTE: 'note',
  /** v2 1d. */
  FAST_TRACK_REMARKS: 'fastTrackRemarks',
  PURPOSE: 'purpose',
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
  /** v2 1e (2026-11-23): why the requester changes the order (required on every edit). */
  EDIT_REMARK: 'remark',
  /** v2 1g: true = save as a draft (empty fields allowed); left out on Submit. */
  DRAFT: 'draft',
  /** v2 1g list filter: 1 = only the archive. */
  ARCHIVED: 'archived',
  /** v2 1f: the order's brand (one per order; every line's SKU must be of it). */
  BRAND: 'brand',
  LINE_NO: 'lineNo',
  REMOVE_LINES: 'removeLines',
  KIND: 'kind',
  ACTION: 'action',
  PAYMENT_CHECK: 'paymentCheck',
  /** v2 1c: settings, the units threshold (null = never by units). */
  APPROVAL_OVER_UNITS: 'approvalOverUnits',
  INSTITUTION: 'institutionName',
  GSTIN: 'gstin',
  EMAIL: 'contactEmail',
  BILLING: 'billingAddress',
  BILLING_SAME: 'billingSameAsDelivery',
  FACILITY: 'facilityCode',
  UNIWARE_CHANNEL: 'uniwareChannel',
  CUSTOMER_CODE: 'customerCode',
} as const;
