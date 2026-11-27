/*
 * Masters API: every master-data screen (sidebar "Masters") is served from routes/masters.routes.ts, mounted at
 * /masters. One path per screen, the same as the frontend page key under /masters.
 */

/** Paths inside the masters router (the full URL is /api/v1/masters/<path>). */
export const MASTER_ROUTES = {
  PEP_SKUS: '/pep-skus',
  CHANNEL_SKUS: '/channel-skus',
  CHANNEL_CUSTOMERS: '/channel-customers',
  /** Warehouses = our facilities (page /masters/warehouses). */
  PEP_WAREHOUSES: '/warehouses/pep',
  /** Channel Location Master = the channels' delivery locations, details_channels (own page since 2026-10-16). */
  CHANNEL_LOCATIONS: '/channel-locations',
  /** Channels (master_channels): POST adds one (2026-10-27); the list stays GET /channel-customers. */
  CHANNELS: '/channels',
  /** Dropdowns of the four Add forms. */
  FORM_OPTIONS: '/form-options',
  /** One row's history (2026-10-28): /history/:type/:id, type = MASTER_LOG_TYPE value, id = the row's DB id. */
  HISTORY: '/history/:type/:id',
  /** Recent changes across the 5 masters (2026-10-28): ?type=&days=. */
  CHANGES: '/changes',
  /** Edit one row (2026-10-28, PATCH): keys locked, logged. */
  EDIT: '/edit/:type/:id',
  /** Switch one row on / off (2026-10-28, POST { active }): never deleted, logged. */
  ACTIVE: '/active/:type/:id',
  /** D2C internal transfer routes (2026-11-03): GET the grid, PATCH /:id one route's codes / on-off. */
  TRANSFER_ROUTES: '/transfer-routes',
  TRANSFER_ROUTE: '/transfer-routes/:id',
  /** Bulk upload of transfer routes (2026-11-25): GET the template, POST the .csv to preview, then to import. */
  TRANSFER_ROUTES_TEMPLATE: '/transfer-routes/template',
  TRANSFER_ROUTES_PREVIEW: '/transfer-routes/upload/preview',
  TRANSFER_ROUTES_IMPORT: '/transfer-routes/upload/import',
  /** Bulk upload (2026-11-27): the format (columns + lists), today's rows, check (nothing saved), apply (all or nothing). */
  BULK_FORMAT: '/bulk/:type/format',
  BULK_CURRENT: '/bulk/:type/current',
  BULK_CHECK: '/bulk/:type/check',
  BULK_APPLY: '/bulk/:type/apply',
} as const;

/**
 * Transfer routes bulk upload (2026-11-25): the .csv columns. A row = one route, found by Sender + Channel + Location +
 * Uniware Channel (else the only route of that Sender + Location: its Uniware channel changes); not found = a new route.
 * An empty cell keeps the current value; Active = Yes / No (empty = keep, new route = Yes).
 */
export const ROUTE_UPLOAD_COLUMN = {
  SENDER: 'Sender', CHANNEL: 'Channel', LOCATION: 'Location', UNIWARE_CHANNEL: 'Uniware Channel', CUSTOMER_CODE: 'Customer Code',
  CUSTOMER_NAME: 'Customer Name', VENDOR_CODE: 'Vendor Code', ACTIVE: 'Active',
} as const;
export const ROUTE_UPLOAD_COLUMNS = Object.values(ROUTE_UPLOAD_COLUMN);
export const ROUTE_UPLOAD_REQUIRED = [ROUTE_UPLOAD_COLUMN.SENDER, ROUTE_UPLOAD_COLUMN.CHANNEL, ROUTE_UPLOAD_COLUMN.LOCATION, ROUTE_UPLOAD_COLUMN.UNIWARE_CHANNEL];
/**
 * Masters bulk upload (2026-11-27, master-bulk.service.ts): one mode per file (add | update), up to MAX_ROWS rows.
 * FIRST_DATA_ROW = the Excel row of the first data row (row 1 = the column names), so problems name the row people see.
 */
export const MASTER_BULK = {
  MAX_ROWS: 5000,
  FIRST_DATA_ROW: 2,
  YES_NO: ['Yes', 'No'] as readonly string[],
  REMARK_PREFIX: 'Bulk upload',
  DEFAULT_FILE: 'upload.xlsx',
} as const;
export type MasterBulkMode = 'add' | 'update';
/** One column of a bulk file: the frontend builds the Excel (header note, drop-down, number rule) from it. */
export interface MasterBulkColumn {
  key: string;
  label: string;
  type: 'text' | 'decimal' | 'int' | 'list' | 'yesno';
  required: boolean;
  /** Update files: shown for reference, never changed (a key of the row). */
  readOnly?: boolean;
  /** type list: which list of the format's lists. */
  list?: string;
  min?: number;
  max?: number;
  /** A format rule said in words (EAN digits ...). */
  pattern?: string;
  help: string;
  example: string;
}

export const ROUTE_UPLOAD = { FIELD: 'file', MAX_BYTES: 2 * 1024 * 1024, MAX_ROWS: 5000, CUSTOMER_NAME_MAX: 255 } as const;

/** Masters history (2026-10-28): most entries one call returns, and the "recent changes" look-back (days). */
export const MASTER_HISTORY = {
  ROW_LIMIT: 300,
  CHANGES_LIMIT: 500,
  DAYS_DEFAULT: 7,
  DAYS_MAX: 365,
  /** Source label of the in-transit master uploads' log rows (intransit_master_changes), prefixed to their source. */
  INTRANSIT_SOURCE_PREFIX: 'intransit_',
} as const;

/*
 * Add forms on the Masters pages (user, 2026-10-27): admin / developer only; EVERY field of the form is required (only
 * fields that exist in the DB); nothing is added until all are filled and valid. Add only, no edit yet.
 */
export const MASTER_ADD = {
  /** Request body fields per form (= the frontend's form keys). */
  SKU: ['pepCode', 'productName', 'brand', 'productType', 'mrp', 'gstTaxType', 'eanCode', 'hsnCode', 'lengthMm', 'widthMm', 'heightMm', 'weightG', 'shelfLife', 'isActive'],
  CHANNEL_SKU: ['channelId', 'channelCode', 'pepCode', 'productName', 'brand', 'mrp', 'marginPercent', 'rateAfterMargin', 'eanCode'],
  CHANNEL: ['displayName', 'slug', 'aliases', 'isActive'],
  LOCATION: ['channelId', 'locationCode', 'uniwareCustomerCode', 'uniwareChannelCode', 'facilityCode', 'consigneeName', 'consigneeGstNumber',
    'consigneeState', 'consigneePinCode', 'shippingAddress', 'billingAddress', 'buyerType', 'buyerGstNumber', 'buyerState', 'buyerPinCode',
    'tallyLedgerName', 'appointmentChannel'],
  /** GST rates offered (stored as text like most rows: "18"). */
  GST_RATES: ['0', '3', '5', '12', '18', '28'],
  /** "Appointment via" = details_channels.appointment_channel as stored today. */
  APPOINTMENT: ['Yes', 'No'],
  /** details_channels.buyer_type (empty on every row so far): the B2B / B2C split the locations already use (user OK). */
  BUYER_TYPES: ['B2B', 'B2C'],
  /** Field formats (the message names the rule). */
  EAN: { re: /^(\d{8}|\d{12,14})$/, rule: '8, 12, 13 or 14 digits' },
  HSN: { re: /^\d{4,8}$/, rule: '4 to 8 digits' },
  PIN: { re: /^[1-9]\d{5}$/, rule: '6 digits' },
  GSTIN: { re: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, rule: 'a 15-character GSTIN (e.g. 27AAACI1234A1Z5)' },
  SLUG: { re: /^[a-z0-9]+(-[a-z0-9]+)*$/, rule: 'lower-case letters, digits and dashes (e.g. tata-1mg)' },
  /** Longest text per field (DB varchar 255; addresses are text). */
  TEXT_MAX: 255,
  ADDRESS_MAX: 2000,
  /** master_channels.channel_type (2026-10-28 new masters). */
  CHANNEL_TYPES: ['B2B', 'B2C'],
  /** Expiry days accepted by a channel (min / max), whole days. */
  EXPIRY_DAYS: { min: 0, max: 3650 },
  /** The optional remark of a save (master_change_logs.remark; user 2026-10-28: one remark, optional). */
  REMARK_MAX: 1000,
  /** States and union territories offered for consignee / buyer state (the DB has a few wrong ones, e.g. "Mumbai"). */
  STATES: ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
    'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
    'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
    'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'],
} as const;

/*
 * masters:load / masters:link (2026-10-14): the PO Overview masters are filled from CSV files whose columns are
 * PEPIMS's master sheet fields plus a few of ours. They come straight from PEPIMS's tables (--pepims, read-only) or
 * from a CSV with the same columns (--file, e.g. the real Uniware facility codes later).
 */

/** The master types masters:load knows, in the order --all loads them (rates need partners, links need facilities). */
export const MASTER_LOAD_TYPE = {
  FACILITY: 'facility',
  COURIER_PARTNER: 'courier-partner',
  COURIER_RATES: 'courier-rates',
  STATUS_VALUES: 'status-values',
  STATUS: 'status',
  APPOINTMENT_REMARKS: 'appointment-remarks',
  CHANNEL: 'channel',
} as const;
export type MasterLoadType = (typeof MASTER_LOAD_TYPE)[keyof typeof MASTER_LOAD_TYPE];
export const MASTER_LOAD_TYPES: readonly MasterLoadType[] = Object.values(MASTER_LOAD_TYPE);

/** Separator of several values in one CSV cell (aliases). */
export const CSV_LIST_SEPARATOR = '|';

/** CSV columns per master type: `required` must be in the header and filled; `optional` may be missing. */
export const MASTER_CSV_COLUMNS: Record<MasterLoadType, { required: readonly string[]; optional: readonly string[] }> = {
  [MASTER_LOAD_TYPE.FACILITY]: {
    required: ['facility'],
    optional: ['parentFacility', 'pickupLocation', 'aliases', 'name', 'entity', 'state', 'facilityType', 'billToGstin', 'shipToGstin', 'remarks'],
  },
  [MASTER_LOAD_TYPE.COURIER_PARTNER]: {
    required: ['courierPartnerMode'],
    optional: ['courierPartner', 'courierMode', 'courierType', 'appointmentChargeYes', 'appointmentChargeNo', 'docketCharges', 'tat', 'aliases'],
  },
  [MASTER_LOAD_TYPE.COURIER_RATES]: { required: ['courierPartner', 'pickupLocation', 'dropLocation'], optional: ['ratesPerKg', 'tat'] },
  [MASTER_LOAD_TYPE.STATUS_VALUES]: { required: ['stage', 'value'], optional: ['sortOrder'] },
  [MASTER_LOAD_TYPE.STATUS]: { required: ['statusPlanning', 'statusWarehouse', 'statusLogistics', 'statusFinal'], optional: [] },
  [MASTER_LOAD_TYPE.APPOINTMENT_REMARKS]: { required: ['remark'], optional: ['category', 'list', 'sortOrder'] },
  [MASTER_LOAD_TYPE.CHANNEL]: {
    required: ['channel', 'channelLocation'],
    optional: ['channelCategory', 'dropLocation', 'apptChannel', 'apptChannelType'],
  },
};
