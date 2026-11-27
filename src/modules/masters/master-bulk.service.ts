import { EntityManager } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { ERROR_CODES, FK_ONLY_CHANNEL_IDS, MASTER_ADD, MASTER_BULK, MASTER_LOG_TYPE, MasterBulkColumn, MasterBulkMode, MasterLogType, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { appError, AppError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { forgetPoIssues } from '../po-issues/po-issues.cache';
import { Actor, addChannelSkuIn, recheckChannel } from './master-add.service';
import { editRowIn, setActiveIn } from './master-edit.service';
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
 * "Bulk upload <file>" (+ the row's own remark). Channel SKUs first; the other masters use the same engine next.
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

interface Lists { channels: string[]; pepCodes: string[] }

interface BulkSpec {
  label: string;
  columns: Record<MasterBulkMode, MasterBulkColumn[]>;
  /** Today's rows in the Update columns (form units: margin as a percent). */
  current: (m: EntityManager | typeof AppDataSource, ids?: string[]) => Promise<Row[]>;
  /** One Add row, in the caller's transaction: what was filled, approval or not, the row's key. Throws on a problem. */
  add: (m: EntityManager, row: Row, ctx: Ctx) => Promise<{ key: string; needsApproval: boolean; filled: string[]; channel: string | null }>;
}

interface Ctx { by: Actor; remark: string; channelIds: Map<string, { id: number; name: string }> }

const CHANNEL_SKU_UPDATE: MasterBulkColumn[] = [
  { key: 'id', label: 'Row ID', type: 'int', required: true, help: 'From "Download current data". Do not change it: it says which row this is.', example: '1234' },
  { key: 'channel', label: 'Channel', type: 'text', required: false, readOnly: true, help: 'For your reference only (cannot be changed here).', example: 'Amazon' },
  { key: 'channelCode', label: 'Channel SKU code', type: 'text', required: false, readOnly: true, help: 'For your reference only (cannot be changed: switch the row off and add a new one).', example: 'X002OP4L43' },
  { key: 'pepCode', label: 'PEP code', type: 'list', list: 'pepCodes', required: false, help: 'Our SKU code (from the list). Empty = keep.', example: 'MCaf383_WB' },
  { key: 'productName', label: 'Product name', type: 'text', max: MASTER_ADD.TEXT_MAX, required: false, help: 'Empty = keep.', example: 'Coffee Body Scrub 100g' },
  { key: 'brand', label: 'Brand', type: 'text', max: MASTER_ADD.TEXT_MAX, required: false, help: 'Empty = keep.', example: 'mCaffeine' },
  { key: 'mrp', label: 'MRP', type: 'decimal', min: 0.01, required: false, help: 'Rupees, up to 2 decimals. Empty = keep.', example: '499' },
  { key: 'marginPercent', label: 'Margin %', type: 'decimal', min: 0, max: 100, required: false, help: 'Percent of MRP, 0-100 (27.5 = 27.5%). A change needs approval (2 levels, as today). Empty = keep.', example: '57' },
  { key: 'rateAfterMargin', label: 'Rate after margin', type: 'decimal', min: 0.01, required: false, help: 'Rupees with GST, not above MRP. A change needs approval. Empty = keep.', example: '214.57' },
  { key: 'eanCode', label: 'EAN code', type: 'text', pattern: MASTER_ADD.EAN.rule, required: false, help: `EAN: ${MASTER_ADD.EAN.rule}. Empty = keep.`, example: '8906129570016' },
  { key: 'active', label: 'Active', type: 'yesno', required: false, help: 'Yes / No (No = switched off, never deleted). Empty = keep.', example: 'Yes' },
  { key: 'remark', label: 'Remark', type: 'text', max: MASTER_ADD.REMARK_MAX, required: false, help: 'Optional: why (kept in the row\'s History).', example: 'Amazon new listing' },
];

const CHANNEL_SKU_ADD: MasterBulkColumn[] = [
  { key: 'channel', label: 'Channel', type: 'list', list: 'channels', required: true, help: 'One of our channels (from the list).', example: 'Amazon' },
  { key: 'channelCode', label: 'Channel SKU code', type: 'text', max: MASTER_ADD.TEXT_MAX, required: true, help: 'The channel\'s own code for the SKU (Amazon FNSKU / ASIN, Flipkart FSN ...). Must not exist yet for that channel.', example: 'X002OP4L43' },
  { key: 'pepCode', label: 'PEP code', type: 'list', list: 'pepCodes', required: true, help: 'Our SKU code (from the list).', example: 'MCaf383_WB' },
  { key: 'marginPercent', label: 'Margin %', type: 'decimal', min: 0, max: 100, required: true, help: 'Percent of MRP, 0-100 (27.5 = 27.5%).', example: '57' },
  { key: 'rateAfterMargin', label: 'Rate after margin', type: 'decimal', min: 0.01, required: false, help: 'Rupees with GST, not above MRP. Empty = MRP x (1 - Margin %).', example: '214.57' },
  { key: 'mrp', label: 'MRP', type: 'decimal', min: 0.01, required: false, help: 'Rupees. Empty = the PEP SKU\'s MRP.', example: '499' },
  { key: 'productName', label: 'Product name', type: 'text', max: MASTER_ADD.TEXT_MAX, required: false, help: 'Empty = the PEP SKU\'s name.', example: 'Coffee Body Scrub 100g' },
  { key: 'brand', label: 'Brand', type: 'text', max: MASTER_ADD.TEXT_MAX, required: false, help: 'Empty = the PEP SKU\'s brand.', example: 'mCaffeine' },
  { key: 'eanCode', label: 'EAN code', type: 'text', pattern: MASTER_ADD.EAN.rule, required: false, help: `EAN: ${MASTER_ADD.EAN.rule}. Empty = the PEP SKU's EAN.`, example: '8906129570016' },
  { key: 'remark', label: 'Remark', type: 'text', max: MASTER_ADD.REMARK_MAX, required: false, help: 'Optional: why (kept in the row\'s History).', example: 'Amazon new listing' },
];

const SPECS: Partial<Record<string, BulkSpec>> = {
  [MASTER_LOG_TYPE.CHANNEL_SKU]: {
    label: 'Channel SKUs',
    columns: { add: CHANNEL_SKU_ADD, update: CHANNEL_SKU_UPDATE },
    current: async (m, ids) => {
      const rows = await m.query<Row[]>(
        `SELECT id, channel_name channel, channel_code channelCode, pep_code pepCode, product_name productName, brand_name brand, mrp,
                margin, rate_after_margin rateAfterMargin, ean_code eanCode, is_active active
           FROM ${TABLES.MASTER_CHANNEL_SKUS}${ids ? ` WHERE id IN (${ids.map(() => '?').join(', ') || 'NULL'})` : ''} ORDER BY channel_name, channel_code`,
        ids ?? [],
      );
      return rows.map((r) => ({
        id: str(r.id), channel: str(r.channel), channelCode: str(r.channelCode), pepCode: str(r.pepCode), productName: str(r.productName),
        brand: str(r.brand), mrp: r.mrp === null ? '' : String(Number(r.mrp)),
        marginPercent: r.margin === null ? '' : String(round(Number(r.margin) * 100, 2)),
        rateAfterMargin: r.rateAfterMargin === null ? '' : String(Number(r.rateAfterMargin)), eanCode: str(r.eanCode),
        active: r.active === null || Number(r.active) === 1 ? 'Yes' : 'No', remark: '',
      }));
    },
    add: async (m, row, ctx) => {
      const filled: string[] = [];
      const channel = ctx.channelIds.get(str(row.channel).toLowerCase());
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
      const body = {
        channelId: channel?.id ?? (str(row.channel) ? -1 : ''), channelCode: str(row.channelCode), pepCode: str(row.pepCode),
        productName, brand, mrp, marginPercent: margin, rateAfterMargin: rate, eanCode, remark: remarkOf(ctx, row),
      };
      if (str(row.channel) && !channel) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'channelId', code: 'FIELD_NOT_FOUND', message: `Channel "${str(row.channel)}" is not one of our channels` }]);
      await addChannelSkuIn(m, body, ctx.by);
      return { key: `${channel?.name ?? str(row.channel)} | ${str(row.channelCode)}`, needsApproval: true, filled, channel: channel?.name ?? null };
    },
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

const modeOf = (v: unknown): MasterBulkMode => {
  if (v === 'add' || v === 'update') return v;
  throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'mode', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: 'mode: add or update' }]);
};

const lists = async (): Promise<Lists> => {
  const [channels, skus] = await Promise.all([
    AppDataSource.query<{ id: number; name: string }[]>(`SELECT id, display_name name FROM ${TABLES.MASTER_CHANNELS} WHERE is_active = 1 ORDER BY display_name`),
    AppDataSource.query<{ code: string }[]>(`SELECT pep_code code FROM ${TABLES.MASTER_SKUS} ORDER BY pep_code`),
  ]);
  return { channels: channels.filter((c) => !FK_ONLY_CHANNEL_IDS.includes(Number(c.id))).map((c) => c.name), pepCodes: skus.map((s) => s.code) };
};

/** GET /masters/bulk/:type/format: both modes' columns, the drop-down lists, the row limit. */
export const bulkFormat = async (type: unknown) => {
  const { type: t, spec } = specOf(type);
  return { type: t, label: spec.label, columns: spec.columns, lists: await lists(), maxRows: MASTER_BULK.MAX_ROWS, yesNo: MASTER_BULK.YES_NO };
};

/** GET /masters/bulk/:type/current: every row in the Update columns (the starting file of an update). */
export const bulkCurrent = async (type: unknown) => {
  const { type: t, spec } = specOf(type);
  return { type: t, columns: spec.columns.update, rows: await spec.current(AppDataSource) };
};

/** A problem as people read it: the column's label and the message. */
const problemsOf = (err: unknown, columns: MasterBulkColumn[]): string[] => {
  if (err instanceof AppError) {
    const details = Array.isArray(err.details) ? (err.details as { field?: string; message?: string }[]) : [];
    // the Add form's field names -> this file's column labels (channelId = the Channel column)
    const labelOf = (f?: string) => columns.find((c) => c.key === f || (f === 'channelId' && c.key === 'channel'))?.label ?? f ?? '';
    if (details.length) return details.map((d) => `${labelOf(d.field)}: ${d.message ?? ''}`.replace(/^: /, ''));
    return [err.message];
  }
  throw err; // a real failure (DB down ...): not a row problem
};

/** Cell checks the Excel also does (type, required, range, list), so a pasted cell is caught with the row number. */
const cellProblems = (row: Row, columns: MasterBulkColumn[], mode: MasterBulkMode, l: Lists): string[] => {
  const out: string[] = [];
  for (const c of columns) {
    const v = str(row[c.key]);
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
    if (c.type === 'list' && c.list && !l[c.list as keyof Lists].some((x) => x.toLowerCase() === v.toLowerCase())) out.push(`${c.label}: "${v}" is not in the list`);
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
  const columns = spec.columns[mode];
  const l = await lists();
  const channelRows = await m.query<{ id: number; name: string }[]>(`SELECT id, display_name name FROM ${TABLES.MASTER_CHANNELS}`);
  const ctx: Ctx = { by, remark: `${MASTER_BULK.REMARK_PREFIX} ${fileName}`.slice(0, 300), channelIds: new Map(channelRows.map((c) => [c.name.toLowerCase(), { id: Number(c.id), name: c.name }])) };
  const plan: BulkPlanRow[] = [];
  const recheck = new Set<string>();
  const currentById = mode === 'update'
    ? new Map((await spec.current(m, [...new Set(rows.map((r) => str(r.id)).filter((x) => /^\d{1,18}$/.test(x)))])).map((r) => [String(r.id), r]))
    : new Map<string, Row>();
  // a row in the file twice: every copy is refused (which one is meant?)
  const idCount = new Map<string, number>();
  for (const r of rows) idCount.set(str(r.id), (idCount.get(str(r.id)) ?? 0) + 1);
  for (const [i, row] of rows.entries()) {
    // _row = the row's number in the person's Excel (the browser drops empty rows); else its place in the list
    const n = Number.isInteger(Number(row._row)) && Number(row._row) > 1 ? Number(row._row) : i + MASTER_BULK.FIRST_DATA_ROW;
    const out: BulkPlanRow = { row: n, key: '', action: 'error', needsApproval: false, changes: [], errors: cellProblems(row, columns, mode, l), filled: [] };
    plan.push(out);
    try {
      if (mode === 'add') {
        out.key = `${str(row.channel)} | ${str(row.channelCode)}`;
        if (out.errors.length) continue;
        const r = await spec.add(m, row, ctx);
        Object.assign(out, { key: r.key, action: 'new', needsApproval: r.needsApproval, filled: r.filled });
        continue;
      }
      const id = str(row.id);
      const cur = currentById.get(id);
      out.key = cur ? `${str(cur.channel)} | ${str(cur.channelCode)}` : `Row ID ${id}`;
      if (!cur) { out.errors.push(`Row ID ${id || '(empty)'}: no such row (download the current data again)`); continue; }
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
        for (const ch of r.channels ?? []) recheck.add(ch);
      }
      const act = str(row.active);
      if (act && act.toLowerCase() !== str(cur.active).toLowerCase()) {
        const on = act.toLowerCase() === 'yes';
        const r = await setActiveIn(m, type as MasterLogType, id, on, remarkOf(ctx, row), by);
        out.changes.push({ field: 'active', label: 'Active', old: str(cur.active), value: on ? 'Yes' : 'No' });
        if (on) for (const ch of r.channels ?? []) recheck.add(ch);
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
  return { result, recheck: [...recheck] };
};

const parse = (type: unknown, input: BulkInput) => {
  const { type: t, spec } = specOf(type);
  const mode = modeOf(input.mode);
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
  for (const ch of done.recheck) recheckChannel(ch);
  const c = done.result.counts;
  log.info(LOG_SOURCE.APP, `[masters] ${by.email} bulk ${mode} ${t} "${fileName}": ${c.rows} rows, ${c.new} new, ${c.update} updated, ${c.same} same, ${c.needsApproval} waiting for approval`);
  return done.result;
};
