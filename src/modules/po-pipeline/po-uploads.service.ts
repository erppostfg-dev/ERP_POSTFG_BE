import fs from 'fs/promises';
import path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import {
  CHANNEL_TOLERANCES, poTotalAllowed,
  ChannelName,
  FILES,
  FOLDERS,
  ISSUE_ACTION,
  ISSUE_STATUS,
  ISSUE_TYPE,
  PO_FILE_EXTENSIONS,
  PROVIDERS,
  SYSTEM_ACTOR,
  UPLOAD_OCR_STATUS,
  UPLOAD_SOURCE,
  UPLOAD_STATUS,
  UploadOcrStatus,
  UploadStatus,
  VALIDATION_TEXT,
  ValidationIssue,
} from '../../constants';
import { PoIssue, PoIssueAction, PoUpload } from '../../entities';
import { EmailMetadata } from '../email-intake/s3-layout';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { s3UrlFor } from '../po-processing/common/processed-store';
import { MasterDataReader } from '../po-validation/master-data';
import { validatePo, ValidationResult } from '../po-validation/validate-po';

/*
 * Step 1 of saving a PO (user, 2026-10-08): po_uploads + po_issues.
 *   - ONE po_uploads ROW PER PO. An email starts as one row (po_number empty); after processing, the first PO takes that
 *     row and every other PO of the same email (Purplle) gets a copy with the same email / file / OCR details.
 *   - The PO is validated; every blocking issue is a po_issues row (+ a "created" po_issue_actions row).
 *   - Run again (e.g. after the master data was fixed): issues no longer found are closed (approved by "system"), issues
 *     still found keep their row (details refreshed), new ones are added. A completed or rejected PO is never touched.
 * planEmail() only READS the DB; applyPlan() writes the plan in one transaction.
 */

/** One PO of an email folder: its processed.json and that file's path inside the folder. */
export interface FolderPo {
  po: ProcessedPo;
  /** processed.json, or POs/<PO>/processed.json for an email with several POs. */
  relPath: string;
}

/** The processed.json files of an email folder: its own, or one per PO under POs/<PO>/ (Purplle). */
export const readFolderPos = async (folder: string): Promise<FolderPo[]> => {
  const out: FolderPo[] = [];
  const read = async (rel: string) => {
    try {
      out.push({ po: JSON.parse(await fs.readFile(path.join(folder, rel), 'utf8')) as ProcessedPo, relPath: rel.replace(/\\/g, '/') });
    } catch {
      /* not there */
    }
  };
  await read(FILES.PROCESSED);
  const dirs = await fs.readdir(path.join(folder, FOLDERS.POS), { withFileTypes: true }).catch(() => []);
  for (const d of dirs) if (d.isDirectory()) await read(path.join(FOLDERS.POS, d.name, FILES.PROCESSED));
  return out;
};

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** Our record of the OCR run (ocr-result.json) and the OCR's own summary (ocr-output_result.json), as far as used here. */
interface OcrRun {
  status?: string;
  files?: string[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}
interface OcrOutput {
  status?: string;
  input?: string;
  pipeline?: string;
  warnings?: unknown[];
  line_items?: number;
  cost_usd?: number;
}

const extOf = (name: string): string => path.extname(name).slice(1).toLowerCase();

/** The PO file of an email: one the OCR used, else an attachment (a PDF first), else the body (FirstCry: PO behind a link). */
const pickPoFile = (meta: EmailMetadata, run: OcrRun | null): string => {
  const isPo = (n: string) => (PO_FILE_EXTENSIONS as readonly string[]).includes(extOf(n));
  const pick = (names: string[]) => names.filter(isPo).find((n) => extOf(n) === 'pdf') ?? names.find(isPo);
  return pick(run?.files ?? []) ?? pick((meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename))) ?? FILES.BODY_HTML;
};

/**
 * The PO's own file in an email with several POs (2026-10-26, Tata 1mg: one PDF + CSV per PO): the file whose name holds
 * the PO number (PDF first). Undefined when no file name carries it (Purplle: one summary file for all), so the PO keeps
 * the email's file.
 */
export const ownPoFile = (meta: EmailMetadata, poNumber: string): string | undefined => {
  if (!poNumber) return undefined;
  const isPo = (n: string) => (PO_FILE_EXTENSIONS as readonly string[]).includes(extOf(n));
  const escaped = poNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const holds = new RegExp(`(^|[^0-9A-Za-z])${escaped}([^0-9A-Za-z]|$)`);
  const mine = (meta.files ?? []).map((f) => (typeof f === 'string' ? f : f.filename)).filter((n) => isPo(n) && holds.test(n));
  return mine.find((n) => extOf(n) === 'pdf') ?? mine[0];
};

const asDate = (v?: string): Date | null => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/** The po_uploads values every PO of an email shares: source, email, file and OCR details. */
export const emailValues = async (folder: string, channelDisplayName: string | null): Promise<Partial<PoUpload>> => {
  const meta = (await readJson<EmailMetadata & { provider?: string; labels?: string[] }>(
    path.join(folder, FILES.METADATA),
  )) ?? {};
  const run = await readJson<OcrRun>(path.join(folder, FILES.OCR_RESULT));
  // A channel API PO (2026-10-16): no email and no OCR; the "file" is the API's own JSON.
  if (meta.provider === PROVIDERS.CHANNEL_API) {
    return {
      source: UPLOAD_SOURCE.API,
      channel: channelDisplayName,
      fileName: FILES.API_RAW,
      fileUrl: s3UrlFor(folder, meta, FILES.API_RAW),
      fileType: extOf(FILES.API_RAW),
      emailMessageId: meta.messageId ?? null,
      emailFrom: null,
      // The channel's name for the PO (Amazon: "FBA STA (28/09/2026 08:03)-DEL5"), shown / copied like an email subject.
      emailSubject: meta.subject?.slice(0, 500) ?? null,
      emailReceivedAt: asDate(meta.receivedAt),
      sourceSystem: meta.sourceSystem ?? null,
      externalId: meta.externalId ?? null,
      // Nothing to read with OCR: the data came structured, so its "extraction" is done.
      ocrStatus: UPLOAD_OCR_STATUS.SUCCESS,
      ocrStartedAt: null,
      ocrFinishedAt: null,
      ocrAttempts: 0,
    };
  }
  // A manual upload of a structured file (Amazon shipment .tsv, 2026-10-22): no OCR, the file is the PO.
  if (meta.provider === PROVIDERS.MANUAL && meta.structured && meta.sourceFile) {
    return {
      source: UPLOAD_SOURCE.MANUAL,
      channel: channelDisplayName,
      fileName: meta.sourceFile,
      fileUrl: s3UrlFor(folder, meta, meta.sourceFile),
      fileType: extOf(meta.sourceFile) || null,
      emailMessageId: meta.messageId ?? null,
      emailFrom: null,
      emailSubject: meta.subject?.slice(0, 500) ?? null,
      emailReceivedAt: asDate(meta.receivedAt),
      sourceSystem: meta.sourceSystem ?? null,
      externalId: meta.externalId ?? null,
      ocrStatus: UPLOAD_OCR_STATUS.SUCCESS,
      ocrStartedAt: null,
      ocrFinishedAt: null,
      ocrAttempts: 0,
    };
  }
  const fileName = pickPoFile(meta, run);
  const fromLabel = meta.provider === PROVIDERS.GMAIL_PUBSUB || !!meta.labels?.length;
  return {
    source: fromLabel ? UPLOAD_SOURCE.EMAIL : UPLOAD_SOURCE.MANUAL,
    channel: channelDisplayName,
    fileName,
    fileUrl: s3UrlFor(folder, meta, fileName),
    fileType: extOf(fileName) || null,
    emailMessageId: meta.messageId ?? null,
    emailFrom: fromLabel ? (meta.from ?? null) : null,
    emailSubject: fromLabel ? (meta.subject?.slice(0, 500) ?? null) : null,
    emailReceivedAt: fromLabel ? asDate(meta.receivedAt) : null,
    ocrStatus: !run ? UPLOAD_OCR_STATUS.PENDING : run.status === 'ok' ? UPLOAD_OCR_STATUS.SUCCESS : UPLOAD_OCR_STATUS.ERROR,
    ocrStartedAt: asDate(run?.startedAt),
    ocrFinishedAt: asDate(run?.finishedAt),
    ocrAttempts: run ? 1 : 0,
  };
};

/** po_uploads.ocr_result for one PO: where its files are and what the OCR / processing reported (decided: a summary). */
const ocrSummary = async (folder: string, fp: FolderPo): Promise<Record<string, unknown>> => {
  const meta = (await readJson<EmailMetadata>(path.join(folder, FILES.METADATA))) ?? {};
  if (meta.provider === PROVIDERS.CHANNEL_API || (meta.structured && meta.sourceFile)) {
    return {
      raw_output: s3UrlFor(folder, meta, meta.structured && meta.sourceFile ? meta.sourceFile : FILES.API_RAW),
      processed_json: s3UrlFor(folder, meta, fp.relPath),
      input_type: fp.po.input_type,
      source_system: meta.sourceSystem ?? null,
      external_status: meta.externalStatus ?? null,
      lines: fp.po.line_items.length,
      processing_warnings: fp.po.warnings,
    };
  }
  const out = await readJson<OcrOutput>(path.join(folder, FILES.OCR_OUTPUT_RESULT));
  const run = await readJson<OcrRun>(path.join(folder, FILES.OCR_RESULT));
  return {
    raw_output: s3UrlFor(folder, meta, FILES.OCR_OUTPUT_CSV),
    raw_summary: s3UrlFor(folder, meta, FILES.OCR_OUTPUT_RESULT),
    processed_json: s3UrlFor(folder, meta, fp.relPath),
    input_type: fp.po.input_type,
    pipeline: out?.pipeline ?? null,
    lines: fp.po.line_items.length,
    cost_usd: out?.cost_usd ?? null,
    duration_ms: run?.durationMs ?? null,
    ocr_warnings: out?.warnings ?? [],
    processing_warnings: fp.po.warnings,
  };
};

/** po_issues.original_values: the PO's value and ours, so the reviewer sees both. */
export const originalValues = (issue: ValidationIssue, r: ValidationResult): Record<string, unknown> => {
  const line = issue.lineNo === undefined || issue.lineNo === '' ? undefined : r.lines.find((l) => l.lineNo === issue.lineNo);
  const tolerances = CHANNEL_TOLERANCES[r.channel];
  const tolerance =
    issue.type === ISSUE_TYPE.MRP_MISMATCH ? tolerances?.mrpPerSku
    : issue.type === ISSUE_TYPE.PRICE_MISMATCH ? tolerances?.pricePerSku
    : issue.type === ISSUE_TYPE.TOTAL_MISMATCH && tolerances && typeof issue.expected === 'number' ? poTotalAllowed(tolerances, issue.expected)
    : undefined;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const po = issue.actual;
  const ours = issue.expected;
  const v: Record<string, unknown> = {
    channel_sku_code: line?.channelSkuCode || undefined,
    pep_code: line?.pepCode || undefined,
    po,
    ours,
    difference: num(po) !== undefined && num(ours) !== undefined ? Math.round(((po as number) - (ours as number)) * 100) / 100 : undefined,
    tolerance,
  };
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== ''));
};

export const issueKey = (type: string, lineNo: number | null | '' | undefined, field: string | null) =>
  `${type}|${lineNo === '' || lineNo === undefined || lineNo === null ? '' : lineNo}|${field ?? ''}`;

export interface IssuePlan {
  /** New issues to insert. */
  create: Partial<PoIssue>[];
  /** Open issues found again: refreshed details / values. */
  keep: { issue: PoIssue; details: string; originalValues: Record<string, unknown> }[];
  /** Open issues not found any more: closed as approved by "system". */
  close: PoIssue[];
}

export interface RowPlan {
  poNumber: string;
  relPath: string;
  /** The row this PO uses: its own, or the email's row it takes over (null = a new row). */
  existing: PoUpload | null;
  /** completed / rejected rows are final: nothing is changed. */
  final: boolean;
  values: Partial<PoUpload>;
  status: UploadStatus;
  validation: ValidationResult;
  issues: IssuePlan;
}

export interface EmailPlan {
  folder: string;
  messageId: string | null;
  rows: RowPlan[];
}

/** YYYY-MM-DD from the PO's po_date (a full date-time keeps its day; anything else = null, never a bad DATE value). */
export const dateOnly = (v: unknown): string | null => {
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null;
  return m && !Number.isNaN(Date.parse(m[1])) ? m[1] : null;
};

/** Works out what to write for one email folder. Reads only. */
export const planEmail = async (db: DataSource, reader: MasterDataReader, folder: string, now = new Date()): Promise<EmailPlan> => {
  const pos = await readFolderPos(folder);
  if (!pos.length) return { folder, messageId: null, rows: [] };
  const channel = pos[0].po.channel_name as ChannelName;
  const master = await reader.forChannel(channel);
  const base = await emailValues(folder, master?.channel.displayName ?? null);
  const messageId = base.emailMessageId ?? null;
  const meta = pos.length > 1 ? ((await readJson<EmailMetadata>(path.join(folder, FILES.METADATA))) ?? {}) : {};

  const uploads = db.getRepository(PoUpload);
  const issuesRepo = db.getRepository(PoIssue);
  const existingRows = messageId ? await uploads.findBy({ emailMessageId: messageId }) : [];
  // The email's own row (po_number still empty) is taken over by the first PO that has no row yet.
  let emailRow = existingRows.find((r) => r.poNumber === null) ?? null;

  const rows: RowPlan[] = [];
  for (const fp of pos) {
    const poNumber = fp.po.po_number;
    let existing = existingRows.find((r) => r.poNumber === poNumber) ?? null;
    if (!existing && emailRow) {
      existing = emailRow;
      emailRow = null;
    }
    const final = existing?.status === UPLOAD_STATUS.COMPLETED || existing?.status === UPLOAD_STATUS.REJECTED;
    const validation = await validatePo(fp.po, master, now);
    const hasOcrIssue = validation.issues.some((i) => i.type === ISSUE_TYPE.OCR_ISSUE);

    // Several POs in one email: each PO points to its own file when one carries its number.
    const own = pos.length > 1 ? ownPoFile(meta, poNumber) : undefined;
    const values: Partial<PoUpload> = {
      ...base,
      ...(own ? { fileName: own, fileUrl: s3UrlFor(folder, meta, own), fileType: extOf(own) || null } : {}),
      poNumber: poNumber || null,
      poDate: dateOnly(fp.po.po_date),
      ocrStatus: hasOcrIssue ? UPLOAD_OCR_STATUS.ISSUE : (base.ocrStatus as UploadOcrStatus),
      // The chain counts OCR runs on the row (ocrStarted); ocr-result.json only says whether one happened.
      ocrAttempts: Math.max(existing?.ocrAttempts ?? 0, base.ocrAttempts ?? 0),
      ocrResult: await ocrSummary(folder, fp),
    };
    const status: UploadStatus = validation.issues.length ? UPLOAD_STATUS.NEEDS_REVIEW : UPLOAD_STATUS.PROCESSING;

    // Issues: compare what validation found now with the row's open issues.
    const open = existing ? await issuesRepo.findBy({ uploadId: existing.id, status: ISSUE_STATUS.OPEN }) : [];
    const openByKey = new Map(open.map((i) => [issueKey(i.issueType, i.lineNo, i.fieldName), i]));
    const plan: IssuePlan = { create: [], keep: [], close: [] };
    const seen = new Set<string>();
    for (const i of validation.issues) {
      const key = issueKey(i.type, i.lineNo, i.field);
      if (seen.has(key)) continue; // one row per type + line + field
      seen.add(key);
      const details = i.message.slice(0, 500);
      const ov = originalValues(i, validation);
      const found = openByKey.get(key);
      if (found) plan.keep.push({ issue: found, details, originalValues: ov });
      else {
        plan.create.push({
          lineNo: typeof i.lineNo === 'number' ? i.lineNo : null,
          issueType: i.type,
          fieldName: i.field,
          details,
          originalValues: ov,
          status: ISSUE_STATUS.OPEN,
        });
      }
    }
    plan.close = open.filter((i) => !seen.has(issueKey(i.issueType, i.lineNo, i.fieldName)));

    rows.push({ poNumber, relPath: fp.relPath, existing, final, values, status, validation, issues: final ? { create: [], keep: [], close: [] } : plan });
  }
  return { folder, messageId, rows };
};

/** Writes a plan in ONE transaction: po_uploads rows, then their issues and issue actions. Returns the row id per PO. */
export const applyPlan = async (db: DataSource, plan: EmailPlan): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  await db.transaction(async (m: EntityManager) => {
    const uploads = m.getRepository(PoUpload);
    const issues = m.getRepository(PoIssue);
    const actions = m.getRepository(PoIssueAction);
    for (const row of plan.rows) {
      if (row.final && row.existing) {
        ids.set(row.poNumber, row.existing.id);
        continue;
      }
      // save() (not update/insert): TypeORM's update() does not accept the JSON columns' object types.
      const upload = await uploads.save(uploads.create({ ...(row.existing ?? {}), ...row.values, status: row.status }));
      ids.set(row.poNumber, upload.id);

      for (const c of row.issues.create) {
        const issue = await issues.save(issues.create({ ...c, uploadId: upload.id }));
        await actions.save(actions.create({ issueId: issue.id, action: ISSUE_ACTION.CREATED, actionBy: SYSTEM_ACTOR, afterValue: issue.originalValues }));
      }
      for (const k of row.issues.keep) {
        await issues.save({ ...k.issue, details: k.details, originalValues: k.originalValues });
      }
      for (const c of row.issues.close) {
        await issues.save({ ...c, status: ISSUE_STATUS.APPROVED, resolvedBy: SYSTEM_ACTOR, resolvedAt: new Date(), remark: VALIDATION_TEXT.AUTO_CLOSED });
        await actions.save(
          actions.create({ issueId: c.id, action: ISSUE_ACTION.APPROVED, actionBy: SYSTEM_ACTOR, remark: VALIDATION_TEXT.AUTO_CLOSED, beforeValue: c.originalValues }),
        );
      }
    }
  });
  return ids;
};
