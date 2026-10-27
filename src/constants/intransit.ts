/*
 * In-transit stock report (Demand Planning > In-transit Stock), the TypeScript port of intransit-service/ (user,
 * 2026-10-15): the inputs it needs, the facility groups shared by its stages, the workbook's sheets, the run
 * values and the API paths. Rules used by only one stage stay at the top of that stage's file, as in the Python.
 */

// ---- inputs ----------------------------------------------------------------------------------------------------

export const INTRANSIT_TEMPLATE_NAME = 'Intransit_Stock_Report.xlsx';
export const INTRANSIT_REPORT_NAME = 'Intransit_Stock_Report_FINAL.xlsx';
/** SOH + in-transit per SKU x channel x location, written next to each report for Inventory Calculation. */
export const INTRANSIT_INVENTORY_FILE = 'inventory.json';

/**
 * Input groups, in the order the page shows them (user, 2026-10-19):
 *   master        kept once, replaced when a new version is uploaded (history kept); every build uses the current one;
 *   daily-upload  stored per date (inputs/daily/<date>/), uploaded by hand;
 *   daily-fetch   stored per date, fetched by a connector for that date (uploading them is still allowed).
 * A daily file missing for a date: the latest earlier copy is used, marked.
 */
export const INPUT_GROUP = {
  MASTER: 'master',
  DAILY_UPLOAD: 'daily-upload',
  DAILY_FETCH: 'daily-fetch',
} as const;
export type InputGroup = (typeof INPUT_GROUP)[keyof typeof INPUT_GROUP];

export const INPUT_GROUP_TITLES: Record<InputGroup, string> = {
  master: 'Masters',
  'daily-upload': 'Upload',
  'daily-fetch': 'From APIs',
};

/** Which connector writes an API-group file. */
export const INTRANSIT_SOURCE = {
  AMAZON: 'amazon',
  UNIWARE: 'uniware',
  FLIPKART: 'flipkart',
} as const;
export type IntransitSource = (typeof INTRANSIT_SOURCE)[keyof typeof INTRANSIT_SOURCE];

/** Inputs built from PEPIMS's own tracker at report build (sources/pepims.ts), not by a connector run. */
export const PEPIMS_CONNECTOR = 'pepims';

export interface InputFile {
  name: string;
  group: InputGroup;
  source: string;
  /** Columns the stages read. */
  required: string[];
  /** Alternatives: at least one column of each list must be present. */
  oneOf?: string[][];
  /** The connector that can fetch this file. */
  /** 'pepims' = read from PEPIMS's tracker at build (Shipment_Status, PO_Format). */
  connector?: IntransitSource | typeof PEPIMS_CONNECTOR;
  /** Masters: 'daily' = expected to be updated every day (warned when not updated today), else 'on-change'. */
  refresh?: 'daily' | 'on-change';
  /** The connector's option that fetches only this file (amazon soh|grn, uniware b2b|po|inventory). */
  fetchKey?: string;
  /** Fetched files: 'any-date' = can be fetched for a past date; 'today-only' = the API only gives the current state. */
  fetchable?: 'any-date' | 'today-only';
}

/** Every input the pipeline needs: where it comes from and the columns it must have (input_catalog.py). */
export const INPUT_CATALOG: readonly InputFile[] = [
  // ---- daily, read from PEPIMS at the build (constants/intransit-pepims.ts)
  {
    name: 'Shipment_Status.csv', group: 'daily-fetch', connector: PEPIMS_CONNECTOR, fetchable: 'today-only',
    source: 'PEPIMS shipment tracker (shipment_orders), last 90 days, read at build',
    required: ['PO Number', 'PO Number (Inward - CWH)', 'Updated Qty', 'Status (Planning)', 'Status (Warehouse)', 'Status (Logistics)',
      'Delivery Date', 'Pick List No', 'Channel'],
  },
  {
    name: 'PO_Format.csv', group: 'daily-fetch', connector: PEPIMS_CONNECTOR, fetchable: 'today-only',
    source: 'PEPIMS PO lines (sku_orders) of those POs, read at build',
    required: ['PO Number', 'SKU Code', 'Channel SKU Code', 'Quantity', 'Updated Quantity', 'Entry Date', 'PO Date', 'Facility', 'Channel',
      'Location', 'Brand', 'Sr No', 'SKU Name', 'GMV', 'PO Value', 'Updated GMV', 'Updated PO Value', 'Product Weight', 'Working Date',
      'Dispatch Date', 'Current Appointment Date', 'Status Planning', 'Status Warehouse', 'Status Logistics'],
  },
  // ---- masters
  { name: 'Channel SKU Mapping.csv', group: 'master', refresh: 'on-change', source: 'Marketplace code -> SKU', required: ['Channel Codes', 'Listing SKU Codes at Channel'] },
  { name: 'Final SKU Mapping.csv', group: 'master', refresh: 'on-change', source: 'Listing SKU -> Final SKU', required: ['Listing_SKU', 'Final SKU'] },
  { name: 'Split1.csv', group: 'master', refresh: 'on-change', source: 'Combo -> components (stage 1)', required: ['SKU Code', 'Split SKU'] },
  { name: 'Split2.csv', group: 'master', refresh: 'on-change', source: 'Combo -> components (stage 2)', required: ['SKU Code', 'Split SKU'] },
  { name: 'Sheet35(2).csv', group: 'master', refresh: 'on-change', source: 'SKU master (name, type, MRP, COGS)', required: ['SKU Code'] },
  {
    name: 'Location Master.csv', group: 'master', refresh: 'on-change', source: 'Channel + fulfilment centre -> city',
    required: ['Channel', 'Fulfillment Centre-ID', 'Final Location'],
  },
  { name: 'MyntraWHIDs.csv', group: 'master', refresh: 'on-change', source: 'Myntra warehouse id -> city', required: ['WH Id', 'WH location'] },
  { name: 'SKU-Not To Consider.csv', group: 'master', refresh: 'on-change', source: 'SKUs flagged Consider? = No (first column)', required: [] },
  { name: INTRANSIT_TEMPLATE_NAME, group: 'master', refresh: 'on-change', source: 'Report template: the workbook whose formatting the report reuses', required: [] },

  // ---- daily, uploaded
  { name: 'FK_GRN.csv', group: 'daily-upload', source: 'Flipkart Seller Hub - consignment GRN', required: ['Consignment Id', 'GRN Status', 'GRN Qty'] },
  {
    name: 'Myntra_SOH.csv', group: 'daily-upload', source: 'Myntra Partner Portal - inventory',
    required: ['sku code', 'seller sku code', 'warehouse id', 'po_type', 'inventory count'],
  },
  { name: 'Myntra_GRN.csv', group: 'daily-upload', source: 'Myntra Partner Portal - STR inward', required: ['STR Code', 'Lot Status', 'Inward Qty'] },
  {
    name: 'FK_SOH.csv', group: 'daily-upload', source: 'Flipkart Seller Hub - inventory (or the Flipkart API)', connector: 'flipkart', fetchKey: 'soh', fetchable: 'today-only',
    required: ['FSN', 'SKU', 'Title', 'Warehouse Id', 'Live on Website'],
  },

  // ---- daily, fetched
  {
    name: 'Amazon_SOH.csv', group: 'daily-fetch', source: 'Amazon SP-API (inventory ledger)', connector: 'amazon', fetchKey: 'soh', fetchable: 'any-date',
    required: ['FNSKU', 'MSKU', 'Title', 'Location', 'Disposition', 'Ending Warehouse Balance'],
  },
  {
    name: 'Amazon_GRN.csv', group: 'daily-fetch', source: 'Amazon SP-API (inbound shipments)', connector: 'amazon', fetchKey: 'grn', fetchable: 'today-only',
    required: ['Status', 'Units located'], oneOf: [['Shipment ID', 'Shipment name']],
  },
  {
    name: 'Export-B2B Sale Orders.csv', group: 'daily-fetch', source: 'Uniware export: B2B Sale Orders', connector: 'uniware', fetchKey: 'b2b', fetchable: 'any-date',
    required: ['Sale Order Code', 'Display Order Code', 'Item SKU Code', 'Channel Product ID', 'Sale Order Status', 'Total Quantity',
      'Unallocated Quantity', 'Unfulfillable Quantity', 'Allocated Quantity', 'Cancelled Quantity', 'In Process Quantity', 'Complete Quantity'],
  },
  {
    name: 'Purchase_Order.csv', group: 'daily-fetch', source: 'Uniware export: Purchase Orders', connector: 'uniware', fetchKey: 'po', fetchable: 'any-date',
    required: ['PO Code', 'Created', 'Delivery Date', 'Item Type Name', 'Item SkuCode', 'Order Quantity', 'Recieved Quantity', 'Facility', 'Total',
      'Purchase Order Status', 'Reference No', 'ReferenceOrder'],
  },
  {
    name: 'Export-Inventory Snapshot.csv', group: 'daily-fetch', source: 'Uniware export: Inventory Snapshot', connector: 'uniware', fetchKey: 'inventory', fetchable: 'today-only',
    required: ['Facility', 'Item Type Name', 'Item SkuCode', 'Open Sale', 'Inventory', 'Putaway Pending', 'Stock In Transfer', 'Open Purchase'],
  },
];

export const INPUT_BY_NAME: ReadonlyMap<string, InputFile> = new Map(INPUT_CATALOG.map((f) => [f.name, f]));

/** Every CSV the pipeline reads (the template is checked separately). */
export const REQUIRED_INPUTS: readonly string[] = INPUT_CATALOG.filter((f) => f.name !== INTRANSIT_TEMPLATE_NAME).map((f) => f.name);

/** Kept once (masters) vs per date (daily). */
export const isMasterInput = (name: string): boolean => INPUT_BY_NAME.get(name)?.group === INPUT_GROUP.MASTER;

/** Bytes read to find a CSV's header row when validating an upload. */
export const HEADER_SCAN_BYTES = 262144;

// ---- facilities (rules.py) -------------------------------------------------------------------------------------

/** Final Status values that count as in-transit stock at SKU level. */
export const INTRANSIT_STOCK_STATUSES = ['Working', 'Manual Check', 'RTS', 'Intransit', 'Working Hold'];

const D2C_FACILITIES = [
  'HYP_SRGGN', 'HYP_SRKOL', 'mCaff_Mumbai2', 'mCaff_Gurgaon2', 'mCaff_Bangalore2', 'mCaff_Kolkata2', 'mCaff_Ahmedabad', 'mCaff_Hyderabad2',
  'mCaff_Guwahati', 'HYP_SRBGLR', 'HYP_AHMD', 'HYP_SRHYD', 'HYP_SRGWHT', 'HYP_SRLOK', 'mCaff_Gurgaon3', 'mCaff_Lucknow3', 'HYP_SRLOK2',
  'HYP_DLNAG', 'HYP_DLGWHT', 'mCaff_Lucknow2', 'Mcaff_Nagpur', 'mCaff_Guwahati2', 'HYP_SPCHN', 'Mcaff_Chennai',
];
const DARKSTORE_FACILITIES = [
  'DS_NCR_PD_MOTHERHUB', 'DS_NCR_PD_EASTDELHI_931', 'DS_NCR_PD_FARIDABAD', 'DS_NCR_PD_GHAZIABAD', 'DS_NCR_PD_HUMAYUNPUR_945',
  'DS_NCR_PD_NANGLOIHUB_935', 'DS_NCR_PD_NOIDAHUB_907', 'DS_NCR_PD_OKHLAHUB_939', 'DS_NCR_PD_CENTRALHUB_908', 'DS_NCR_PD_TRANSPORTNAGAR_934',
  'DS_NCR_PD_WESTHUB_906', 'DS_NCR_PD_GURUGRAM_SARHAULGGN',
];
export const TEST_FACILITY = 'TEST_FACILITY';

/** group -> [Channel type, facilities]. The order is the SOH row order. */
export const FACILITY_GROUPS: readonly [string, string, readonly string[]][] = [
  ['D2C', 'D2C', D2C_FACILITIES],
  ['DarkStore', 'DarkStore', DARKSTORE_FACILITIES],
  ['GGNMWH', 'MWH', ['GGN_WAREHOUSE', 'HYP_B2B_GGN']],
  ['MUMMWH', 'MWH', ['HYP_B2B_MUM2', 'MUM_WAREHOUSE2']],
  ['Return', 'Return', ['Return_MUM2', 'Return_GGN']],
];

/** lower-cased facility code -> group name */
export const FACILITY_TO_GROUP: ReadonlyMap<string, string> = new Map(
  FACILITY_GROUPS.flatMap(([group, , facs]) => facs.map((f) => [f.toLowerCase(), group] as [string, string])),
);

// ---- workbook (excel.py) ---------------------------------------------------------------------------------------

/** Template sheets whose data is replaced: [part, frame, header style id, fallback column, label]. */
export const BASE_SHEETS: readonly [string, string, number, string, string][] = [
  ['xl/worksheets/sheet1.xml', 'df_intransit_stock_v2', 1, 'AC', 'Intransit_Stock'],
  ['xl/worksheets/sheet2.xml', 'df_full_shipment_v2', 3, 'BX', 'Full_Shipment_Enhanced'],
  ['xl/worksheets/sheet3.xml', 'df_summary', 4, 'A', 'Summary_Dashboard'],
];

/** Generated sheets appended after the template's, in this order: [sheet name, frame]. */
export const EXTRA_SHEETS: readonly [string, string][] = [
  ['Duplicate_PO_Report', 'df_dup_report'],
  ['Export_B2B_InTransit_Orders', 'df_b2b_intransit'],
  ['PO_Not_Found_in_Export_B2B', 'df_po_not_found'],
  ['Combined_InTransit_Units', 'df_combined_intransit'],
  ['Current_Inventory', 'df_current_inventory'],
  ['Combined_SOH_Intransit', 'df_combined_soh'],
  ['Channel_Location_Master', 'df_channel_location_master'],
  ['Missing_Items_Report', 'df_missing_items'],
  ['SOH+Intransit-Split1', 'df_split1'],
  ['SOH+Intransit-Split2', 'df_split2'],
  ['Sheet35(2)', 'df_sheet35'],
  ['Final Sheet35(2)', 'df_final_sheet35'],
  ['SKU not available in Split1', 'df_gap_split1'],
  ['SKU not available in Split2', 'df_gap_split2'],
  ['SKU not available in Sheet35(2)', 'df_gap_sheet35'],
  ['Final SKU Not Mapped', 'df_final_sku_not_mapped'],
  ['Final SKU Code Missing', 'df_final_sku_code_missing'],
];

/** Every sheet in workbook order: [label, frame]. */
export const SHEET_FRAMES: readonly [string, string][] = [...BASE_SHEETS.map(([, frame, , , label]) => [label, frame] as [string, string]), ...EXTRA_SHEETS];

// ---- runs ------------------------------------------------------------------------------------------------------

/** intransit_runs.kind: a report build, or a connector fetch. */
export const INTRANSIT_RUN_KIND = {
  REPORT: 'report',
  ...INTRANSIT_SOURCE,
} as const;
export type IntransitRunKind = (typeof INTRANSIT_RUN_KIND)[keyof typeof INTRANSIT_RUN_KIND];

export const INTRANSIT_RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;
export type IntransitRunStatus = (typeof INTRANSIT_RUN_STATUS)[keyof typeof INTRANSIT_RUN_STATUS];

/** Lines of the log returned with a run (the full log is GET /runs/:id/log). */
export const INTRANSIT_LOG_TAIL_LINES = 15;
/** Error stored on runs left queued/running when the server stopped. */
export const INTRANSIT_RESTART_ERROR = 'The server restarted while this was running; start it again.';

/** Folders under INTRANSIT_DIR. */
export const INTRANSIT_FOLDERS = {
  INPUTS: 'inputs',
  /** inputs/masters/<name>, their replaced versions in inputs/masters/_history/<name>/ */
  MASTERS: 'masters',
  HISTORY: '_history',
  /** inputs/daily/<YYYY-MM-DD>/<name> */
  DAILY: 'daily',
  /** inputs/daily/<YYYY-MM-DD>/_replaced/<stamp>__<name>: a day's file replaced by a newer copy (never lost) */
  REPLACED: '_replaced',
  RUNS: 'runs',
  EXPORTS: 'exports',
  CACHE: 'cache',
  /** _deleted/<inputs|runs|exports>/...: what the page deleted, moved aside instead of removed (user, 2026-10-22) */
  DELETED: '_deleted',
} as const;

/** Paths under /intransit (routes/intransit.routes.ts). */
export const INTRANSIT_ROUTES = {
  DAY: '/day',
  INPUT: '/inputs/:name',
  INPUT_HISTORY: '/inputs/:name/history',
  INPUT_RESTORE: '/inputs/:name/restore',
  RUNS: '/runs',
  RUN: '/runs/:id',
  RUN_LOG: '/runs/:id/log',
  RUN_REPORT: '/runs/:id/report',
  CONNECTOR: '/connectors/:source',
  INVENTORY: '/inventory',
  INPUT_TABLE: '/inputs/:name/table',
  INPUT_DOWNLOAD: '/inputs/:name/download',
  RUN_FILE_TABLE: '/runs/:id/files/:name/table',
  RUN_FILE_DOWNLOAD: '/runs/:id/files/:name/download',
  RUN_SHEET_TABLE: '/runs/:id/sheets/:sheet/table',
  RUN_SHEET_DOWNLOAD: '/runs/:id/sheets/:sheet/download',
  SPLIT1_ROWS: '/split1/rows',
  COMBO_VARIANTS: '/final-sku/variants',
  STORAGE_STATUS: '/storage/status',
  STORAGE_RETRY: '/storage/retry',
  SNAPSHOT: '/snapshot',
  SNAPSHOT_FILE: '/snapshot/file',
  PERIODS: '/periods',
  PERIOD_DOWNLOAD: '/periods/download',
} as const;

// ---- S3 storage (user, 2026-10-26; folders in modules/intransit/s3/layout.ts) ------------------------------------

/** Files written next to a run. */
export const RUN_RECORD_FILE = 'run.json';

// ---- in-transit masters in the database (user, 2026-10-25) -----------------------------------------------------

/** intransit_master_changes.action: uploads only add and update (user). */
export const MASTER_CHANGE_ACTION = { ADD: 'add', UPDATE: 'update' } as const;
export type MasterChangeAction = (typeof MASTER_CHANGE_ACTION)[keyof typeof MASTER_CHANGE_ACTION];

/** intransit_master_changes.source: what changed the master. */
export const MASTER_CHANGE_SOURCE = {
  /** a master file uploaded on the Masters tab */
  UPLOAD: 'upload',
  /** a combo added from a report's combo check */
  SPLIT1_ADD: 'split1_add',
  /** a combo variant mapped to its base */
  VARIANT_MAP: 'variant_map',
  /** the first full load (npm run intransit:masters) */
  LOADER: 'loader',
} as const;
export type MasterChangeSource = (typeof MASTER_CHANGE_SOURCE)[keyof typeof MASTER_CHANGE_SOURCE];

/**
 * A SKU code that names a combo: CMB104, SCMB37_C, MCFSCMB0118F0003, HYPCOMB001B003 ... (the rule final_sku.py already
 * used for "Final SKU Code Missing"; the user confirmed combos carry CMB in their code, 2026-10-19).
 */
export const COMBO_CODE_RE = /(?:scmb|cmb|comb)/i;

/**
 * Combo check after every report build (user, 2026-10-19): SKUs of "SKU not available in Split1" that Uniware's item
 * master calls BUNDLE, or whose code names a combo (COMBO_CODE_RE), are combos missing from Split1. Files written next
 * to the report, and the item-type cache.
 */
export const COMBO_CHECK = {
  /** The combos missing from Split1, one row per combo (shown on the Reports tab). */
  ALERT_FILE: 'combos_not_in_split1.csv',
  /** The rows to add to Split1.csv for them, in Split1's own layout (SKU Code, Split SKU). */
  SPLIT1_ROWS_FILE: 'split1_rows_to_add.csv',
  /** Uniware item types already looked up (under INTRANSIT_DIR/cache), reused for CACHE_DAYS. */
  CACHE_FILE: 'uniware_item_types.json',
  CACHE_DAYS: 30,
  /** Uniware lookups at a time. */
  PARALLEL: 4,
} as const;

/** Adding flagged combos to Split1.csv from the page (user, 2026-10-19). */
export const SPLIT1 = {
  FILE: 'Split1.csv',
  /** The parent (combo) column; the component column is "Split SKU". */
  PARENT_COLUMN: 'SKU Code',
  /** Most units of one component in a combo. */
  MAX_QTY: 50,
} as const;

/** Mapping combo variants to their base combo from the page (user, 2026-10-19). */
export const FINAL_SKU_MAP = {
  FILE: 'Final SKU Mapping.csv',
  LISTING_COLUMN: 'Listing_SKU',
} as const;

/**
 * A combo variant's suffix: CMB47B2b / SCMB112_S / CMB47_WB / SCMB37_C are packs of CMB47 / SCMB112 / CMB47 / SCMB37.
 * Uniware stores such a variant as a single item; its base code is the bundle with the components.
 */
export const COMBO_VARIANT_SUFFIX_RE = /(?:_s|b2b|_wb|_c)$/i;


/** Largest upload accepted for one input file. */
export const INTRANSIT_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
