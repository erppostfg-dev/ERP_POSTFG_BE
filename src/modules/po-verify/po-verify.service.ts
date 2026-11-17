import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import {
  ChannelName,
  ERROR_CODES,
  IST_OFFSET_MS,
  ISSUE_ACTION,
  ISSUE_FIELDS,
  ISSUE_STATUS,
  ISSUE_TYPE,
  OUR_PRICE_ONLY_CHANNELS,
  PO_ACTIVE_STATUS,
  PO_VERIFY,
  PO_VERIFY_ACTION,
  PO_VERIFY_STATE,
  PoVerifyAction,
  PoVerifyState,
  TABLES,
  UNIWARE_CSV,
  UPLOAD_STATUS,
} from '../../constants';
import { ActivityLog, DetailsPurchaseOrder, MasterChannel, MasterPurchaseOrder, PoIssue, PoIssueAction, PoUpload, PoVerification, PoVerifyChannelSetting, User } from '../../entities';
import { appError } from '../../utils/AppError';
import { openS3File, readS3Json, readS3JsonCached } from '../email-intake/s3-mirror.service';
import { issueKey, originalValues } from '../po-pipeline/po-uploads.service';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { bulkSendBack, isBulkChannel, isBulkUpload } from '../bulk-orders/bulk-process.service';
import { bumpReview } from '../po-review/po-review.live';
import { MasterDataReader, panelMasterFor } from '../po-validation/master-data';
import { validatePo } from '../po-validation/validate-po';

/*
 * PO verification before Uniware (user, 2026-10-22; constants/po-verify.ts). Reads and writes only its own table
 * po_verifications, plus, on a send-back, the same rows a review decision touches (po_uploads status, po_issues, the
 * saved PO's statusActive). The existing review / hand-off code is not changed: routes/po-verify.routes.ts serves this,
 * po-verify.gate.ts locks the CSV until a PO is verified.
 */

export interface Actor {
  id: number;
  email: string;
}

const audit = (by: Actor, what: string) =>
  AppDataSource.getRepository(ActivityLog).insert({
    userId: by.id,
    method: 'AUDIT',
    path: what.slice(0, 255),
    status: 200,
    durationMs: 0,
    createdOn: new Date(Date.now() + IST_OFFSET_MS),
  });

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// ---- The switch per channel (Users & Roles -> Settings) ----------------------------------------------------------------

/**
 * A channel name as MySQL compares it (case and outer spaces ignored). The 28 Oct masters renamed some channels only in
 * case ("Gluzo" -> "GLUZO"): their saved switch rows kept the old spelling, MySQL still matched them on save but the
 * exact compares here did not, so the switch showed the default and could not be turned OFF (fixed 2026-10-29).
 */
const channelKey = (name: string) => name.trim().toLowerCase();

/** Channel -> ON / OFF as saved; a channel without a row uses PO_VERIFY_REQUIRED (.env). */
const switches = async (): Promise<(channel: string | null) => boolean> => {
  // Before the PoVerifyChannelSettings migration has run: every channel uses the .env default.
  const rows = await AppDataSource.getRepository(PoVerifyChannelSetting).find().catch((err: { code?: string }) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return [];
    throw err;
  });
  const byChannel = new Map(rows.map((r) => [channelKey(r.channel), r.required]));
  // Bulk orders' sale orders need no Verify step (user 2026-11-12: typed by hand, no OCR): always OFF (optional).
  return (channel) => {
    if (isBulkChannel(channel)) return false;
    return channel !== null && byChannel.has(channelKey(channel)) ? byChannel.get(channelKey(channel))! : env.poVerify.required;
  };
};

export interface VerifyChannelSetting {
  channel: string;
  required: boolean;
  /** true = no row saved yet: the .env default applies. */
  isDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  /** To decide (user: "based on failures"): POs checked and sent back so far, per channel. */
  verified: number;
  sentBack: number;
}

export const listChannelSettings = async (): Promise<{ defaultRequired: boolean; channels: VerifyChannelSetting[] }> => {
  const channels = await AppDataSource.getRepository(MasterChannel).find({ where: { isActive: true }, order: { displayName: 'ASC' } });
  const rows = await AppDataSource.getRepository(PoVerifyChannelSetting).find({ relations: { user: true } });
  const counts = (await AppDataSource.query(
    `SELECT u.channel, v.action, COUNT(*) n FROM ${TABLES.PO_VERIFICATIONS} v JOIN ${TABLES.PO_UPLOADS} u ON u.id = v.upload_id GROUP BY u.channel, v.action`,
  )) as { channel: string | null; action: string; n: string | number }[];
  const count = (channel: string, action: string) =>
    counts.filter((c) => c.channel !== null && channelKey(c.channel) === channelKey(channel) && c.action === action).reduce((n, c) => n + Number(c.n), 0);
  return {
    defaultRequired: env.poVerify.required,
    channels: channels.map((c) => {
      const r = rows.find((x) => channelKey(x.channel) === channelKey(c.displayName));
      return {
        channel: c.displayName,
        required: r ? r.required : env.poVerify.required,
        isDefault: !r,
        updatedBy: r?.user?.name ?? r?.user?.email ?? null,
        updatedAt: r ? r.updatedAt.toISOString() : null,
        verified: count(c.displayName, PO_VERIFY_ACTION.VERIFIED),
        sentBack: count(c.displayName, PO_VERIFY_ACTION.SENT_BACK),
      };
    }),
  };
};

export const updateChannelSetting = async (channel: string, required: boolean, by: Actor): Promise<VerifyChannelSetting> => {
  const known = await AppDataSource.getRepository(MasterChannel).findOneBy({ displayName: channel });
  if (!known) throw appError(ERROR_CODES.VERIFY_CHANNEL_NOT_FOUND, channel);
  const name = known.displayName;
  const repo = AppDataSource.getRepository(PoVerifyChannelSetting);
  // MySQL finds the row whatever its spelling; it takes the channel's current one
  const row = (await repo.findOneBy({ channel: name })) ?? repo.create({ channel: name });
  await repo.save({ ...row, channel: name, required, updatedBy: by.id, updatedAt: new Date() });
  await audit(by, `po verify: ${name} switched ${required ? 'ON' : 'OFF'}`);
  bumpReview();
  return (await listChannelSettings()).channels.find((c) => channelKey(c.channel) === channelKey(name))!;
};

// ---- States (the Processed tab's Verified / To verify badges) ------------------------------------------------------

export interface VerifyStateItem {
  uploadId: string;
  state: PoVerifyState;
  /** This PO's channel has the switch ON. */
  required: boolean;
  by: string | null;
  at: string | null;
  remark: string | null;
}

/** Latest `verified` row of each (upload, current PO). */
const verifiedRows = async (uploads: PoUpload[]): Promise<Map<string, PoVerification>> => {
  const uids = uploads.map((u) => u.poUid).filter((v): v is string => v !== null);
  if (!uids.length) return new Map();
  const rows = await AppDataSource.getRepository(PoVerification).find({
    where: { poUid: In(uids), action: PO_VERIFY_ACTION.VERIFIED },
    order: { id: 'DESC' },
  });
  const out = new Map<string, PoVerification>();
  for (const u of uploads) {
    const r = rows.find((x) => String(x.uploadId) === String(u.id) && String(x.poUid) === String(u.poUid));
    if (r) out.set(String(u.id), r);
  }
  return out;
};

const stateOf = (u: PoUpload, verified: PoVerification | undefined, required: boolean): PoVerifyState =>
  verified ? PO_VERIFY_STATE.VERIFIED
    : u.uniwareUploadedAt ? PO_VERIFY_STATE.NOT_NEEDED
      : required ? PO_VERIFY_STATE.TO_VERIFY : PO_VERIFY_STATE.NOT_REQUIRED;

export const verifyStates = async (ids: string[]): Promise<{ required: boolean; items: VerifyStateItem[] }> =>
  verifyStatesOf(ids.length ? await AppDataSource.getRepository(PoUpload).findBy({ id: In(ids) }) : []);

/**
 * The states of uploads already read (2026-11-03: the Processed list carries them itself, so the screen no longer asks
 * GET /po-verify?uploadIds=<every PO>, whose address grew with every PO). Two small reads: verified rows + who.
 */
export const verifyStatesOf = async (uploads: PoUpload[]): Promise<{ required: boolean; items: VerifyStateItem[] }> => {
  const verified = await verifiedRows(uploads);
  const isOn = await switches();
  const userIds = [...new Set([...verified.values()].map((v) => v.doneBy))];
  const names = new Map(userIds.length ? (await AppDataSource.getRepository(User).findBy({ id: In(userIds) })).map((x) => [x.id, x.name ?? x.email] as const) : []);
  return {
    // The Processed tab shows the Check column when any loaded PO's channel has the switch ON.
    required: uploads.some((u) => isOn(u.channel)),
    items: uploads.map((u) => {
      const v = verified.get(String(u.id));
      const required = isOn(u.channel);
      return { uploadId: String(u.id), state: stateOf(u, v, required), required, by: v ? names.get(v.doneBy) ?? null : null, at: v ? v.doneAt.toISOString() : null, remark: v?.remark ?? null };
    }),
  };
};

/** The ids (of those given) that may go to Uniware: verified, or already marked uploaded. For the gate. */
export const unverifiedIds = async (ids: string[]): Promise<string[]> => {
  const uploads = await AppDataSource.getRepository(PoUpload).findBy({ id: In(ids) });
  const verified = await verifiedRows(uploads);
  const isOn = await switches();
  return uploads.filter((u) => stateOf(u, verified.get(String(u.id)), isOn(u.channel)) === PO_VERIFY_STATE.TO_VERIFY).map((u) => String(u.id));
};

// ---- The side-by-side detail ---------------------------------------------------------------------------------------

export interface VerifyLine {
  lineNo: number;
  /** What is saved and goes to Uniware (the sale order CSV). */
  skuCode: string;
  channelSkuCode: string;
  name: string | null;
  qty: number;
  rate: number;
  value: number;
  /** What the PO says (processed.json); null when the PO has no such line. */
  po: { description: string; qty: number; rate: number | null; /** A PO priced before GST: its unit cost as read (rate = with GST). */ rateBeforeGst: number | null; /** Information only (Myntra STRs): the channel's own price + GST %, not used. */ channelPrice?: number | null; channelGst?: number | null; mrp: number | null; channelSkuCode: string } | null;
  qtyDiffers: boolean;
  rateDiffers: boolean;
}

export interface VerifyDetail {
  uploadId: string;
  poNumber: string | null;
  channel: string | null;
  fileName: string;
  fileType: string | null;
  required: boolean;
  state: PoVerifyState;
  canAct: boolean;
  last: { action: PoVerifyAction; by: string | null; at: string; remark: string | null } | null;
  header: {
    saleOrderCode: string | null;
    poDate: string | null;
    expiryDate: string | null;
    poLocation: string | null;
    customerCode: string | null;
    facilityCode: string | null;
    uniwareChannel: string | null;
  };
  lines: VerifyLine[];
  /**
   * po.value = the PO's own total as processed.json has it; valueBasis says whether that is with GST or before GST (Purplle
   * sends unit costs before GST, 2026-11-03); valueWithGst = the PO with GST worked out as the total check does (the PO's
   * GST, else our master's), the number to compare with saved.value. null when it cannot be worked out.
   */
  totals: {
    po: { lines: number; units: number; value: number; valueBasis: 'with_gst' | 'before_gst'; valueWithGst: number | null };
    /**
     * A channel whose own price is NOT used (Myntra STRs, OUR_PRICE_ONLY_CHANNELS; 2026-11-03): what its PO says (with
     * GST) next to ours, for information; null for the others.
     */
    channelPrice: { value: number | null; note: string } | null;
    saved: { lines: number; units: number; value: number };
  };
  /** processed.json as the OCR / API made it: the panel shows it next to the PO and finds each value on the PO. */
  processed: ProcessedPo;
}

/** Parses the sale order CSV (quoted cells allowed) into rows keyed by its headers. */
const parseCsv = (text: string): Record<string, string>[] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row); }
  const [head, ...body] = rows;
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
};

const readText = async (s3Url: string): Promise<string> => {
  const f = await openS3File(s3Url);
  if (!f) throw appError(ERROR_CODES.PO_FILE_MISSING, s3Url);
  const chunks: Buffer[] = [];
  for await (const c of f.body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

const H = UNIWARE_CSV.HEADERS;
const col = { CODE: H[0], CHANNEL: H[3], SKU: H[6], CHANNEL_SKU: H[7], PRICE: H[8], QTY: H[10], CUSTOMER: H[11], FACILITY: H[12], PO_DATE: H[13] };

const lastAction = async (u: PoUpload) => {
  const [r] = await AppDataSource.getRepository(PoVerification).find({ where: { uploadId: u.id }, order: { id: 'DESC' }, take: 1, relations: { user: true } });
  return r ? { action: r.action, by: r.user?.name ?? r.user?.email ?? null, at: r.doneAt.toISOString(), remark: r.remark } : null;
};

/** A number from processed.json's unmapped text, else null. */
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const verifyDetail = async (uploadId: string): Promise<VerifyDetail> => {
  const u = await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId });
  if (!u) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  if (u.status !== UPLOAD_STATUS.COMPLETED || !u.poUid || !u.uniwareCsvUrl) throw appError(ERROR_CODES.VERIFY_NOT_READY, uploadId, u.status);

  const processedUrl = u.ocrResult?.processed_json;
  // the Verify panel (looks only): processed.json + master data from the shared cache (2026-11-10)
  const po = typeof processedUrl === 'string' ? await readS3JsonCached<ProcessedPo>(processedUrl) : undefined;
  if (!po) throw appError(ERROR_CODES.PROCESSED_JSON_MISSING, uploadId);
  const csv = parseCsv(await readText(u.uniwareCsvUrl));
  const saved = await AppDataSource.getRepository(DetailsPurchaseOrder).findBy({ shipmentOrderId: u.poUid });
  const master = await AppDataSource.getRepository(MasterPurchaseOrder).findOneBy({ uid: u.poUid });
  const verified = (await verifiedRows([u])).get(String(u.id));
  // The PO with GST as the checks see it (a PO priced before GST gets the GST added here, line by line)
  // A bulk order (2026-11-12) has no channel masters: its processed.json already has the price with GST (landing_rate)
  const checked = isBulkUpload(u) ? null : await validatePo(po, await panelMasterFor(AppDataSource, po.channel_name as ChannelName));
  const withGst = new Map((checked?.lines ?? []).map((l) => [String(l.lineNo), l.poUnitPrice]));
  const beforeGst = /before GST/i.test(String(po.field_sources?.po_value ?? '')) || (po.line_items.length > 0 && po.line_items.every((l) => l.landing_rate === '' && l.unit_cost !== ''));

  // CSV rows follow the PO's lines in order (csvOf); by channel SKU when the counts differ.
  const poLines = po.line_items;
  const sameCount = poLines.length === csv.length;
  const used = new Set<number>();
  const lines = csv.map((r, i): VerifyLine => {
    let j = sameCount ? i : poLines.findIndex((l, k) => !used.has(k) && l.channel_sku_code && l.channel_sku_code === r[col.CHANNEL_SKU]);
    if (j < 0) j = poLines.findIndex((l, k) => !used.has(k) && l.pep_sku_code && l.pep_sku_code === r[col.SKU]);
    if (j >= 0) used.add(j);
    const p = j >= 0 ? poLines[j] : undefined;
    const qty = n(r[col.QTY]);
    const rate = n(r[col.PRICE]);
    // the PO's unit price with GST: as read, or (a PO priced before GST) its unit cost + GST as the checks work it out
    const gstRate = p ? withGst.get(String(p.line_no)) : undefined;
    const poRate = p && p.landing_rate !== '' ? n(p.landing_rate) : typeof gstRate === 'number' ? gstRate : null;
    const name = saved.find((d) => d.skuCode === r[col.SKU])?.skuName ?? null;
    return {
      lineNo: i + 1,
      skuCode: r[col.SKU],
      channelSkuCode: r[col.CHANNEL_SKU],
      name,
      qty,
      rate,
      value: Math.round(qty * rate * 100) / 100,
      po: p ? { channelPrice: num(p.unmapped?.myntra_landed_price), channelGst: num(p.unmapped?.myntra_gst), description: p.description, qty: n(p.qty), rate: poRate, rateBeforeGst: p.landing_rate === '' && p.unit_cost !== '' ? n(p.unit_cost) : null, mrp: p.channel_mrp !== '' ? n(p.channel_mrp) : null, channelSkuCode: p.channel_sku_code } : null,
      qtyDiffers: !p || n(p.qty) !== qty,
      rateDiffers: poRate !== null && Math.abs(poRate - rate) > PO_VERIFY.RATE_TOLERANCE,
    };
  });
  const first = csv[0] ?? {};
  const required = (await switches())(u.channel);
  const state = stateOf(u, verified, required);
  return {
    uploadId: String(u.id),
    poNumber: u.poNumber,
    channel: u.channel,
    fileName: u.fileName,
    fileType: u.fileType,
    required,
    state,
    // A channel with the switch OFF may still be verified (optional), and sent back.
    canAct: state === PO_VERIFY_STATE.TO_VERIFY || state === PO_VERIFY_STATE.NOT_REQUIRED,
    last: await lastAction(u),
    header: {
      saleOrderCode: first[col.CODE] || master?.orderNo1 || null,
      poDate: po.po_date || null,
      expiryDate: po.expiry_date || null,
      poLocation: po.delivery_facility_code || null,
      customerCode: first[col.CUSTOMER] || null,
      facilityCode: first[col.FACILITY] || null,
      uniwareChannel: first[col.CHANNEL] || null,
    },
    lines,
    totals: {
      po: {
        lines: poLines.length, units: poLines.reduce((s, l) => s + n(l.qty), 0), value: n(po.po_value),
        valueBasis: beforeGst ? 'before_gst' : 'with_gst',
        valueWithGst: beforeGst ? (typeof checked?.totals.poValue === 'number' ? checked.totals.poValue : null) : n(po.po_value),
      },
      saved: { lines: lines.length, units: lines.reduce((s, l) => s + l.qty, 0), value: Math.round(lines.reduce((s, l) => s + l.value, 0) * 100) / 100 },
      channelPrice: OUR_PRICE_ONLY_CHANNELS.includes(po.channel_name as ChannelName)
        ? { value: num(po.unmapped?.myntra_landed_total), note: String(po.unmapped?.price_basis ?? '') }
        : null,
    },
    processed: po,
  };
};

// ---- Verify / send back ---------------------------------------------------------------------------------------------

export interface VerifyBody {
  remark?: string;
  linesChecked?: number;
  lineCount?: number;
}

/** The upload as it stands, refused unless it is a processed PO still waiting for its check. */
const checkable = (u: PoUpload | null, uploadId: string): PoUpload & { poUid: string } => {
  if (!u) throw appError(ERROR_CODES.UPLOAD_NOT_FOUND, uploadId);
  if (u.status !== UPLOAD_STATUS.COMPLETED || !u.poUid) throw appError(ERROR_CODES.VERIFY_NOT_READY, uploadId, u.status);
  return u as PoUpload & { poUid: string };
};

export const verifyPo = async (uploadId: string, body: VerifyBody, by: Actor): Promise<{ state: PoVerifyState }> => {
  await AppDataSource.transaction(async (m) => {
    const u = checkable(await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } }), uploadId);
    const done = await m.getRepository(PoVerification).countBy({ uploadId: u.id, poUid: u.poUid, action: PO_VERIFY_ACTION.VERIFIED });
    if (done) throw appError(ERROR_CODES.ALREADY_VERIFIED, uploadId);
    const so = (await m.getRepository(MasterPurchaseOrder).findOne({ select: ['orderNo1'], where: { uid: u.poUid } }))?.orderNo1 ?? null;
    await m.getRepository(PoVerification).insert({
      uploadId: u.id, poUid: u.poUid, saleOrderCode: so, action: PO_VERIFY_ACTION.VERIFIED, remark: body.remark ?? null,
      linesChecked: body.linesChecked ?? null, lineCount: body.lineCount ?? null, doneBy: by.id, doneAt: new Date(),
    });
  });
  await audit(by, `po verify: verified upload ${uploadId}`);
  bumpReview();
  return { state: PO_VERIFY_STATE.VERIFIED };
};

export type VerifySkip = (typeof PO_VERIFY.SKIP)[keyof typeof PO_VERIFY.SKIP];
export interface VerifyManyResult {
  verified: string[];
  skipped: { uploadId: string; reason: VerifySkip }[];
}

/**
 * Many POs at once (2026-11-02, user: the Processed download with "Verified" typed in its Check column, uploaded back).
 * Only POs still "to verify" are verified; the others are left as they are, with the reason. A fixed number of queries
 * whatever the batch size (at most PO_VERIFY.BULK_MAX): the uploads (5 columns, locked), their verified rows, the channel
 * switches, their sale order codes, one insert; then one audit line and one live refresh.
 */
export const verifyMany = async (ids: string[], remark: string | undefined, by: Actor): Promise<VerifyManyResult> => {
  const want = [...new Set(ids.map(String))];
  const out: VerifyManyResult = { verified: [], skipped: [] };
  const isOn = await switches();
  await AppDataSource.transaction(async (m) => {
    const uploads = await m.getRepository(PoUpload).find({
      select: ['id', 'status', 'poUid', 'channel', 'uniwareUploadedAt'],
      where: { id: In(want) },
      lock: { mode: 'pessimistic_write' },
    });
    const byId = new Map(uploads.map((u) => [String(u.id), u]));
    const uids = uploads.map((u) => u.poUid).filter((v): v is string => !!v);
    const done = uids.length
      ? await m.getRepository(PoVerification).find({ select: ['uploadId', 'poUid'], where: { poUid: In(uids), action: PO_VERIFY_ACTION.VERIFIED } })
      : [];
    const isDone = new Set(done.map((d) => `${d.uploadId}:${d.poUid}`));

    const ready: (PoUpload & { poUid: string })[] = [];
    for (const id of want) {
      const u = byId.get(id);
      const reason: VerifySkip | null =
        !u ? PO_VERIFY.SKIP.NOT_FOUND
        : u.status !== UPLOAD_STATUS.COMPLETED || !u.poUid ? PO_VERIFY.SKIP.NOT_READY
        : isDone.has(`${u.id}:${u.poUid}`) ? PO_VERIFY.SKIP.ALREADY_VERIFIED
        : u.uniwareUploadedAt ? PO_VERIFY.SKIP.IN_UNIWARE
        : !isOn(u.channel) ? PO_VERIFY.SKIP.NOT_REQUIRED
        : null;
      if (reason) out.skipped.push({ uploadId: id, reason });
      else ready.push(u as PoUpload & { poUid: string });
    }
    if (!ready.length) return;

    const sos = await m.getRepository(MasterPurchaseOrder).find({ select: ['uid', 'orderNo1'], where: { uid: In(ready.map((u) => u.poUid)) } });
    const soOf = new Map(sos.map((s) => [String(s.uid), s.orderNo1 ?? null]));
    const now = new Date();
    await m.getRepository(PoVerification).insert(ready.map((u) => ({
      uploadId: u.id, poUid: u.poUid, saleOrderCode: soOf.get(String(u.poUid)) ?? null, action: PO_VERIFY_ACTION.VERIFIED,
      remark: remark ?? null, linesChecked: null, lineCount: null, doneBy: by.id, doneAt: now,
    })));
    out.verified = ready.map((u) => String(u.id));
  });
  if (out.verified.length) {
    await audit(by, PO_VERIFY.BULK_AUDIT(out.verified.length));
    bumpReview();
  }
  return out;
};

/**
 * Something on the saved PO is wrong: cancel it and send the PO back to In Review (user, 2026-10-22, option A).
 * Nothing is deleted: the saved PO stays (statusActive Inactive) with its sale order code, both kept on the
 * po_verifications row; the upload loses its link to it and its CSV, and gets open issues again: everything validation
 * finds on the PO now + the checker's remark (type OTHER, so the reviewer accepts it once fixed).
 */
export const sendBack = async (uploadId: string, remark: string, by: Actor): Promise<{ status: string; issues: number }> => {
  const before = checkable(await AppDataSource.getRepository(PoUpload).findOneBy({ id: uploadId }), uploadId);
  // a bulk order's sale order goes back to PO Processing & Review > Bulk Orders (approved again), not to In Review
  if (isBulkUpload(before)) {
    const r = await bulkSendBack(uploadId, remark, by);
    await audit(by, `po verify: sent back bulk order upload ${uploadId} (PO uid ${before.poUid} cancelled)`);
    return r;
  }
  if (before.uniwareUploadedAt) throw appError(ERROR_CODES.ALREADY_IN_UNIWARE, uploadId);
  const oldUid = before.poUid;

  // Validation now, as the reviewer will see it; this PO's own (cancelled) saved row is not a duplicate of itself.
  const processedUrl = before.ocrResult?.processed_json;
  const po = typeof processedUrl === 'string' ? await readS3Json<ProcessedPo>(processedUrl) : undefined;
  if (!po) throw appError(ERROR_CODES.PROCESSED_JSON_MISSING, uploadId);
  const master = await new MasterDataReader(AppDataSource).forChannel(po.channel_name as ChannelName);
  const others = async (poNumber: string) =>
    (await AppDataSource.getRepository(MasterPurchaseOrder)
      .createQueryBuilder('o')
      .where('o.channel = :channel AND o.poNumber = :poNumber AND o.uid <> :uid', { channel: master?.channel.displayName, poNumber, uid: oldUid })
      .andWhere(`o.uid NOT IN (SELECT v.po_uid FROM ${TABLES.PO_VERIFICATIONS} v WHERE v.action = :sentBack AND v.po_uid IS NOT NULL)`, { sentBack: PO_VERIFY_ACTION.SENT_BACK })
      .getCount()) > 0;
  const v = await validatePo(po, master ? { ...master, poExists: others } : master);

  let created = 0;
  await AppDataSource.transaction(async (m) => {
    const u = checkable(await m.getRepository(PoUpload).findOne({ where: { id: uploadId }, lock: { mode: 'pessimistic_write' } }), uploadId);
    if (u.poUid !== oldUid) throw appError(ERROR_CODES.VERIFY_NOT_READY, uploadId, u.status);
    if (u.uniwareUploadedAt) throw appError(ERROR_CODES.ALREADY_IN_UNIWARE, uploadId);
    const orders = m.getRepository(MasterPurchaseOrder);
    const so = (await orders.findOne({ select: ['orderNo1'], where: { uid: oldUid } }))?.orderNo1 ?? null;
    await orders.update({ uid: oldUid }, { statusActive: PO_ACTIVE_STATUS.INACTIVE });
    await m.getRepository(PoVerification).insert({
      uploadId: u.id, poUid: oldUid, saleOrderCode: so, action: PO_VERIFY_ACTION.SENT_BACK, remark, doneBy: by.id, doneAt: new Date(),
    });
    await m.getRepository(PoUpload).update(
      { id: u.id },
      { status: UPLOAD_STATUS.NEEDS_REVIEW, poUid: null, uniwareCsvUrl: null, csvDownloadedAt: null, csvDownloadedBy: null, completedAt: null },
    );

    const issues = m.getRepository(PoIssue);
    const actions = m.getRepository(PoIssueAction);
    const seen = new Set<string>();
    const rows: Partial<PoIssue>[] = [];
    for (const i of v.issues) {
      const key = issueKey(i.type, i.lineNo, i.field);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ lineNo: typeof i.lineNo === 'number' ? i.lineNo : null, issueType: i.type, fieldName: i.field, details: i.message.slice(0, 500), originalValues: originalValues(i, v) });
    }
    rows.push({
      lineNo: null, issueType: ISSUE_TYPE.OTHER, fieldName: ISSUE_FIELDS.VERIFICATION,
      details: PO_VERIFY.ISSUE_TEXT(remark, by.email).slice(0, 500), originalValues: { saleOrderCode: so, poUid: oldUid },
    });
    for (const r of rows) {
      const issue = await issues.save(issues.create({ ...r, uploadId: u.id, status: ISSUE_STATUS.OPEN }));
      await actions.save(actions.create({ issueId: issue.id, action: ISSUE_ACTION.CREATED, actionBy: by.email, afterValue: issue.originalValues, remark }));
    }
    created = rows.length;
  });
  await audit(by, `po verify: sent back upload ${uploadId} (PO uid ${oldUid} cancelled)`);
  bumpReview();
  return { status: UPLOAD_STATUS.NEEDS_REVIEW, issues: created };
};
