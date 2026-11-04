/*
 * D2C internal transfers (2026-11-03; plan d2c-internal-transfers v3 + the user's answers appended to it): stock moved
 * between our own warehouses through Uniware (sale order at the dispatch facility -> invoice -> inward PO at the
 * receiving facility -> GRN). A transfer is a master_purchase_orders row with transferCode NOT NULL; its invoices are
 * po_invoices rows. Transfers are NOT shown on PO Overview (user, 2026-11-02).
 */

/** Transfer types (d2c:settings.types starts with these) and the tag each puts before the serial in the reference ID. */
export const D2C_TRANSFER_TYPE = { REGULAR: 'Regular', INTERNAL: 'Internal', FREEBEE: 'Freebee' } as const;
export const D2C_REFERENCE_TAG: Record<string, string> = {
  [D2C_TRANSFER_TYPE.REGULAR]: '',
  [D2C_TRANSFER_TYPE.INTERNAL]: 'Int',
  [D2C_TRANSFER_TYPE.FREEBEE]: 'Freebee',
};

export const D2C_PRIORITIES = ['P1', 'P2', 'P3'] as const;

/** The 5 transfer channels as PEPIMS names them (d2c:settings.channels starts with these). */
export const D2C_CHANNELS = ['McaffeineB2C', 'HYP_Website', 'GGN_WAREHOUSE', 'MUM_WAREHOUSE2', 'KOL_WAREHOUSE'] as const;

/** master_purchase_orders.transferStage (plan 1.1). */
export const D2C_STAGE = {
  DRAFT: 'draft',
  SALE_ORDER: 'sale_order',
  PACKED: 'packed',
  READY_TO_SHIP: 'ready_to_ship',
  INVOICED: 'invoiced',
  PARTLY_DISPATCHED: 'partly_dispatched',
  DISPATCHED: 'dispatched',
  INWARD_PO_CREATED: 'inward_po_created',
  GRN: 'grn',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
} as const;
export type D2cStage = (typeof D2C_STAGE)[keyof typeof D2C_STAGE];

/** master_purchase_orders.soState and po_invoices.inward_po_state: a Uniware create request; null = not asked. */
export const D2C_REQUEST_STATE = { REQUESTED: 'requested', CREATED: 'created', FAILED: 'failed', UNKNOWN: 'unknown' } as const;
export type D2cRequestState = (typeof D2C_REQUEST_STATE)[keyof typeof D2C_REQUEST_STATE];

/**
 * master_purchase_orders.balanceClosedReason (user, 2026-11-03: nothing closes by itself on expiry, an expired transfer
 * is only flagged). The list is open: a varchar column, values only here.
 */
export const D2C_BALANCE_CLOSED_REASON = { CLOSE_SHORT: 'close_short', UNIWARE_CANCELLED: 'uniware_cancelled' } as const;

/** po_invoices.variance_reason */
export const D2C_VARIANCE_REASON = { SHORT_RECEIVED: 'short_received', DAMAGED: 'damaged', EXCESS: 'excess', OTHER: 'other' } as const;

/**
 * Prices sent to Uniware (user, 2026-11-03: today's practice, COGS is not used): SO price = 15% of MRP (tax included),
 * inward PO unit price = 1. GMV = MRP x qty, PO value = SO price x qty.
 */
export const D2C_PRICE = { SO_MRP_SHARE: 0.15, INWARD_PO_UNIT_PRICE: 1 } as const;

/** app_state rows of the feature (seeded by migration D2cTransfers1793800000000). */
export const D2C_STATE_KEY = {
  /** { byDate: { 'YYYY-MM-DD': n } }: reference ID serial per PO date. */
  REF_SERIAL: 'd2c:ref-serial',
  /** { month: '2627-11', last: n }: transfer code serial per month. */
  TRANSFER_CODE: 'd2c:transfer-code',
  /** { byDate: { 'YYYYMMDD': n } }: Uniware SO code serial per day (own counter, not sale_order_code_counter). */
  SO_SERIAL: 'd2c:so-serial',
  SETTINGS: 'd2c:settings',
  SYNC: 'd2c:sync',
  /** What the migration inserted (channels, permission rows), for its down(). */
  MIGRATION: 'd2c:migration',
} as const;

/** d2c:settings as the migration seeds it. live = false: no Uniware writes except for testFacilities. */
export const D2C_DEFAULT_SETTINGS = {
  types: Object.values(D2C_TRANSFER_TYPE) as string[],
  channels: [...D2C_CHANNELS] as string[],
  defaultExpiryDays: 15,
  soNotFoundHours: 24,
  syncMinutes: 30,
  live: false,
  testFacilities: ['TEST_FACILITY'],
  cutoverDate: null as string | null,
};

export const D2C_CODE = {
  TRANSFER_PREFIX: 'IT',
  /** Transfer code serial: at least 3 digits (grows to 4 past 999 in a month). */
  TRANSFER_SERIAL_DIGITS: 3,
  /** Uniware SO code: erp_it_<yyyymmdd><serial> (user, 2026-11-03). */
  SO_PREFIX: 'erp_it_',
  SO_SERIAL_DIGITS: 3,
} as const;

/** Month names of the reference ID (Nov). */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const ymd = (date: string): [number, number, number] => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** Indian financial year of a date (April to March) as 4 digits: 2026-11-05 -> '2627', 2027-03-31 -> '2627'. */
export const d2cFinancialYear = (date: string): string => {
  const [y, mo] = ymd(date);
  const start = mo >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
};

/** Key of the transfer code counter for a date: '2627-11'. */
export const d2cTransferMonth = (date: string): string => `${d2cFinancialYear(date)}-${String(ymd(date)[1]).padStart(2, '0')}`;

/** Transfer ID: IT-<FY>-<MM>-<NNN>, e.g. IT-2627-11-004. */
export const d2cTransferCode = (date: string, serial: number): string =>
  `${D2C_CODE.TRANSFER_PREFIX}-${d2cTransferMonth(date)}-${String(serial).padStart(D2C_CODE.TRANSFER_SERIAL_DIGITS, '0')}`;

/**
 * Reference ID (decision 2): <receiving facility code>|<DD><Mon><YYYY>|<tag><serial>, e.g. mCaff_Kolkata3|05Nov2026|Int13.
 * Date = PO date; serial not padded; the facility code exactly as master_facilities.code.
 */
export const d2cReferenceId = (facilityCode: string, poDate: string, type: string, serial: number): string => {
  const [y, mo, d] = ymd(poDate);
  return `${facilityCode}|${String(d).padStart(2, '0')}${MONTH_SHORT[mo - 1]}${y}|${D2C_REFERENCE_TAG[type] ?? ''}${serial}`;
};

/** Uniware SO code: erp_it_<yyyymmdd><NNN>, e.g. erp_it_20261103001. */
export const d2cSaleOrderCode = (date: string, serial: number): string =>
  `${D2C_CODE.SO_PREFIX}${date.replace(/-/g, '')}${String(serial).padStart(D2C_CODE.SO_SERIAL_DIGITS, '0')}`;

/** Inward PO code: <SO code>-<n>, n = the invoice's order within the transfer (1, 2 ...). */
export const d2cInwardPoCode = (soCode: string, n: number): string => `${soCode}-${n}`;

/** Masters edit (2026-11-03): master_facilities.allow_internal_transfer as the form shows it. */
export const D2C_ALLOW = { YES: 'Yes', NO: 'No' } as const;
/** Masters edit: length of the Uniware channel / customer / vendor code columns of d2c_transfer_routes. */
export const D2C_UNIWARE_CODE_MAX = 100;
/** Masters edit: length of details_channels.transfer_po_prefix. */
export const D2C_PO_PREFIX_MAX = 100;
/**
 * Masters edit form keys read only by D2C internal transfers (no PO check re-run after they change). The route's own
 * keys are not listed: a transfer route edit never re-checks POs (master-edit.service.ts).
 */
export const D2C_EDIT_KEYS = ['allowInternalTransfer', 'transferFacilityId', 'transferPoPrefix'] as const;

/*
 * Route codes (user's sheet "Need to add Vendor Code (1).xlsx", 2026-11-03; plan: "Updated route sheet", the sheet is
 * the truth, no manual fixes): the Uniware channel + customer depend on (sending facility, channel, location), the
 * vendor on (sending facility, receiving facility). A route may have 2+ Uniware channels (one row each). Loaded by
 * `npm run d2c:routes-load -- --file <xlsx>` into d2c_transfer_routes.
 * Sheet / column names: the first one found is used ("Updated Channel Code", else the older "Channel Code"; the vendor
 * sheet's receiving facility column is "Location", earlier "Facility").
 */
export const D2C_ROUTE_SHEET = {
  VENDOR: { names: ['Vendor Code'], sender: ['Sending Facility'], vendor: ['Vendor Code'], receiver: ['Location', 'Facility'] },
  CHANNEL: {
    names: ['Updated Channel Code', 'Channel Code'], uniwareChannel: ['Channel Type'], customerCode: ['Customer Code'], customerName: ['Customer Name'],
    channel: ['Channel'], location: ['Location'], sender: ['Facility'],
  },
} as const;

/**
 * Transfer location -> receiving facility code (user-approved mapping, 2026-11-03, point 4), per PEPIMS channel name.
 * Two names of the same place (Hyderabad / Hyderabad2 ...) are two locations with the same receiving facility.
 */
export const D2C_LOCATION_FACILITY: Record<string, Record<string, string>> = {
  McaffeineB2C: {
    Ahmedabad: 'mCaff_Ahmedabad', Bangalore2: 'mCaff_Bangalore2', Chennai: 'Mcaff_Chennai', DS_NCR_PD_MOTHERHUB: 'DS_NCR_PD_MOTHERHUB',
    DS_NCR_PD_OKHLAHUB_939: 'DS_NCR_PD_OKHLAHUB_939', Gurgaon3: 'mCaff_Gurgaon3', Guwahati: 'mCaff_Guwahati', 'Guwahati 2': 'mCaff_Guwahati2',
    Hyderabad: 'mCaff_Hyderabad2', Hyderabad2: 'mCaff_Hyderabad2', Hyderabad3: 'mCaff_Hyderabad3', Kolkata: 'mCaff_Kolkata2',
    Kolkata2: 'mCaff_Kolkata2', Kolkata3: 'mCaff_Kolkata3', Lucknow3: 'mCaff_Lucknow3', Mumbai2: 'mCaff_Mumbai2', Nagpur: 'Mcaff_Nagpur',
  },
  HYP_Website: {
    Ahmedabad: 'HYP_AHMD', Bangalore: 'HYP_SRBGLR', Chennai: 'HYP_SPCHN', Gurgaon: 'HYP_B2B_GGN', Gurgaon3: 'HYP_SRGGN', Guwahati: 'HYP_SRGWHT',
    'Guwahati 2': 'HYP_DLGWHT', Hyderabad: 'HYP_SRHYD', Hyderabad3: 'HYP_BYHYD', Kolkata: 'HYP_SRKOL', Lucknow: 'HYP_SRLOK2',
    Mumbai: 'HYP_B2B_MUM2', Mumbai2: 'mCaff_Mumbai2', Nagpur: 'HYP_DLNAG',
  },
  GGN_WAREHOUSE: { Gurgaon: 'GGN_WAREHOUSE' },
  MUM_WAREHOUSE2: { Mumbai: 'MUM_WAREHOUSE2' },
  KOL_WAREHOUSE: { Kolkata_MH: 'KOL_WAREHOUSE', Kolkata3: 'KOL_WAREHOUSE' },
};

/** PO number prefix of a transfer location: PEPIMS's PO_Format "PO Number" up to the first "|", over this many days. */
export const D2C_PO_PREFIX_DAYS = 90;

/*
 * Phase 3 (2026-11-03): create / read / edit transfers without Uniware (plan sections 1, 5.0-5.3, 8).
 */

/** master_purchase_orders status texts per stage (plan 1.5): written as plain values, no status master rows. */
export const D2C_STATUS_TEXT: Record<D2cStage, { planning: string; warehouse: string | null; logistics: string | null }> = {
  [D2C_STAGE.DRAFT]: { planning: 'Confirmed', warehouse: null, logistics: null },
  [D2C_STAGE.SALE_ORDER]: { planning: 'Confirmed', warehouse: 'Confirmed', logistics: null },
  [D2C_STAGE.PACKED]: { planning: 'Confirmed', warehouse: 'Packed', logistics: null },
  [D2C_STAGE.READY_TO_SHIP]: { planning: 'Confirmed', warehouse: 'RTS', logistics: null },
  [D2C_STAGE.INVOICED]: { planning: 'Confirmed', warehouse: 'RTS', logistics: null },
  [D2C_STAGE.PARTLY_DISPATCHED]: { planning: 'Confirmed', warehouse: 'Dispatched', logistics: 'Internal Transfer' },
  [D2C_STAGE.DISPATCHED]: { planning: 'Confirmed', warehouse: 'Dispatched', logistics: 'Internal Transfer' },
  [D2C_STAGE.INWARD_PO_CREATED]: { planning: 'Confirmed', warehouse: 'Dispatched', logistics: 'Internal Transfer' },
  [D2C_STAGE.GRN]: { planning: 'Confirmed', warehouse: 'Dispatched', logistics: 'Inward Done' },
  [D2C_STAGE.CLOSED]: { planning: 'Confirmed', warehouse: 'Dispatched', logistics: 'Inward Done' },
  [D2C_STAGE.CANCELLED]: { planning: 'Cancelled', warehouse: null, logistics: null },
};

/** Stages before anything left the dispatch warehouse ("open, not yet dispatched": the open-duplicate warning). */
export const D2C_UNDISPATCHED_STAGES: readonly string[] = [D2C_STAGE.DRAFT, D2C_STAGE.SALE_ORDER, D2C_STAGE.PACKED, D2C_STAGE.READY_TO_SHIP, D2C_STAGE.INVOICED];
/** Stages that end a transfer: no more expiry change. */
export const D2C_FINAL_STAGES: readonly string[] = [D2C_STAGE.CLOSED, D2C_STAGE.CANCELLED];

/** Sub-tabs of the page (plan 1.3): membership from facts, not from the stage alone. */
export const D2C_TAB = {
  DRAFT: 'draft',
  SALE_ORDERS: 'sale_orders',
  CREATE_INWARD_PO: 'create_inward_po',
  INWARD_POS: 'inward_pos',
  OVERVIEW: 'overview',
} as const;
export type D2cTab = (typeof D2C_TAB)[keyof typeof D2C_TAB];

/** Where a transfer came from: the source of its `created` log row. */
export const D2C_SOURCE = { SCREEN: 'screen', BULK_CSV: 'bulk_csv' } as const;

/** Source tags of the timeline (plan 2.4). */
export const D2C_SOURCE_TAG: Record<string, string> = {
  screen: 'TOOL', bulk_csv: 'TOOL', tool_api: 'TOOL · API', uniware: 'UNIWARE', system: 'SYSTEM',
};

/** Upload template (plan 5.1 + decision 1): PEPIMS's columns, then ours. */
export const D2C_UPLOAD_COLUMN = {
  CHANNEL: 'Channel',
  LOCATION: 'Location',
  PO_DATE: 'PO Date',
  PO_NUMBER: 'PO Number',
  SR_NO: 'Sr No',
  SKU_NAME: 'SKU Name',
  SKU_CODE: 'SKU Code',
  CHANNEL_SKU_CODE: 'Channel SKU Code',
  QTY: 'Qty',
  GMV: 'GMV',
  PO_VALUE: 'PO Value',
  DISPATCH_LOCATION: 'Dispatch Location',
  PRIORITY: 'Priority',
  GROUP: 'Group',
  TYPE: 'Type',
  PO_EXPIRY_DATE: 'PO Expiry Date',
  /** Optional: needed only when the route has 2+ Uniware channels (2026-11-03). */
  UNIWARE_CHANNEL: 'Uniware Channel',
} as const;
export const D2C_UPLOAD_COLUMNS: readonly string[] = Object.values(D2C_UPLOAD_COLUMN);
/** Columns a file must have (Priority, Type, expiry have defaults; PO Number, Sr No, GMV, PO Value, Channel SKU Code are ignored). */
export const D2C_UPLOAD_REQUIRED: readonly string[] = [
  D2C_UPLOAD_COLUMN.CHANNEL, D2C_UPLOAD_COLUMN.LOCATION, D2C_UPLOAD_COLUMN.PO_DATE, D2C_UPLOAD_COLUMN.SKU_CODE, D2C_UPLOAD_COLUMN.QTY,
  D2C_UPLOAD_COLUMN.DISPATCH_LOCATION,
];

export const D2C_LIMITS = {
  /** Upload: .csv only, at most 2 MB and 5,000 rows (PRD). */
  UPLOAD_MAX_BYTES: 2 * 1024 * 1024,
  UPLOAD_MAX_ROWS: 5000,
  /** Largest qty of one line (a sanity limit; PEPIMS's biggest transfer line is far below). */
  QTY_MAX: 10_000_000,
  REMARKS_MAX: 1000,
  REASON_MAX: 500,
  GROUP_MAX: 100,
  /** List paging, as PO Overview. */
  DEFAULT_PAGE_SIZE: 100,
  MAX_PAGE_SIZE: 500,
  /** Export: at most this many rows. */
  EXPORT_MAX_ROWS: 20_000,
  /** SKU picker: at most this many answers. */
  SKU_PICKER_MAX: 50,
  /** Timeline rows of the detail. */
  HISTORY_MAX: 500,
  /** d2c:ref-serial keeps this many days of counters. */
  REF_SERIAL_KEEP_DAYS: 60,
  /** PEPIMS's highest reference serial of a day is re-read on every take until cutoverDate + this many days (plan 2.7). */
  PEPIMS_REREAD_DAYS: 30,
} as const;

/** S3 folder of uploaded files (plan 2.9): d2c-transfers/uploads/<yyyy>/<mm>/<batchId>-<name>.csv */
export const D2C_S3_UPLOAD_FOLDER = 'd2c-transfers/uploads';
/** Upload form field of the file. */
export const D2C_UPLOAD_FIELD = 'file';
/** PEPIMS table read (read only) for the highest reference serial of a day. */
export const D2C_PEPIMS_SHIPMENT_ORDERS = 'shipment_orders';

/** Route paths under /d2c-transfers (plan 8). */
export const D2C_ROUTES = {
  BASE: '/d2c-transfers',
  LIST: '/',
  COUNTS: '/counts',
  EXPORT: '/export',
  OPTIONS: '/options',
  SKUS: '/skus',
  NEXT_REFERENCE: '/next-reference',
  TEMPLATE: '/template',
  EVENTS: '/events',
  CHANGES: '/changes',
  UPLOAD_PREVIEW: '/uploads/preview',
  UPLOAD_IMPORT: '/uploads/import',
  ONE: '/:id',
  ONE_EVENTS: '/:id/events',
  CANCEL: '/:id/cancel',
  EXPIRY: '/:id/expiry',
  /** Phase 5: Uniware sale orders. */
  STOCK_CHECK: '/stock-check',
  CREATE_SO: '/create-so',
  JOB: '/jobs/:jobId',
  CLOSE_SHORT: '/:id/close-short',
  /** Phase 6: the Uniware status sync. */
  SYNC: '/sync',
  SYNC_STATUS: '/sync-status',
  /** Phase 7: inward POs (one per dispatched invoice) + GRN + variance reason. */
  INVOICES: '/invoices',
  CREATE_INWARD_PO: '/create-inward-po',
  VARIANCE_REASON: '/invoices/:invoiceId/variance-reason',
} as const;

/** Query parameter names of the list / counts / export (multi-value filters repeat the parameter). */
export const D2C_QUERY = {
  TAB: 'tab',
  Q: 'q',
  STAGE: 'stage',
  PRIORITY: 'priority',
  SENDER: 'sender',
  RECEIVING: 'receiving',
  DATE_FROM: 'dateFrom',
  DATE_TO: 'dateTo',
  SOURCE: 'source',
  CHANNEL: 'channel',
  TYPE: 'type',
  EXPIRED: 'expired',
  PAGE: 'page',
  PAGE_SIZE: 'pageSize',
  LEVEL: 'level',
} as const;

export const D2C_EXPORT_LEVEL = { PO: 'po', SKU: 'sku' } as const;

/*
 * Phase 5 (2026-11-03): sale orders in Uniware (plan 4, 5.4, 5.6 + the SO write tests of 2026-11-03).
 */
export const D2C_UNIWARE = {
  CREATE_SO: '/services/rest/v1/oms/saleOrder/create',
  /** lower-case "saleorder": the camelCase path answers 404 (Phase 0). */
  GET_SO: '/services/rest/v1/oms/saleorder/get',
  CANCEL_SO: '/services/rest/v1/oms/saleOrder/cancel',
  STOCK: '/services/rest/v1/inventory/inventorySnapshot/get',
  SHIPPING_METHOD: 'STD',
  /** Refusal messages with a meaning of their own. */
  DUPLICATE_SALE_ORDER: 'DUPLICATE_SALE_ORDER',
  /** get of a code Uniware does not have (read-only probe 2026-11-03: code 40005). */
  INVALID_SALE_ORDER_CODE: 'INVALID_SALE_ORDER_CODE',
  /** stock of SKUs none of which has inventory at that facility (code 60004) = 0 available. */
  INVENTORY_NOT_AVAILABLE: 'INVENTORY_NOT_AVAILABLE',
  /** Item line code of a transfer line on the SO: L<details_purchase_orders.id> (stable, one item per line with its qty). */
  ITEM_CODE_PREFIX: 'L',
  /** Remark / log text cut at this many characters (trimmed request / response, never credentials). */
  LOG_MAX: 4000,
  /** Stock check: SKUs per inventorySnapshot call. */
  STOCK_BATCH: 100,
  /*
   * Phase 7 (2026-11-03, live tests on TEST_FACILITY + read-only reads of PO MGGN1/2627/API/0051 / GRN G8221 at
   * GGN_WAREHOUSE): inward PO at the RECEIVING facility (Facility header = receiving facility code).
   */
  CREATE_PO: '/services/rest/v1/purchase/purchaseOrder/create',
  PO_DETAILS: '/services/rest/v1/purchase/purchaseOrder/getPurchaseOrderDetails',
  GRN_LIST: '/services/rest/v1/purchase/inflowReceipt/getInflowReceipts',
  GRN_GET: '/services/rest/v1/purchase/inflowReceipt/getInflowReceipt',
  /** create with a code Uniware already has: refused 30002 DUPLICATE_CODE (an earlier request got through). */
  DUPLICATE_CODE: 'DUPLICATE_CODE',
  DUPLICATE_CODE_NO: 30002,
  /** PO details of a code Uniware does not have: refused 80060 INVALID_PURCHASE_ORDER_CODE (read-only probe 2026-11-03). */
  INVALID_PURCHASE_ORDER_CODE: 'INVALID_PURCHASE_ORDER_CODE',
  /** Custom fields of the inward PO (PEPIMS-era practice): ReferenceNo = SO code, ReferenceOrder = reference ID. */
  PO_FIELD_SO: 'ReferenceNo',
  PO_FIELD_REFERENCE: 'ReferenceOrder',
} as const;

/**
 * Uniware PO / GRN statuses (PO details statusCode: CREATED on our test PO, COMPLETE on MGGN1/2627/API/0051; GRN
 * statusCode COMPLETE on G8221). The GRN of an inward PO is complete when the PO is in DONE and every GRN is COMPLETE.
 */
export const D2C_PO_STATUS = {
  DONE: ['COMPLETE', 'CLOSED'] as readonly string[],
  CANCELLED: 'CANCELLED',
  GRN_DONE: 'COMPLETE',
} as const;

export const D2C_INWARD_PO = {
  /** Invoices per create-inward-po request. */
  MAX_IDS: 200,
  /** Inward POs sent to Uniware at the same time by one job. */
  CONCURRENCY: 2,
  /** A request in requested / unknown is looked up after this grace (plan 5.5: > the 120 s timeout + 429 back-off). */
  RECONCILE_GRACE_MS: 15 * 60_000,
  /** Variance reason note: at most this many characters (required for "other"). */
  NOTE_MAX: 1000,
} as const;

/** Sale order item statuses after which the item can no longer be cancelled from the tool (shipped, or already gone). */
export const D2C_SO_ITEM_DONE: readonly string[] = [
  'CANCELLED', 'DISPATCHED', 'SHIPPED', 'DELIVERED', 'REPLACED', 'RESHIPPED', 'RETURN_EXPECTED', 'RETURNED', 'COMPLETE', 'COMPLETED',
];
export const D2C_SO_ITEM_CANCELLED = 'CANCELLED';

export const D2C_SO_JOBS = {
  /** Transfers sent to Uniware at the same time by one create-SO job. */
  CONCURRENCY: 3,
  /** Transfers per create-SO / stock-check request. */
  MAX_IDS: 200,
  /** A finished job is kept this long for the screen to read its results. */
  KEEP_MS: 60 * 60 * 1000,
} as const;

/*
 * Phase 6 (2026-11-03): the Uniware SO status sync (plan 6). Our Uniware API user is shared with the in-transit fetch
 * and was answered 429 on a single get, so the sync is gentle: 2 calls at a time with a gap, a final 429 ends the run
 * early (progress kept) and the next run waits twice as long, up to 2 h.
 */
export const D2C_SYNC = {
  /** MySQL lock name: only one server runs a pass at a time. */
  LOCK: 'd2c-transfers-sync',
  JOB: 'd2c-sync',
  /** SO reads at the same time. */
  CONCURRENCY: 2,
  /** Pause of each lane after a Uniware call. */
  CALL_GAP_MS: 500,
  /** Longest wait between runs after failures (minutes). */
  MAX_DELAY_MIN: 120,
  /** The first timed run after a server start. */
  FIRST_DELAY_MS: 90_000,
  /** A timed run skips transfers synced less than (syncMinutes - this) ago. */
  FRESH_SLACK_MS: 2 * 60_000,
  /** Transfers read per run (oldest sync first); the rest wait for the next run. */
  MAX_PER_RUN: 500,
  /** Sync now on this server waits this long for another server's run to end. */
  MANUAL_LOCK_WAIT_S: 5,
  /** Sync now with ids: at most this many. */
  MAX_IDS: 200,
} as const;

/** Stages whose SO is read on every run (an SO exists and something is still to ship). */
export const D2C_SYNC_STAGES: readonly string[] = [
  D2C_STAGE.SALE_ORDER, D2C_STAGE.PACKED, D2C_STAGE.READY_TO_SHIP, D2C_STAGE.INVOICED, D2C_STAGE.PARTLY_DISPATCHED,
];

/** Uniware shipping package statuses (raw, upper case) as the sync reads them. */
export const D2C_PACKAGE_STATUS = {
  /** Left the dispatch warehouse (the package's `dispatched` time is used, else the first time the sync saw it). */
  DISPATCHED: ['DISPATCHED', 'SHIPPED', 'DELIVERED', 'RETURN_EXPECTED', 'RETURNED'] as readonly string[],
  /** Ready to ship or further (sets the header's RTS date). */
  RTS: ['READY_TO_SHIP', 'MANIFESTED'] as readonly string[],
  CANCELLED: 'CANCELLED',
} as const;

/** The SO line price (user, 2026-11-03): 15% of the line's MRP (tax included), rounded to paise. */
export const d2cSoUnitPrice = (mrp: number): number => Math.round(mrp * D2C_PRICE.SO_MRP_SHARE * 100) / 100;
