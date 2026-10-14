/*
 * PO Overview API (2026-10-14): GET /po-overview/... lists our POs at shipment level (master_purchase_orders) and at
 * line level (details_purchase_orders), with the columns PEPIMS's dashboard computes (final status, TAT, critical
 * dispatch date, current appointment date, delivery type, channel type). Read-only for now.
 */

/** Paths inside the po-overview router (full URL /api/v1/po-overview/<path>). */
export const PO_OVERVIEW_ROUTES = {
  SHIPMENTS: '/shipments',
  SHIPMENT: '/shipments/:uid',
  LINES: '/lines',
  FILTER_OPTIONS: '/filter-options',
  COLUMNS: '/columns',
} as const;

/** Paging: PEPIMS loads 200 rows per request. */
export const PO_OVERVIEW_LIST = { DEFAULT_PAGE_SIZE: 200, MAX_PAGE_SIZE: 500 } as const;

/** Query parameter names (also the `field` of a VALIDATION_FAILED detail). Multi-value filters repeat the parameter. */
export const PO_OVERVIEW_QUERY = {
  Q: 'q',
  SKU_CODE: 'skuCode',
  DOCKET_NO: 'docketNo',
  BRAND: 'brand',
  CHANNEL: 'channel',
  FACILITY: 'facility',
  LOCATION: 'location',
  STATUS_PLANNING: 'statusPlanning',
  STATUS_WAREHOUSE: 'statusWarehouse',
  STATUS_LOGISTICS: 'statusLogistics',
  STATUS_FINAL: 'statusFinal',
  TRANSPORTER: 'transporter',
  NOT_ASSIGNED: 'notAssigned',
  PO_DATE_FROM: 'poDateFrom',
  PO_DATE_TO: 'poDateTo',
  WORKING_DATE_FROM: 'workingDateFrom',
  WORKING_DATE_TO: 'workingDateTo',
  DISPATCH_DATE_FROM: 'dispatchDateFrom',
  DISPATCH_DATE_TO: 'dispatchDateTo',
  APPOINTMENT_DATE_FROM: 'appointmentDateFrom',
  APPOINTMENT_DATE_TO: 'appointmentDateTo',
  PAGE: 'page',
  PAGE_SIZE: 'pageSize',
} as const;

/** A multi-select value meaning "the field is empty" (PEPIMS's "Not Assigned"). */
export const NOT_ASSIGNED = 'Not Assigned';

/** notAssigned=<value>: shipments whose date is still empty (current appointment = currentAppointmentDate and the COPT one). */
export const NOT_ASSIGNED_DATE = {
  WORKING_DATE: 'workingDate',
  DISPATCH_DATE: 'dispatchDate',
  APPOINTMENT_DATE: 'appointmentDate',
  RTS_DATE: 'rtsDate',
} as const;
export type NotAssignedDate = (typeof NOT_ASSIGNED_DATE)[keyof typeof NOT_ASSIGNED_DATE];

/** An empty stage status counts as this when looking up the final status (PEPIMS does the same). */
export const STATUS_WHEN_EMPTY = 'Confirmed';

/** Delivery type when the shipment has none: PEPIMS's rule (exact channel names Amazon / Flipkart pick up). */
export const DELIVERY_TYPE = { PICK_UP: 'Pick up', DROP_IN: 'Drop in' } as const;
export const PICKUP_CHANNELS: readonly string[] = ['amazon', 'flipkart'];
