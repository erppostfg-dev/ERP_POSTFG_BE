/*
 * PEPIMS -> POST_FG import + sync (2026-11-16, user; plan in PROJECT_STATUS "NEW 2026-11-16", analysis in PROJECT_HISTORY
 * "PEPIMS + dev -> prod"). PEPIMS (mcaff_inv) is only READ (START TRANSACTION READ ONLY, own connection). Its POs keep their
 * PEPIMS uid; text is cleaned through the lists below; anything not matched keeps its text and is listed in the report.
 * The user's decisions: only POST_FG channels are final; PEPIMS names that are not ours go under Bulk Marketing / Bulk
 * Institutional / Others with the original name in partyName; PEPIMS values win for a PO in both.
 */

/** PEPIMS's tables read by the import (the database comes from env PEPIMS_SYNC_SOURCE_DB, default mcaff_inv). */
export const PEPIMS_PO_TABLES = { PO: 'shipment_orders', LINES: 'sku_orders', LOGS: 'logs', USERS: 'users' } as const;

/** POs per batch (one read of POs + their lines + logs, one write transaction). */
export const PEPIMS_SYNC_BATCH = 500;

/** app_state key of the watermarks (PEPIMS updatedAt / log id already taken), so a re-run reads only what changed. */
export const PEPIMS_SYNC_STATE_KEY = 'pepims-sync:state';
/** app_state key of the last server run (timer / button): when, by whom, result. */
export const PEPIMS_SYNC_RUN_KEY = 'pepims-sync:last-run';

/*
 * Admin > Data sync (2026-11-17, user: "every night ~1 AM IST until I say; a tab in Admin for developers with the
 * buttons; ONE WAY: PEPIMS -> prod and dev -> prod, never back into PEPIMS or dev"). Two jobs on the prod server, one at
 * a time; the nightly run does PEPIMS first (dev POs are matched to PEPIMS's), then dev.
 */
export const DATA_SYNC_JOB = { PEPIMS: 'pepims', DEV_COPY: 'devCopy' } as const;
export type DataSyncJob = (typeof DATA_SYNC_JOB)[keyof typeof DATA_SYNC_JOB];
export const DATA_SYNC = {
  ROUTES: { STATUS: '/data-sync', PEPIMS: '/data-sync/pepims', DEV_COPY: '/data-sync/dev-copy', NIGHTLY: '/data-sync/nightly' },
  /** app_state keys of each job's last run (the PEPIMS one kept from the first version). */
  RUN_KEY: { pepims: PEPIMS_SYNC_RUN_KEY, devCopy: 'dev-copy:last-run' } as Record<DataSyncJob, string>,
  /** app_state key of the nightly switch + the IST day it last ran. No row = ON (user: "until I say"). */
  NIGHTLY_KEY: 'data-sync:nightly',
  /** IST start of the nightly run; a server that was down then catches up until END_HOUR the same night, else next night. */
  NIGHTLY_IST: { HOUR: 1, MINUTE: 0, END_HOUR: 7 },
  IST_OFFSET_MINUTES: 330,
  CHECK_EVERY_MS: 60_000,
  BY_NIGHTLY: 'nightly',
  BODY: { ENABLED: 'enabled' },
} as const;

/** A date outside this range is junk in PEPIMS (1900-01-03, 2152-11-25 ...): saved empty and listed. */
export const PEPIMS_DATE_RANGE = { MIN: '2025-01-01', MAX: '2027-12-31' } as const;

/** PEPIMS spellings of OUR channels (user: "put the channel names into our format"); the original goes into History. */
export const PEPIMS_CHANNEL_RENAMES: Record<string, string> = {
  'Flipkart Q-Comm': 'Flipkart Qcom',
  'Amazon RK World': 'AMAZON RK WORLD',
  FirstCry: 'Firstcry',
  'Purplle Sor': 'Purplle SOR',
  'Octavos Enterprise': 'OCTAVOS ENTERPRISE',
  'Myntra OR': 'Myntra-OR',
  'Reliance Retail(tira)': 'Reliance Retail(Tira)',
  'TATA 1 MG': 'Tata 1MG',
  'Noble chemist': 'NOBLE CHEMIST',
  'First Club': 'FIRST CLUB',
  Slikk: 'SLIKK',
  'POP Tech': 'POP TECH',
  Savr: 'SAVR',
  'Reet varieties': 'REET VARIETIES',
};

/**
 * PEPIMS "channel" names that are buyers, by group (the user's Downloads/pepims_grps.xlsx, 2026-11-16, + the near names
 * the user put in Institutional). Compared after pepimsNameKey (case, spaces, broken characters ignored).
 */
export const PEPIMS_INSTITUTIONAL_NAMES: readonly string[] = [
  'PRINTSTOP INDIA PRIVATE LIMITED', 'Unique Gift', 'Beautiful', 'Neelam', 'Sambhvani| Dineshkumar Laxmanbhai', 'INVEXA CAPITAL LLP',
  'Singularity', 'Sansa Advisors LLP', 'Aditi Associates', 'DE ECOM', 'Shriya', 'Sonoclinic Diagnostic Centre', 'Happy Heap',
  'Bawa Medical Mart', 'Raghav Enterprises', 'HARMONY LIFESCIENCES', 'SKINTOSKIN LLP', 'Sood Trading Company', 'Printstop India', 'Glitz',
  'Hi7 Ventures LLP', 'Sembark Tech Private Limited', 'HuntingCube Rercuitment Solutions Pvt td', 'Sukhdev', 'Protectt.ai Labs Pvt. Ltd',
  'Nilesh Kothari', 'Shipla Pandya', 'Deepak', 'Vidhi', 'Shalin', 'MEGHA GEMS', 'Wholesome Marketing', 'PK MAGIC FANTASY', 'Tannu Enterprises',
  'Avati Retail', 'BRANDLOOM', 'ALL ABOUT BRANDS', 'Genie Exports', 'Mohit Jain', 'Vishnu Khandelwal', 'SYNERGY ENTERPRISE', 'Cookie Cutter',
  'Glam & Glow', 'ZENZUKI LLP', 'RAJENDRA MARKETING', 'PANOPLIE CAART INDIA PRIVATE LIMITED', 'LUXERAA LABLES LLP', 'Jai Ambe Enterprises',
  'KCP SOLUTIONS', 'Chhitar Lal Jat', 'SADHANA PROACTIVE CLINIC', 'Rashid Ansari', 'Folkbella Private Limited',
  // near names (user 2026-11-16: "yes")
  'Neelam Suri | 01-07-26', 'Singularity AMC LLP', 'DE_ECOM',
];
export const PEPIMS_MARKETING_NAMES: readonly string[] = ['Jiya', 'Ishan Gupta', 'Nykaa Marketing', 'Tira Marketing', 'Parag Qc', 'Legend of Toys Marketing'];
/** Internal names that are not one of our warehouse channels (user: Internal Transfer; channel Others + partyName). */
export const PEPIMS_INTERNAL_TRANSFER_NAMES: readonly string[] = ['Warehouse', 'Mumbai HO', 'Consumption'];
/** Not imported at all (user: "skip"). */
export const PEPIMS_SKIP_CHANNELS: readonly string[] = ['TestPO'];

/**
 * PEPIMS facility spellings that are not exactly a master_facilities code -> our code. Case matters (capitals = main
 * warehouse, small = its child): only the user's answers / one-candidate typos are here. Not listed (Delhi Bijwasan:
 * user "keep it") = text kept, no facility link, listed in the report.
 */
export const PEPIMS_FACILITY_FIXES: Record<string, string> = {
  GGN_Warehouse: 'GGN_WAREHOUSE', // user: main
  mum_warehouse2: 'MUM_WAREHOUSE2', // user: main
  hyp_b2b_mum2: 'HYP_B2B_MUM2',
  Mcaff_Gurgaon3: 'mCaff_Gurgaon3',
  Mcaff_Gurgaon2: 'mCaff_Gurgaon2',
  mCaff_Nagpur: 'Mcaff_Nagpur',
  'mCaff_ Ahmedabad': 'mCaff_Ahmedabad',
  Mcaff_Kolkata2: 'mCaff_Kolkata2',
  mcaff_kolkata2: 'mCaff_Kolkata2',
  Mcaff_Kolkata3: 'mCaff_Kolkata3',
  mCaff_lucknow3: 'mCaff_Lucknow3',
  mCaff_lucknow2: 'mCaff_Lucknow2',
  Mcaff_Lucknow2: 'mCaff_Lucknow2',
  Mcaff_Bangalore2: 'mCaff_Bangalore2',
  MCaff_Guwahati: 'mCaff_Guwahati',
  Mcaff_Hyderabad2: 'mCaff_Hyderabad2',
  // child, by the data (user 2026-11-16: "check which one"): the same route used number 2 then; 3 came only later
  mCaff_Kolkata: 'mCaff_Kolkata2', // 14 Feb 2026 McaffeineB2C -> Guwahati (Kolkata2 Jan-Apr; Kolkata3 from Oct)
  Mcaff_Lucknow: 'mCaff_Lucknow2', // 8 Jan 2026 MUM_WAREHOUSE2 -> Mumbai (Lucknow2 2 Jan; Lucknow3 from Aug)
};

/** Status spellings that are not the master's (others are matched ignoring case / spaces to master_shipment_statuses). */
export const PEPIMS_STATUS_FIXES: Record<string, string> = {
  DISPATCHED: 'Dispatched',
  Dispatch: 'Dispatched',
  'Cancelled Shipment- Low value': 'Cancelled Shipment - Low Value',
  'Cancelled Shipment - Low value': 'Cancelled Shipment - Low Value',
};

/** PEPIMS's shipment_orders columns copied to master_purchase_orders (same names) and how each is read. */
export const PEPIMS_FIELD_KIND = { TEXT: 'text', DATE: 'date', INT: 'int', DEC2: 'dec2', DEC3: 'dec3', JSON: 'json' } as const;
export type PepimsFieldKind = (typeof PEPIMS_FIELD_KIND)[keyof typeof PEPIMS_FIELD_KIND];
const T = PEPIMS_FIELD_KIND;
/**
 * The header fields the sync keeps equal (channel, poNumber, poGroup, partyName are the PO's identity: set on import,
 * never moved by the sync; facility / location / transporters carry their links, see the import service).
 */
export const PEPIMS_PO_FIELDS: Readonly<Record<string, PepimsFieldKind>> = {
  entryDate: T.DATE, poDate: T.DATE, facility: T.TEXT, location: T.TEXT, totalUnits: T.INT, brandName: T.TEXT, remarksPlanning: T.TEXT,
  specialRemarksCOPT: T.TEXT, newShipmentReference: T.TEXT, statusActive: T.TEXT, statusPlanning: T.TEXT, statusWarehouse: T.TEXT,
  statusLogistics: T.TEXT, channelInwardingRemarks: T.TEXT, dispatchRemarksLogistics: T.TEXT, dispatchRemarksWarehouse: T.TEXT,
  dispatchDateTentative: T.DATE, workingDatePlanner: T.DATE, rtsDate: T.DATE, dispatchDate: T.DATE, currentAppointmentDate: T.DATE,
  firstAppointmentDateCOPT: T.DATE, noOfBoxes: T.INT, orderNo1: T.TEXT, orderNo2: T.TEXT, orderNo3: T.TEXT, pickListNo: T.TEXT,
  workingTypeWarehouse: T.TEXT, inventoryRemarksWarehouse: T.TEXT, b2bWorkingTeamRemarks: T.TEXT, actualWeight: T.DEC3, volumetricWeight: T.DEC3,
  physicalWeight: T.DEC3, channelType: T.TEXT, firstTransporter: T.TEXT, firstDocketNo: T.TEXT, secondTransporter: T.TEXT, secondDocketNo: T.TEXT,
  thirdTransporter: T.TEXT, thirdDocketNo: T.TEXT, appointmentLetter: T.TEXT, labelsLink: T.TEXT, invoiceDate: T.DATE, invoiceLink: T.TEXT,
  cnLink: T.TEXT, ewayLink: T.TEXT, invoiceValue: T.DEC2, remarksAccountsTeam: T.TEXT, invoiceChallanNumber: T.TEXT, invoiceCheckedBy: T.TEXT,
  tallyCustomerName: T.TEXT, customerCode: T.TEXT, poEntryCount: T.INT, deliveryDate: T.DATE, rescheduleLag: T.INT, finalRemarks: T.TEXT,
  updatedGmv: T.DEC2, firstAppointmentDate: T.DATE, secondAppointmentDate: T.DATE, thirdAppointmentDate: T.DATE, remarkAp1: T.TEXT,
  remarkAp2: T.TEXT, remarkAp3: T.TEXT, allAppointmentDate: T.JSON, appointmentRemarks: T.JSON, deliveryCharges: T.DEC2, halting: T.DEC2,
  unloadingCharges: T.DEC2, dedicatedVehicle: T.DEC2, otherCharges: T.DEC2, document: T.TEXT, proofOfDispatch: T.TEXT, proofOfDelivery: T.TEXT,
  rpk: T.DEC2, poNumbers: T.JSON, deliveryType: T.TEXT, appointmentShootedDate: T.DATE, appointmentRequestedDate: T.DATE,
  remarksWarehouse: T.TEXT, poNumberInwardCWH: T.TEXT,
};
/** sku_orders columns copied to details_purchase_orders (same names). */
export const PEPIMS_LINE_FIELDS: Readonly<Record<string, PepimsFieldKind>> = {
  srNo: T.TEXT, skuName: T.TEXT, skuCode: T.TEXT, channelSkuCode: T.TEXT, qty: T.INT, gmv: T.DEC2, poValue: T.DEC2, accountsWorking: T.TEXT,
  channelInwardingQuantity: T.INT, actualWeight: T.DEC3, updatedQty: T.INT, updatedGmv: T.DEC2, updatedPoValue: T.DEC2, brandName: T.TEXT,
  poNumber: T.TEXT,
};

/** Lost characters (U+FFFD, PEPIMS kept them as such) and non-breaking spaces: read as a space. */
const ODD_SPACE = new RegExp('[\\uFFFD\\u00A0]', 'g');
/** A name as the lists compare it: case, repeated / broken spaces and lost characters ignored. */
export const pepimsNameKey = (v: string | null | undefined): string =>
  (v ?? '').replace(ODD_SPACE, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
/** A buyer name to keep (partyName): lost characters become spaces, trimmed, original case. */
export const pepimsCleanName = (v: string | null | undefined): string | null => {
  const s = (v ?? '').replace(ODD_SPACE, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
};

/*
 * Dev -> prod copy (2026-11-16, step 2b; modules/pepims-sync/dev-copy.service.ts): the team processed POs in dev, so
 * prod gets dev's work. Read from SOURCE_DB on the same server (target = the app's database); order = FK order.
 */
export const DEV_COPY = {
  /** app_state key: the last dev shipment_logs id copied (History rows get new ids, so a re-run copies only newer ones). */
  STATE_KEY: 'dev-copy:state',
  /** Masters the masters team edits on dev: upserted by id (prod's are a copy of dev's with the same ids). */
  MASTER_TABLES: ['master_facilities', 'master_channels', 'master_skus', 'master_channel_skus', 'master_sku_components', 'details_channels'] as readonly string[],
  BULK_TABLES: ['bulk_locations', 'bulk_type_settings', 'bulk_customers', 'bulk_orders', 'bulk_order_lines', 'bulk_order_events', 'bulk_order_documents'] as readonly string[],
  FEEDBACK_TABLES: ['feedback_items', 'feedback_members', 'feedback_comments', 'feedback_images', 'feedback_notifications', 'notices', 'notice_seen'] as readonly string[],
  /** dev's Uniware sync text for a PO marked uploaded whose code Uniware never had. */
  MARKED_NOT_IN_UNIWARE: 'Marked uploaded, not in Uniware',
  /** Start of the History note on a PO whose dev sale order code was not the one used. */
  SALE_CODE_NOTE: 'dev (POST_FG) gave sale order code',
} as const;
