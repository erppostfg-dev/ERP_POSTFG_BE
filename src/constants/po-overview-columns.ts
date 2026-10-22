/*
 * PO Overview column groups (2026-10-14): which team owns which shipment column, in the workflow order PEPIMS's edit
 * screen uses (admin = our planning, then warehouse, then logistics; accounts added last, PEPIMS has no accounts
 * list). The screen shows one tab per team with that team's columns; only a team with edit access may change them.
 * Field names = master_purchase_orders columns as the shipments API sends them. To change the order or move a column,
 * change it here (design doc: https://claude.ai/code/artifact/c6865a06-f88b-4fde-b6f5-0b31727feba5).
 */

/** How the screen shows a value (the frontend grid's column kinds). */
export const COLUMN_KIND = {
  TEXT: 'text',
  MONO: 'mono',
  DATE: 'date',
  NUM: 'num',
  MONEY: 'money',
  LINK: 'link',
  STATUS: 'status',
} as const;
export type ColumnKind = (typeof COLUMN_KIND)[keyof typeof COLUMN_KIND];

export interface ColumnDef {
  field: string;
  label: string;
  kind: ColumnKind;
  /** Never edited on the screen, even by its team: changing it re-points links, the customer code and the Uniware CSV
   *  (needs its own rules, later). */
  locked?: boolean;
}

/** COPT (2026-10-15, user): its own team, after planning; took planning's columns from Special Remarks to Delivery Type. */
export const PO_TEAM = { PLANNING: 'planning', COPT: 'copt', WAREHOUSE: 'warehouse', LOGISTICS: 'logistics', ACCOUNTS: 'accounts' } as const;
export type PoTeam = (typeof PO_TEAM)[keyof typeof PO_TEAM];

/** Workflow order: the tab's step number = its position here + 1. */
export const PO_TEAM_ORDER: readonly PoTeam[] = [PO_TEAM.PLANNING, PO_TEAM.COPT, PO_TEAM.WAREHOUSE, PO_TEAM.LOGISTICS, PO_TEAM.ACCOUNTS];

export const PO_TEAM_LABEL: Record<PoTeam, string> = {
  [PO_TEAM.PLANNING]: 'Planning',
  [PO_TEAM.COPT]: 'COPT',
  [PO_TEAM.WAREHOUSE]: 'Warehouse',
  [PO_TEAM.LOGISTICS]: 'Logistics',
  [PO_TEAM.ACCOUNTS]: 'Accounts',
};

const c = (field: string, label: string, kind: ColumnKind = COLUMN_KIND.TEXT, locked = false): ColumnDef => (locked ? { field, label, kind, locked } : { field, label, kind });
const K = COLUMN_KIND;

/**
 * Fixed on the left of every tab (they stay while the rest scrolls), so a row can be recognised (user, 2026-10-14:
 * facility not needed here; UID moved to the Overview's shipment group).
 */
export const PO_KEY_COLUMNS: readonly ColumnDef[] = [
  c('poNumber', 'PO Number', K.MONO),
  c('channel', 'Channel'),
  c('location', 'Location'),
  c('statusFinal', 'Final Status', K.STATUS),
];

/** Set when the PO is saved or computed: nobody edits them; shown on the Overview tab. */
export const PO_SYSTEM_COLUMNS: readonly ColumnDef[] = [
  c('uid', 'UID', K.MONO),
  c('entryDate', 'Entry Date', K.DATE),
  c('poDate', 'PO Date', K.DATE),
  c('brandName', 'Brand'),
  c('totalUnits', 'Total Units', K.NUM),
  c('lines', 'Lines', K.NUM),
  c('updatedQty', 'Updated Qty', K.NUM),
  c('updatedGmv', 'Updated GMV', K.MONEY),
  c('updatedPoValue', 'Updated PO Value', K.MONEY),
  c('customerCode', 'Customer Code', K.MONO),
  c('poEntryCount', 'PO Entry Count', K.NUM),
  c('tatDays', 'TAT', K.NUM),
  c('criticalDispatchDate', 'Critical Dispatch Date', K.DATE),
  c('ratePerKg', 'Rate / kg Used', K.MONEY),
];

/** Each team's own columns (PEPIMS's role field lists; open points marked in the design doc). */
export const PO_TEAM_COLUMNS: Record<PoTeam, readonly ColumnDef[]> = {
  [PO_TEAM.PLANNING]: [
    c('poNumber', 'PO Number', K.MONO, true),
    c('facility', 'Facility', K.MONO, true),
    c('channel', 'Channel', K.TEXT, true),
    c('location', 'Location', K.TEXT, true),
    c('statusPlanning', 'Status (Planning)', K.STATUS),
    c('statusActive', 'Active / Inactive'),
    c('remarksPlanning', 'Remarks (Planning)'),
  ],
  // Moved out of planning (user, 2026-10-15): Special Remarks ... Delivery Type, in the same order.
  [PO_TEAM.COPT]: [
    c('specialRemarksCOPT', 'Special Remarks (COPT)'),
    c('newShipmentReference', 'New Shipment Reference', K.MONO),
    c('channelInwardingRemarks', 'Channel Inwarding Remarks'),
    c('dispatchDateTentative', 'Dispatch Date - Tentative', K.DATE),
    c('firstAppointmentDateCOPT', 'First Appointment Date (COPT)', K.DATE),
    c('appointmentShootedDate', 'Appointment Shooted Date', K.DATE),
    c('appointmentRequestedDate', 'Appointment Requested Date', K.DATE),
    c('orderNo1', 'Order No 1', K.MONO),
    c('orderNo2', 'Order No 2', K.MONO),
    c('orderNo3', 'Order No 3', K.MONO),
    c('poNumberInwardCWH', 'PO Number (Inward - CWH)', K.MONO),
    c('channelType', 'Channel Type'),
    c('labelsLink', 'PO Expiry Date'),
    c('deliveryType', 'Delivery Type'),
  ],
  [PO_TEAM.WAREHOUSE]: [
    c('statusWarehouse', 'Status (Warehouse)', K.STATUS),
    c('remarksWarehouse', 'Remarks (Warehouse)'),
    c('dispatchRemarksWarehouse', 'Dispatch Remarks (Warehouse)'),
    c('workingDatePlanner', 'Working Date', K.DATE),
    c('rtsDate', 'RTS Date', K.DATE),
    c('dispatchDate', 'Dispatch Date', K.DATE),
    c('noOfBoxes', 'No of Boxes', K.NUM),
    c('pickListNo', 'Pick List No', K.MONO),
    c('workingTypeWarehouse', 'Working Type (Warehouse)'),
    c('inventoryRemarksWarehouse', 'Inventory Remarks (Warehouse)'),
    c('b2bWorkingTeamRemarks', 'B2B Working Team Remarks'),
    c('actualWeight', 'Shipment Weight', K.NUM),
    c('volumetricWeight', 'Volumetric Weight', K.NUM),
    c('firstTransporter', '1st Transporter (First Mile)'),
    c('firstDocketNo', '1st Docket / Vehicle No', K.MONO),
    c('secondTransporter', '2nd Transporter (Mid Mile)'),
    c('secondDocketNo', '2nd Docket / Vehicle No', K.MONO),
    c('thirdTransporter', '3rd Transporter (Last Mile)'),
    c('thirdDocketNo', '3rd Docket / Vehicle No', K.MONO),
    c('proofOfDispatch', 'Proof Of Dispatch', K.LINK),
  ],
  [PO_TEAM.LOGISTICS]: [
    c('statusLogistics', 'Status (Logistics)', K.STATUS),
    c('dispatchRemarksLogistics', 'Dispatch Remarks (Logistics)'),
    // Only the current appointment date (user, 2026-10-21): every change of it is in the shipment's History
    // (old -> new, who, when), so First / Second / Third are not shown. Their DB columns and values stay.
    c('currentAppointmentDate', 'Current Appointment Date', K.DATE),
    c('appointmentLetter', 'Appointment Letter / STN', K.LINK),
    c('deliveryDate', 'Delivery Date', K.DATE),
    c('rescheduleLag', 'Reschedule Lag', K.NUM),
    c('finalRemarks', 'Final Remarks'),
    c('physicalWeight', 'Chargeable Weight', K.NUM),
    c('deliveryCharges', 'Delivery Charges', K.MONEY),
    c('halting', 'Halting', K.MONEY),
    c('unloadingCharges', 'Unloading Charges', K.MONEY),
    c('dedicatedVehicle', 'Dedicated Vehicle', K.MONEY),
    c('otherCharges', 'Other Charges', K.MONEY),
    c('rpk', 'Rates / kg', K.MONEY),
    c('proofOfDelivery', 'Proof Of Delivery', K.LINK),
  ],
  [PO_TEAM.ACCOUNTS]: [
    c('invoiceDate', 'Invoice Date', K.DATE),
    c('invoiceChallanNumber', 'Invoice / Challan Number', K.MONO),
    c('invoiceValue', 'Invoice Value', K.MONEY),
    c('invoiceLink', 'Invoice Link', K.LINK),
    c('cnLink', 'CN Link', K.LINK),
    c('ewayLink', 'E-Way Link', K.LINK),
    c('invoiceCheckedBy', 'Invoice Checked By'),
    c('remarksAccountsTeam', 'Remarks by Accounts Team'),
    c('tallyCustomerName', 'Tally Customer Name'),
  ],
};

/** A person's access to a team's columns. */
export const COLUMN_ACCESS = { NONE: 'none', VIEW: 'view', EDIT: 'edit' } as const;
export type ColumnAccess = (typeof COLUMN_ACCESS)[keyof typeof COLUMN_ACCESS];

/*
 * Teams of people (2026-10-14, user): ONE team per person (users.po_team). The four column-owning teams + viewer
 * (sees, edits nothing). Admin / developer roles have no team: they edit every group and see every shipment.
 */
export const USER_TEAM = { ...PO_TEAM, VIEWER: 'viewer' } as const;
export type UserTeam = (typeof USER_TEAM)[keyof typeof USER_TEAM];

/**
 * Default access of each team to each column group (design doc section 5, accepted by the user). The migration seeds
 * team_column_access with exactly this; after that the table is the truth (Admin page later). System and key columns
 * are view for everyone.
 */
export const DEFAULT_TEAM_ACCESS: Record<UserTeam, Record<PoTeam, ColumnAccess>> = {
  // COPT (2026-10-15): the COPT team edits its own group; everyone else sees it (planning too: the columns left it).
  [USER_TEAM.PLANNING]: { planning: COLUMN_ACCESS.EDIT, copt: COLUMN_ACCESS.VIEW, warehouse: COLUMN_ACCESS.VIEW, logistics: COLUMN_ACCESS.VIEW, accounts: COLUMN_ACCESS.VIEW },
  [USER_TEAM.COPT]: { planning: COLUMN_ACCESS.VIEW, copt: COLUMN_ACCESS.EDIT, warehouse: COLUMN_ACCESS.VIEW, logistics: COLUMN_ACCESS.VIEW, accounts: COLUMN_ACCESS.VIEW },
  [USER_TEAM.WAREHOUSE]: { planning: COLUMN_ACCESS.VIEW, copt: COLUMN_ACCESS.VIEW, warehouse: COLUMN_ACCESS.EDIT, logistics: COLUMN_ACCESS.VIEW, accounts: COLUMN_ACCESS.NONE },
  [USER_TEAM.LOGISTICS]: { planning: COLUMN_ACCESS.VIEW, copt: COLUMN_ACCESS.VIEW, warehouse: COLUMN_ACCESS.VIEW, logistics: COLUMN_ACCESS.EDIT, accounts: COLUMN_ACCESS.VIEW },
  [USER_TEAM.ACCOUNTS]: { planning: COLUMN_ACCESS.VIEW, copt: COLUMN_ACCESS.VIEW, warehouse: COLUMN_ACCESS.VIEW, logistics: COLUMN_ACCESS.VIEW, accounts: COLUMN_ACCESS.EDIT },
  [USER_TEAM.VIEWER]: { planning: COLUMN_ACCESS.VIEW, copt: COLUMN_ACCESS.VIEW, warehouse: COLUMN_ACCESS.VIEW, logistics: COLUMN_ACCESS.VIEW, accounts: COLUMN_ACCESS.VIEW },
};

/** Teams whose shipments are limited to their facilities (option c: own facilities by default, edit only own). */
export const FACILITY_SCOPED_TEAMS: readonly UserTeam[] = [USER_TEAM.WAREHOUSE, USER_TEAM.LOGISTICS];
