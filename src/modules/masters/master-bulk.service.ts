import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, FK_ONLY_CHANNEL_IDS, MASTER_ADD, MASTER_BULK, MASTER_LOG_TYPE, MasterBulkColumn, MasterBulkMode, MasterLogType, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { appError, AppError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { forgetPoIssues } from '../po-issues/po-issues.cache';
import { Actor, addChannelIn, addChannelLocationIn, addChannelSkuIn, addPepSkuIn, recheckChannel } from './master-add.service';
import { afterEdit, editRowIn, readFormRows, setActiveIn } from './master-edit.service';
import { forgetMasters } from './masters.cache';

/*
 * Masters bulk upload (2026-11-27, user: "a bulk upload in the masters: the format Excel to download, all rows in one go;
 * Add OR Update one at a time; strict about the types; same approvers and uploaders as now; no new table").
 *   - GET format: the columns of the mode (key, label, type, required, rule, example) + the lists the Excel's drop-downs
 *     read (channels, PEP codes ...): the frontend builds the strict Excel from it, so the rules live here only.
 *   - GET current: today's rows in the same columns (Update mode starts from them).
 *   - POST check: every row through the SAME code as the Add / Edit forms, inside a transaction that is rolled back:
 *     nothing saved; per row: new / update / same / error with the changes (old -> new) and every problem.
 *   - POST apply: the same, committed, ALL OR NOTHING (a file with any error row is refused).
 * Approvals stay as today: a new channel SKU / a margin or rate change is a margin request (Approvals page; the approver
 * approves them together with "Approve selected"); other fields are saved at once. History: every row, remark
 * "Bulk upload <file>" (+ the row's own remark). Masters: Channel SKUs, PEP SKUs, Channels, Channel locations (Add +
 * Update) and Warehouses (Update only: no Add form); Transfer Routes keep their own upload.
 */

type Row = Record<string, unknown>;
export interface BulkInput { mode?: unknown; fileName?: unknown; rows?: unknown }
export interface BulkChange { field: string; label: string; old: string; value: string }
export interface BulkPlanRow {
  row: number;
  key: string;
  action: 'new' | 'update' | 'same' | 'error';
  /** Waits on the Approvals page (a new channel SKU, a margin / rate change). */
  needsApproval: boolean;
  changes: BulkChange[];
  errors: string[];
  /** What was filled from our master for an empty cell (Add: product name, brand, MRP, EAN, rate). */
  filled: string[];
}
export interface BulkPlan {
  type: string; mode: MasterBulkMode; fileName: string;
  counts: { rows: number; new: number; update: number; same: number; error: number; needsApproval: number };
  rows: BulkPlanRow[];
}

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v).trim() : '');
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const asNumber = (v: string): number => Number(v.replace(/,/g, ''));
const sameValue = (a: string, b: string): boolean => {
  if (a === b) return true;
  const na = asNumber(a), nb = asNumber(b);
  return a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-9;
};

/** A rollback that carries the dry run's answer out of the transaction. */
class DryRun<T> extends Error { constructor(readonly result: T) { super('dry run'); } }

// ---- the masters it covers -------------------------------------------------------------------------------------

/** The drop-down lists a file can use (only the ones its columns name are sent). */
const LIST_LOADERS: Record<string, () => Promise<string[]>> = {
  channels: async () => (await AppDataSource.query<{ id: number; name: string }[]>(`SELECT id, display_name name FROM ${TABLES.MASTER_CHANNELS} WHERE is_active = 1 ORDER BY display_name`))
    .filter((c) => !FK_ONLY_CHANNEL_IDS.includes(Number(c.id))).map((c) => c.name),
  pepCodes: async () => (await AppDataSource.query<{ code: string }[]>(`SELECT pep_code code FROM ${TABLES.MASTER_SKUS} ORDER BY pep_code`)).map((s) => s.code),
  // exact codes: upper / lower case = main / child warehouse
  facilities: async () => (await AppDataSource.query<{ code: string }[]>(`SELECT code FROM ${TABLES.MASTER_FACILITIES} WHERE is_active = 1 ORDER BY code`)).map((f) => f.code),
  gstRates: () => Promise.resolve([...MASTER_ADD.GST_RATES]),
  states: () => Promise.resolve([...MASTER_ADD.STATES]),
  buyerTypes: () => Promise.resolve([...MASTER_ADD.BUYER_TYPES]),
  appointment: () => Promise.resolve([...MASTER_ADD.APPOINTMENT]),
  channelTypes: () => Promise.resolve([...MASTER_ADD.CHANNEL_TYPES]),
};
type Lists = Record<string, string[]>;
/** The text formats a column may name (its pattern = the rule in words), checked per cell like the forms do. */
const FORMATS = [MASTER_ADD.EAN, MASTER_ADD.HSN, MASTER_ADD.PIN, MASTER_ADD.GSTIN, MASTER_ADD.SLUG];
/** Lists matched with the exact spelling (warehouse codes); the others ignore upper / lower case. */
const EXACT_LISTS = ['facilities'];

interface AddResult { key: string; needsApproval: boolean; filled: string[]; recheck: string | null }
interface BulkSpec {
  label: string;
  /** Add new: its columns and one row in the caller's transaction (throws on a problem). None = Update only (Warehouses). */
  add?: { columns: MasterBulkColumn[]; keyOf: (row: Row) => string; run: (m: EntityManager, row: Row, ctx: Ctx) => Promise<AddResult> };
  update: MasterBulkColumn[];
  /** Read-only key columns of the update file -> the DB column readFormRows gives. */
  keys: Record<string, string>;
  keyOf: (cur: Row) => string;
}
interface Ctx { by: Actor; remark: string; channelIds: Map<string, { id: number; name: string }> }

const T_MAX = MASTER_ADD.TEXT_MAX;
const ID_COL: MasterBulkColumn = { key: 'id', label: 'Row ID', type: 'int', required: true, help: 'From "Download current data". Do not change it: it says which row this is.', example: '1234' };
const ACTIVE_COL: MasterBulkColumn = { key: 'active', label: 'Active', type: 'yesno', required: false, help: 'Yes / No (No = switched off, never deleted). Empty = keep.', example: 'Yes' };
const REMARK_COL: MasterBulkColumn = { key: 'remark', label: 'Remark', type: 'text', max: MASTER_ADD.REMARK_MAX, required: false, help: 'Optional: why (kept in the row\'s History).', example: 'New listing' };
const ro = (key: string, label: string, example: string): MasterBulkColumn => ({ key, label, type: 'text', required: false, readOnly: true, help: 'For your reference only (cannot be changed here: switch the row off and add a new one).', example });
/** The Add columns as Update columns: optional, "Empty = keep". */
const optional = (cols: MasterBulkColumn[]): MasterBulkColumn[] => cols.map((c) => ({ ...c, required: false, help: `${c.help} Empty = keep.` }));
const yes = (v: unknown) => str(v).toLowerCase() === 'yes';

// Channel SKUs
const CHANNEL_SKU_ADD: MasterBulkColumn[] = [
  { key: 'channel', label: 'Channel', type: 'list', list: 'channels', required: true, help: 'One of our channels (from the list).', example: 'Amazon' },
  { key: 'channelCode', label: 'Channel SKU code', type: 'text', max: T_MAX, required: true, help: 'The channel\'s own code for the SKU (Amazon FNSKU / ASIN, Flipkart FSN ...). Must not exist yet for that channel.', example: 'X002OP4L43' },
  { key: 'pepCode', label: 'PEP code', type: 'list', list: 'pepCodes', required: true, help: 'Our SKU code (from the list).', example: 'MCaf383_WB' },
  { key: 'marginPercent', label: 'Margin %', type: 'decimal', min: 0, max: 100, required: true, help: 'Percent of MRP, 0-100 (27.5 = 27.5%).', example: '57' },
  { key: 'rateAfterMargin', label: 'Rate after margin', type: 'decimal', min: 0.01, required: false, help: 'Rupees with GST, not above MRP. Empty = MRP x (1 - Margin %).', example: '214.57' },
  { key: 'mrp', label: 'MRP', type: 'decimal', min: 0.01, required: false, help: 'Rupees. Empty = the PEP SKU\'s MRP.', example: '499' },
  { key: 'productName', label: 'Product name', type: 'text', max: T_MAX, required: false, help: 'Empty = the PEP SKU\'s name.', example: 'Coffee Body Scrub 100g' },
  { key: 'brand', label: 'Brand', type: 'text', max: T_MAX, required: false, help: 'Empty = the PEP SKU\'s brand.', example: 'mCaffeine' },
  { key: 'eanCode', label: 'EAN code', type: 'text', pattern: MASTER_ADD.EAN.rule, required: false, help: `EAN: ${MASTER_ADD.EAN.rule}. Empty = the PEP SKU's EAN.`, example: '8906129570016' },
  REMARK_COL,
];
const CHANNEL_SKU_UPDATE: MasterBulkColumn[] = [
  ID_COL, ro('channel', 'Channel', 'Amazon'), ro('channelCode', 'Channel SKU code', 'X002OP4L43'),
  { key: 'pepCode', label: 'PEP code', type: 'list', list: 'pepCodes', required: false, help: 'Our SKU code (from the list). Empty = keep.', example: 'MCaf383_WB' },
  { key: 'productName', label: 'Product name', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'Coffee Body Scrub 100g' },
  { key: 'brand', label: 'Brand', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'mCaffeine' },
  { key: 'mrp', label: 'MRP', type: 'decimal', min: 0.01, required: false, help: 'Rupees, up to 2 decimals. Empty = keep.', example: '499' },
  { key: 'marginPercent', label: 'Margin %', type: 'decimal', min: 0, max: 100, required: false, help: 'Percent of MRP, 0-100 (27.5 = 27.5%). A change needs approval (2 levels, as today). Empty = keep.', example: '57' },
  { key: 'rateAfterMargin', label: 'Rate after margin', type: 'decimal', min: 0.01, required: false, help: 'Rupees with GST, not above MRP. A change needs approval. Empty = keep.', example: '214.57' },
  { key: 'eanCode', label: 'EAN code', type: 'text', pattern: MASTER_ADD.EAN.rule, required: false, help: `EAN: ${MASTER_ADD.EAN.rule}. Empty = keep.`, example: '8906129570016' },
  ACTIVE_COL, REMARK_COL,
];

// PEP SKUs
const PEP_FIELDS: MasterBulkColumn[] = [
  { key: 'productName', label: 'Product name', type: 'text', max: T_MAX, required: true, help: 'Product name.', example: 'Coffee Body Scrub 100g' },
  { key: 'brand', label: 'Brand', type: 'text', max: T_MAX, required: true, help: 'Brand.', example: 'mCaffeine' },
  { key: 'productType', label: 'Product type', type: 'text', max: T_MAX, required: true, help: 'Product type, spelled as on the PEP SKUs page.', example: 'Single' },
  { key: 'mrp', label: 'MRP', type: 'decimal', min: 0.01, required: true, help: 'Rupees, up to 2 decimals.', example: '499' },
  { key: 'gstTaxType', label: 'GST %', type: 'list', list: 'gstRates', required: true, help: 'GST rate (from the list).', example: '18' },
  { key: 'eanCode', label: 'EAN code', type: 'text', pattern: MASTER_ADD.EAN.rule, required: true, help: `EAN: ${MASTER_ADD.EAN.rule}.`, example: '8906129570016' },
  { key: 'hsnCode', label: 'HSN code', type: 'text', pattern: MASTER_ADD.HSN.rule, required: true, help: `HSN: ${MASTER_ADD.HSN.rule}.`, example: '33049990' },
  { key: 'lengthMm', label: 'Length (mm)', type: 'decimal', min: 0.01, required: true, help: 'Millimetres, above 0.', example: '60' },
  { key: 'widthMm', label: 'Width (mm)', type: 'decimal', min: 0.01, required: true, help: 'Millimetres, above 0.', example: '60' },
  { key: 'heightMm', label: 'Height (mm)', type: 'decimal', min: 0.01, required: true, help: 'Millimetres, above 0.', example: '120' },
  { key: 'weightG', label: 'Weight (g)', type: 'decimal', min: 0.01, required: true, help: 'Grams, above 0.', example: '110' },
  { key: 'shelfLife', label: 'Shelf life (days)', type: 'int', min: 1, max: 3650, required: true, help: 'Whole days, 1-3650.', example: '730' },
];
const PEP_ADD: MasterBulkColumn[] = [
  { key: 'pepCode', label: 'PEP code', type: 'text', max: T_MAX, required: true, help: 'Our SKU code. Must not exist yet.', example: 'MCaf999' },
  ...PEP_FIELDS,
  { ...ACTIVE_COL, required: true, help: 'Yes / No: active from the start?' },
  REMARK_COL,
];
const PEP_UPDATE: MasterBulkColumn[] = [
  ID_COL, ro('pepCode', 'PEP code', 'MCaf383_WB'), ...optional(PEP_FIELDS),
  { key: 'bulkOrderable', label: 'Bulk orders', type: 'yesno', required: false, help: 'Yes / No: shown in the Bulk Orders portal. Empty = keep.', example: 'No' },
  ACTIVE_COL, REMARK_COL,
];

// Channels
const CHANNEL_ADD: MasterBulkColumn[] = [
  { key: 'displayName', label: 'Channel name', type: 'text', max: T_MAX, required: true, help: 'The channel\'s name as shown everywhere. Must not exist yet.', example: 'Tata Cliq' },
  { key: 'slug', label: 'Slug', type: 'text', max: T_MAX, pattern: MASTER_ADD.SLUG.rule, required: true, help: `Short id: ${MASTER_ADD.SLUG.rule}. Must not exist yet.`, example: 'tata-cliq' },
  { key: 'aliases', label: 'Other names', type: 'text', max: T_MAX, required: true, help: 'Other spellings on POs / emails, comma separated (not another channel\'s name).', example: 'TATA CLIQ, TataCliq' },
  { ...ACTIVE_COL, required: true, help: 'Yes / No: active from the start?' },
  REMARK_COL,
];
const CHANNEL_UPDATE: MasterBulkColumn[] = [
  ID_COL, ro('displayName', 'Channel name', 'Amazon'), ro('slug', 'Slug', 'amazon'),
  { key: 'aliases', label: 'Other names', type: 'text', max: T_MAX, required: false, help: 'Other spellings, comma separated (the whole list). Empty = keep.', example: 'AMAZON, Amazon India' },
  { key: 'channelType', label: 'Channel type', type: 'list', list: 'channelTypes', required: false, help: 'B2B / B2C. Empty = keep.', example: 'B2B' },
  { key: 'expiryDaysMin', label: 'Expiry days min', type: 'int', min: MASTER_ADD.EXPIRY_DAYS.min, max: MASTER_ADD.EXPIRY_DAYS.max, required: false, help: 'Whole days, not above max. Empty = keep.', example: '8' },
  { key: 'expiryDaysMax', label: 'Expiry days max', type: 'int', min: MASTER_ADD.EXPIRY_DAYS.min, max: MASTER_ADD.EXPIRY_DAYS.max, required: false, help: 'Whole days. Empty = keep.', example: '12' },
  ACTIVE_COL, REMARK_COL,
];

// Channel locations
const LOCATION_FIELDS: MasterBulkColumn[] = [
  { key: 'uniwareCustomerCode', label: 'Uniware customer code', type: 'text', max: T_MAX, required: true, help: 'The customer code in Uniware.', example: 'CUST0123' },
  { key: 'uniwareChannelCode', label: 'Uniware channel', type: 'text', max: T_MAX, required: true, help: 'The channel code in Uniware.', example: 'CUSTOM_B2B' },
  { key: 'facilityCode', label: 'Warehouse', type: 'list', list: 'facilities', required: true, help: 'Our warehouse code, exact spelling (capitals = main, lower case = child).', example: 'MUM_WAREHOUSE2' },
  { key: 'consigneeName', label: 'Consignee name', type: 'text', max: T_MAX, required: true, help: 'Name on the delivery.', example: 'ABC Retail Pvt Ltd' },
  { key: 'consigneeGstNumber', label: 'Consignee GSTIN', type: 'text', pattern: MASTER_ADD.GSTIN.rule, required: true, help: `GSTIN: ${MASTER_ADD.GSTIN.rule}.`, example: '27AAACI1234A1Z5' },
  { key: 'consigneeState', label: 'Consignee state', type: 'list', list: 'states', required: true, help: 'State (from the list).', example: 'Maharashtra' },
  { key: 'consigneePinCode', label: 'Consignee pincode', type: 'text', pattern: MASTER_ADD.PIN.rule, required: true, help: `Pincode: ${MASTER_ADD.PIN.rule}.`, example: '421302' },
  { key: 'shippingAddress', label: 'Shipping address', type: 'text', max: MASTER_ADD.ADDRESS_MAX, required: true, help: 'Full delivery address.', example: 'Plot 5, Bhiwandi, Thane 421302' },
  { key: 'billingAddress', label: 'Billing address', type: 'text', max: MASTER_ADD.ADDRESS_MAX, required: true, help: 'Full billing address.', example: 'Plot 5, Bhiwandi, Thane 421302' },
  { key: 'buyerType', label: 'Buyer type', type: 'list', list: 'buyerTypes', required: true, help: 'B2B / B2C.', example: 'B2B' },
  { key: 'buyerGstNumber', label: 'Buyer GSTIN', type: 'text', pattern: MASTER_ADD.GSTIN.rule, required: true, help: `GSTIN: ${MASTER_ADD.GSTIN.rule}.`, example: '27AAACI1234A1Z5' },
  { key: 'buyerState', label: 'Buyer state', type: 'list', list: 'states', required: true, help: 'State (from the list).', example: 'Maharashtra' },
  { key: 'buyerPinCode', label: 'Buyer pincode', type: 'text', pattern: MASTER_ADD.PIN.rule, required: true, help: `Pincode: ${MASTER_ADD.PIN.rule}.`, example: '421302' },
  { key: 'tallyLedgerName', label: 'PEP name (Tally ledger)', type: 'text', max: T_MAX, required: true, help: 'Our name for the location (Tally ledger).', example: 'Mumbai BTS' },
  { key: 'appointmentChannel', label: 'Appointment', type: 'list', list: 'appointment', required: true, help: 'Yes / No: delivery needs an appointment.', example: 'Yes' },
];
const LOCATION_ADD: MasterBulkColumn[] = [
  { key: 'channel', label: 'Channel', type: 'list', list: 'channels', required: true, help: 'One of our channels (from the list).', example: 'Flipkart' },
  { key: 'locationCode', label: 'Location code', type: 'text', max: T_MAX, required: true, help: 'The channel\'s code for the delivery location (as on its POs). Must not exist yet for that channel.', example: 'bhi_vas_wh_nl_01nl' },
  ...LOCATION_FIELDS, REMARK_COL,
];
const LOCATION_UPDATE: MasterBulkColumn[] = [
  ID_COL, ro('channel', 'Channel', 'Flipkart'), ro('locationCode', 'Location code', 'bhi_vas_wh_nl_01nl'), ...optional(LOCATION_FIELDS),
  { key: 'city', label: 'City', type: 'text', max: T_MAX, required: false, help: 'City. Empty = keep.', example: 'Bhiwandi' },
  ACTIVE_COL, REMARK_COL,
];

// Warehouses (no Add form: Update only; the in-transit stock and D2C settings stay on the Edit form)
const FACILITY_UPDATE: MasterBulkColumn[] = [
  ID_COL, ro('code', 'Warehouse code', 'MUM_WAREHOUSE2'),
  { key: 'name', label: 'Name', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'Mumbai Warehouse 2' },
  { key: 'entity', label: 'Entity', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'PEP Technologies' },
  { key: 'pickupLocation', label: 'Pickup location', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'Bhiwandi' },
  { key: 'state', label: 'State', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'Maharashtra' },
  { key: 'facilityType', label: 'Warehouse type', type: 'text', max: T_MAX, required: false, help: 'Empty = keep.', example: 'Warehouse' },
  { key: 'billToGstin', label: 'Bill-to GSTIN', type: 'text', pattern: MASTER_ADD.GSTIN.rule, required: false, help: `GSTIN: ${MASTER_ADD.GSTIN.rule}. Empty = keep.`, example: '27AAACI1234A1Z5' },
  { key: 'shipToGstin', label: 'Ship-to GSTIN', type: 'text', pattern: MASTER_ADD.GSTIN.rule, required: false, help: `GSTIN: ${MASTER_ADD.GSTIN.rule}. Empty = keep.`, example: '27AAACI1234A1Z5' },
  { key: 'remarks', label: 'Notes', type: 'text', max: MASTER_ADD.REMARK_MAX, required: false, help: 'The warehouse\'s own notes. Empty = keep.', example: 'Main warehouse' },
  ACTIVE_COL, REMARK_COL,
];

/** Channel name in the file -> the channel for the Add code (an unknown name = a row problem). */
const channelOf = (row: Row, ctx: Ctx) => {
  const ch = ctx.channelIds.get(str(row.channel).toLowerCase());
  if (str(row.channel) && !ch) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'channelId', code: 'FIELD_NOT_FOUND', message: `"${str(row.channel)}" is not one of our channels` }]);
  return ch;
};
/** The file's cells as the Add form's body (text as typed: the Add code checks them) + the bulk remark. */
const bodyOf = (row: Row, cols: MasterBulkColumn[], ctx: Ctx): Row =>
  Object.fromEntries([...cols.filter((c) => c.key !== 'remark').map((c) => [c.key, str(row[c.key])]), ['remark', remarkOf(ctx, row)]]);

const SPECS: Partial<Record<string, BulkSpec>> = {
  [MASTER_LOG_TYPE.CHANNEL_SKU]: {
    label: 'Channel SKUs', update: CHANNEL_SKU_UPDATE, keys: { channel: 'channel_name', channelCode: 'channel_code' },
    keyOf: (r) => `${str(r.channel)} | ${str(r.channelCode)}`,
    add: {
      columns: CHANNEL_SKU_ADD, keyOf: (r) => `${str(r.channel)} | ${str(r.channelCode)}`,
      run: async (m, row, ctx) => {
        const filled: string[] = [];
        const channel = channelOf(row, ctx);
        const pep = str(row.pepCode)
          ? (await m.query<Row[]>(`SELECT pep_code, product_name, brand_name, mrp, ean_code FROM ${TABLES.MASTER_SKUS} WHERE LOWER(pep_code) = LOWER(?) LIMIT 1`, [str(row.pepCode)]))[0]
          : undefined;
        // empty optional cells come from our PEP SKU (said in the preview)
        const fill = (key: string, label: string, from: unknown) => {
          if (str(row[key]) || from === null || from === undefined || str(from) === '') return str(row[key]);
          filled.push(`${label} = ${str(from)} (from the PEP SKU)`);
          return str(from);
        };
        const productName = fill('productName', 'Product name', pep?.product_name);
        const brand = fill('brand', 'Brand', pep?.brand_name);
        const mrp = fill('mrp', 'MRP', pep?.mrp === null || pep?.mrp === undefined ? null : Number(pep.mrp));
        const eanCode = fill('eanCode', 'EAN code', pep?.ean_code);
        let rate = str(row.rateAfterMargin);
        const margin = str(row.marginPercent);
        if (!rate && mrp && margin && Number.isFinite(asNumber(mrp)) && Number.isFinite(asNumber(margin))) {
          rate = String(round(asNumber(mrp) * (1 - asNumber(margin) / 100), 2));
          filled.push(`Rate after margin = ${rate} (MRP x (1 - Margin %))`);
        }
        await addChannelSkuIn(m, {
          channelId: channel?.id ?? '', channelCode: str(row.channelCode), pepCode: str(row.pepCode),
          productName, brand, mrp, marginPercent: margin, rateAfterMargin: rate, eanCode, remark: remarkOf(ctx, row),
        }, ctx.by);
        return { key: `${channel?.name ?? str(row.channel)} | ${str(row.channelCode)}`, needsApproval: true, filled, recheck: null };
      },
    },
  },
  [MASTER_LOG_TYPE.PEP_SKU]: {
    label: 'PEP SKUs', update: PEP_UPDATE, keys: { pepCode: 'pep_code' }, keyOf: (r) => str(r.pepCode),
    add: {
      columns: PEP_ADD, keyOf: (r) => str(r.pepCode),
      run: async (m, row, ctx) => {
        const r = await addPepSkuIn(m, { ...bodyOf(row, PEP_ADD, ctx), isActive: str(row.active) ? yes(row.active) : undefined }, ctx.by);
        return { key: str(r.pepCode), needsApproval: false, filled: [], recheck: null };
      },
    },
  },
  [MASTER_LOG_TYPE.CHANNEL]: {
    label: 'Channels', update: CHANNEL_UPDATE, keys: { displayName: 'display_name', slug: 'slug' }, keyOf: (r) => str(r.displayName),
    add: {
      columns: CHANNEL_ADD, keyOf: (r) => str(r.displayName),
      run: async (m, row, ctx) => {
        const r = await addChannelIn(m, { ...bodyOf(row, CHANNEL_ADD, ctx), isActive: str(row.active) ? yes(row.active) : undefined }, ctx.by);
        return { key: str(r.displayName), needsApproval: false, filled: [], recheck: null };
      },
    },
  },
  [MASTER_LOG_TYPE.LOCATION]: {
    label: 'Channel locations', update: LOCATION_UPDATE, keys: { channel: 'channel_name', locationCode: 'channel_location_code' },
    keyOf: (r) => `${str(r.channel)} | ${str(r.locationCode)}`,
    add: {
      columns: LOCATION_ADD, keyOf: (r) => `${str(r.channel)} | ${str(r.locationCode)}`,
      run: async (m, row, ctx) => {
        const channel = channelOf(row, ctx);
        const r = await addChannelLocationIn(m, { ...bodyOf(row, LOCATION_ADD, ctx), channelId: channel?.id ?? '' }, ctx.by);
        return { key: `${r.channel} | ${str(row.locationCode)}`, needsApproval: false, filled: [], recheck: r.channel };
      },
    },
  },
  [MASTER_LOG_TYPE.FACILITY]: {
    label: 'Warehouses', update: FACILITY_UPDATE, keys: { code: 'code' }, keyOf: (r) => str(r.code),
  },
};

const remarkOf = (ctx: Ctx, row: Row): string => {
  const own = str(row.remark);
  return `${ctx.remark}${own ? `: ${own}` : ''}`.slice(0, MASTER_ADD.REMARK_MAX);
};

const specOf = (type: unknown): { type: string; spec: BulkSpec } => {
  const t = typeof type === 'string' ? type : '';
  const spec = SPECS[t];
  if (!spec) throw appError(ERROR_CODES.MASTER_BULK_NOT_SUPPORTED, t, Object.keys(SPECS).join(', '));
  return { type: t, spec };
};

const modeOf = (v: unknown, spec: BulkSpec): MasterBulkMode => {
  if ((v === 'add' && spec.add) || v === 'update') return v;
  const allowed = spec.add ? 'add or update' : 'update (this master has no Add)';
  throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'mode', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `mode: ${allowed}` }]);
};

const columnsOf = (spec: BulkSpec, mode: MasterBulkMode): MasterBulkColumn[] => (mode === 'add' ? spec.add?.columns ?? [] : spec.update);

/** A DB value as a cell: decimals without trailing zeros ("499.00" -> "499"), Yes / No, '' for empty. */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? MASTER_BULK.YES_NO[0] : MASTER_BULK.YES_NO[1];
  const s = str(v);
  return /^-?\d+\.\d+$/.test(s) ? String(Number(s)) : s;
};

/** Today's rows in the Update columns (the Edit form's units: margin as a percent, Yes / No ...). */
const currentRows = async (m: EntityManager | typeof AppDataSource, type: string, spec: BulkSpec, ids?: string[]): Promise<Row[]> =>
  (await readFormRows(m, type as MasterLogType, ids)).map((r) => Object.fromEntries(spec.update.map((c) => {
    if (c.key === 'active') return [c.key, cell(r.is_active)];
    if (c.key === 'remark') return [c.key, ''];
    if (c.key in spec.keys) return [c.key, cell(r[spec.keys[c.key]])];
    return [c.key, cell(r[c.key])];
  })));

/** The lists the master's columns name (both modes), nothing more. */
const lists = async (spec: BulkSpec): Promise<Lists> => {
  const names = [...new Set([...(spec.add?.columns ?? []), ...spec.update].map((c) => c.list).filter((x): x is string => !!x))];
  return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await LIST_LOADERS[n]()] as const)));
};

/** GET /masters/bulk/:type/format: both modes' columns, the drop-down lists, the row limit. */
export const bulkFormat = async (type: unknown) => {
  const { type: t, spec } = specOf(type);
  // columns.add absent = Update only (Warehouses)
  const columns = { ...(spec.add ? { add: spec.add.columns } : {}), update: spec.update };
  return { type: t, label: spec.label, modes: spec.add ? ['add', 'update'] : ['update'], columns, lists: await lists(spec), maxRows: MASTER_BULK.MAX_ROWS, yesNo: MASTER_BULK.YES_NO };
};

/** GET /masters/bulk/:type/current: every row in the Update columns (the starting file of an update). */
export const bulkCurrent = async (type: unknown) => {
  const { type: t, spec } = specOf(type);
  return { type: t, columns: spec.update, rows: await currentRows(AppDataSource, t, spec) };
};

/** A problem as people read it: the column's label and the message. */
const problemsOf = (err: unknown, columns: MasterBulkColumn[]): string[] => {
  if (err instanceof AppError) {
    const details = Array.isArray(err.details) ? (err.details as { field?: string; message?: string }[]) : [];
    // the Add form's field names -> this file's column labels (channelId = the Channel column, isActive = Active)
    const alias: Record<string, string> = { channelId: 'channel', isActive: 'active', locationCode: 'locationCode' };
    const labelOf = (f?: string) => columns.find((c) => c.key === f || (f !== undefined && alias[f] === c.key))?.label ?? f ?? '';
    if (details.length) return details.map((d) => `${labelOf(d.field)}: ${d.message ?? ''}`.replace(/^: /, ''));
    return [err.message];
  }
  throw err; // a real failure (DB down ...): not a row problem
};

/**
 * Cell checks the Excel also does (type, required, range, list), so a pasted cell is caught with the row number.
 * cur (Update): a cell still holding today's value is not checked (an old spelling already stored is not this file's problem).
 */
const cellProblems = (row: Row, columns: MasterBulkColumn[], mode: MasterBulkMode, l: Lists, cur?: Row): string[] => {
  const out: string[] = [];
  for (const c of columns) {
    const v = str(row[c.key]);
    if (cur && v && c.key !== 'id' && sameValue(v.toLowerCase(), str(cur[c.key]).toLowerCase())) continue;
    if (!v) {
      if (c.required && !(mode === 'update' && c.readOnly)) out.push(`${c.label}: required`);
      continue;
    }
    if (c.readOnly) continue;
    if ((c.type === 'decimal' || c.type === 'int') && !Number.isFinite(asNumber(v))) { out.push(`${c.label}: "${v}" is not a number`); continue; }
    if (c.type === 'int' && !Number.isInteger(asNumber(v))) out.push(`${c.label}: "${v}" is not a whole number`);
    if (c.type === 'decimal' && (c.min !== undefined && asNumber(v) < c.min || c.max !== undefined && asNumber(v) > c.max)) out.push(`${c.label}: ${v} is outside ${c.min ?? ''}-${c.max ?? ''}`);
    if (c.type === 'yesno' && !MASTER_BULK.YES_NO.some((y) => y.toLowerCase() === v.toLowerCase())) out.push(`${c.label}: Yes or No`);
    if (c.max && v.length > c.max) out.push(`${c.label}: at most ${c.max} characters`);
    const format = c.pattern ? FORMATS.find((f) => f.rule === c.pattern) : undefined;
    if (format && !format.re.test(format === MASTER_ADD.GSTIN ? v.toUpperCase() : v)) out.push(`${c.label}: ${format.rule}`);
    if (c.type === 'list' && c.list) {
      const exact = EXACT_LISTS.includes(c.list);
      if (!(l[c.list] ?? []).some((x) => (exact ? x === v : x.toLowerCase() === v.toLowerCase()))) out.push(`${c.label}: "${v}" is not in the list${exact ? ' (exact spelling)' : ''}`);
    }
  }
  return out;
};

const rowsOf = (input: BulkInput): Row[] => {
  if (!Array.isArray(input.rows) || !input.rows.length) {
    throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'rows', code: ERROR_CODES.FIELD_REQUIRED, message: 'the file has no rows' }]);
  }
  if (input.rows.length > MASTER_BULK.MAX_ROWS) throw appError(ERROR_CODES.MASTER_BULK_TOO_MANY, input.rows.length, MASTER_BULK.MAX_ROWS);
  return input.rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Row) : {}));
};

/** Every row through the Add / Edit code in `m`; the plan, and the channels whose POs to re-check. */
const runRows = async (m: EntityManager, type: string, spec: BulkSpec, mode: MasterBulkMode, fileName: string, rows: Row[], by: Actor) => {
  const columns = columnsOf(spec, mode);
  const l = await lists(spec);
  const channelRows = await m.query<{ id: number; name: string }[]>(`SELECT id, display_name name FROM ${TABLES.MASTER_CHANNELS}`);
  const ctx: Ctx = { by, remark: `${MASTER_BULK.REMARK_PREFIX} ${fileName}`.slice(0, 300), channelIds: new Map(channelRows.map((c) => [c.name.toLowerCase(), { id: Number(c.id), name: c.name }])) };
  const plan: BulkPlanRow[] = [];
  const recheck = new Set<string>();
  let recheckAll = false;
  const currentById = mode === 'update'
    ? new Map((await currentRows(m, type, spec, [...new Set(rows.map((r) => str(r.id)).filter((x) => /^\d{1,18}$/.test(x)))])).map((r) => [String(r.id), r]))
    : new Map<string, Row>();
  // a row in the file twice: every copy is refused (which one is meant?)
  const idCount = new Map<string, number>();
  for (const r of rows) idCount.set(str(r.id), (idCount.get(str(r.id)) ?? 0) + 1);
  for (const [i, row] of rows.entries()) {
    // _row = the row's number in the person's Excel (the browser drops empty rows); else its place in the list
    const n = Number.isInteger(Number(row._row)) && Number(row._row) > 1 ? Number(row._row) : i + MASTER_BULK.FIRST_DATA_ROW;
    const out: BulkPlanRow = { row: n, key: '', action: 'error', needsApproval: false, changes: [], errors: mode === 'add' ? cellProblems(row, columns, mode, l) : [], filled: [] };
    plan.push(out);
    try {
      if (mode === 'add' && spec.add) {
        out.key = spec.add.keyOf(row);
        if (out.errors.length) continue;
        const r = await spec.add.run(m, row, ctx);
        Object.assign(out, { key: r.key, action: 'new', needsApproval: r.needsApproval, filled: r.filled });
        if (r.recheck) recheck.add(r.recheck);
        continue;
      }
      const id = str(row.id);
      const cur = currentById.get(id);
      out.key = cur ? spec.keyOf(cur) : `Row ID ${id}`;
      if (!cur) { out.errors.push(`Row ID ${id || '(empty)'}: no such row (download the current data again)`); continue; }
      out.errors.push(...cellProblems(row, columns, mode, l, cur));
      if ((idCount.get(id) ?? 0) > 1) { out.errors.push(`Row ID ${id}: twice in the file (keep one row per Row ID)`); continue; }
      for (const c of columns.filter((x) => x.readOnly && str(row[x.key]) && !sameValue(str(row[x.key]).toLowerCase(), str(cur[x.key]).toLowerCase()))) {
        out.errors.push(`${c.label}: cannot be changed here (is "${str(cur[c.key])}")`);
      }
      if (out.errors.length) continue;
      // only cells that are filled AND differ: an empty cell keeps the value
      const editable = columns.filter((c) => !c.readOnly && c.key !== 'id' && c.key !== 'remark' && c.key !== 'active');
      const changes: Row = {};
      for (const c of editable) {
        const v = str(row[c.key]);
        if (v && !sameValue(v, str(cur[c.key]))) {
          changes[c.key] = c.type === 'decimal' ? asNumber(v) : v;
          out.changes.push({ field: c.key, label: c.label, old: str(cur[c.key]), value: v });
        }
      }
      if (Object.keys(changes).length) {
        const r = await editRowIn(m, type, id, { changes, remark: remarkOf(ctx, row) }, by);
        if (r.marginRequestId) out.needsApproval = true;
        // null = every channel (a PEP SKU / warehouse change)
        if (r.changed.length) { if (r.channels === null) recheckAll = true; else for (const ch of r.channels) recheck.add(ch); }
      }
      const act = str(row.active);
      if (act && act.toLowerCase() !== str(cur.active).toLowerCase()) {
        const on = act.toLowerCase() === 'yes';
        const r = await setActiveIn(m, type as MasterLogType, id, on, remarkOf(ctx, row), by);
        out.changes.push({ field: 'active', label: 'Active', old: str(cur.active), value: on ? 'Yes' : 'No' });
        if (on && r.changed) { if (r.channels === null) recheckAll = true; else for (const ch of r.channels) recheck.add(ch); }
      }
      out.action = out.changes.length ? 'update' : 'same';
    } catch (err) {
      out.errors.push(...problemsOf(err, columns));
    }
  }
  for (const p of plan) if (p.errors.length) p.action = 'error';
  const count = (a: BulkPlanRow['action']) => plan.filter((p) => p.action === a).length;
  const result: BulkPlan = {
    type, mode, fileName,
    counts: { rows: plan.length, new: count('new'), update: count('update'), same: count('same'), error: count('error'), needsApproval: plan.filter((p) => p.needsApproval).length },
    rows: plan,
  };
  return { result, recheck: [...recheck], recheckAll };
};

const parse = (type: unknown, input: BulkInput) => {
  const { type: t, spec } = specOf(type);
  const mode = modeOf(input.mode, spec);
  const fileName = str(input.fileName).slice(0, 200) || MASTER_BULK.DEFAULT_FILE;
  return { t, spec, mode, fileName, rows: rowsOf(input) };
};

/** POST /masters/bulk/:type/check: the plan; nothing is saved (the transaction is rolled back). */
export const bulkCheck = async (type: unknown, input: BulkInput, by: Actor): Promise<BulkPlan> => {
  const { t, spec, mode, fileName, rows } = parse(type, input);
  try {
    await AppDataSource.transaction(async (m) => {
      const { result } = await runRows(m, t, spec, mode, fileName, rows, by);
      throw new DryRun(result);
    });
  } catch (err) {
    if (err instanceof DryRun) return err.result as BulkPlan;
    throw err;
  }
  throw new Error('bulk check: no result');
};

/** POST /masters/bulk/:type/apply: the same, saved ALL OR NOTHING; 422 MASTER_BULK_HAS_ERRORS with the plan otherwise. */
export const bulkApply = async (type: unknown, input: BulkInput, by: Actor): Promise<BulkPlan> => {
  const { t, spec, mode, fileName, rows } = parse(type, input);
  const done = await AppDataSource.transaction(async (m) => {
    const r = await runRows(m, t, spec, mode, fileName, rows, by);
    if (r.result.counts.error) throw appError(ERROR_CODES.MASTER_BULK_HAS_ERRORS, r.result.counts.error).withDetails(r.result);
    return r;
  });
  // once committed: the lists, "still a problem?", and the POs in review of the channels a change may fix
  await forgetMasters();
  forgetPoIssues();
  if (done.recheckAll) afterEdit({ changed: ['bulk'], channels: null }); // every channel's POs in review
  else for (const ch of done.recheck) recheckChannel(ch);
  const c = done.result.counts;
  log.info(LOG_SOURCE.APP, `[masters] ${by.email} bulk ${mode} ${t} "${fileName}": ${c.rows} rows, ${c.new} new, ${c.update} updated, ${c.same} same, ${c.needsApproval} waiting for approval`);
  return done.result;
};
