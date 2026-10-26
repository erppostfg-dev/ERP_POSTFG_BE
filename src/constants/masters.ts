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
