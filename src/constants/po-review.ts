import { ROLES, RoleKey } from './auth';
import { REVIEW_SUBMISSION_STATUS } from './db';

/*
 * PO review API (API contract "PO review", 2026-10-09): GET /po-review lists po_uploads by status, one row per PO.
 */

/** Query defaults and limits for the list. */
export const PO_REVIEW_LIST = {
  DEFAULT_PAGE_SIZE: 25,
  /** The Processed tab loads a whole date range at once (user, 2026-10-09: up to 500). */
  MAX_PAGE_SIZE: 500,
} as const;

/** Query parameter names (also the `field` of a VALIDATION_FAILED detail). */
export const PO_REVIEW_QUERY = {
  STATUS: 'status',
  CHANNEL: 'channel',
  Q: 'q',
  FROM: 'from',
  TO: 'to',
  PAGE: 'page',
  PAGE_SIZE: 'pageSize',
} as const;

/** from / to are calendar days (YYYY-MM-DD), taken in Indian time. */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** po_uploads.id in a URL: digits only (anything else is answered as "no such upload"). */
export const UPLOAD_ID_PATTERN = /^\d{1,19}$/;

/** Download links of the review panel (PO file, processed.json, CSV) stay valid this long. */
export const PO_REVIEW_LINK_MINUTES = 15;

/** Remarks are stored in po_issues.remark / po_issue_actions.remark (varchar 500). */
export const PO_REVIEW_REMARK_MAX = 500;

/** Body field names of resubmit / reject (also the `field` of a VALIDATION_FAILED detail). */
export const PO_REVIEW_BODY = {
  LOCATION: 'location',
  DETAILS_CHANNEL_ID: 'location.detailsChannelId',
  LINES: 'lines',
  LINE_NO: 'lineNo',
  PEP_CODE: 'pepCode',
  QTY: 'qty',
  MRP: 'mrp',
  RATE: 'rate',
  ACCEPT: 'accept',
  ISSUE_ID: 'issueId',
  REMARK: 'remark',
} as const;

/*
 * PO review approvals (user, 2026-10-15): the reviewer submits the fixed PO, an approver approves (PO is created) or
 * rejects it on the Approvals page. Approvers = these roles (admin + developer while testing; prod: PROD_CHECKLIST).
 * An approver may approve their own submission for now (one user on dev; prod: PROD_CHECKLIST).
 */
export const APPROVER_ROLES: readonly RoleKey[] = [ROLES.ADMIN, ROLES.DEVELOPER];

/** The tabs of the Approvals page (GET /approvals/po-reviews?status=). */
export const APPROVAL_LIST_STATUSES = [REVIEW_SUBMISSION_STATUS.PENDING, REVIEW_SUBMISSION_STATUS.APPROVED, REVIEW_SUBMISSION_STATUS.REJECTED] as const;

/** po_review_submissions.id in a URL. */
export const SUBMISSION_ID_PATTERN = /^\d{1,19}$/;


/** Field names in po_review_submissions.fixes (what the reviewer changed on a line). */
export const REVIEW_FIX_FIELD = { SKU: 'pepCode', QTY: 'qty', MRP: 'mrp', RATE: 'rate' } as const;

/** Live PO Review + Approvals (po-review.live.ts): the screens reload when the review data's version changes. */
export const REVIEW_LIVE = {
  /** While a screen is connected, the server re-reads the version this often (catches other processes). */
  WATCH_MS: 5_000,
  /** SSE event name of a change (the ping is LIVE.EVENT_PING). */
  EVENT_CHANGE: 'review',
  /** Route names, under /po-review and /approvals. */
  EVENTS: '/events',
  STATE: '/live-state',
} as const;

/*
 * Uniware hand-off (user, 2026-10-19): a completed PO waits on the Processed tab until its sale order CSV is
 * DOWNLOADED (amber, days counting) and then someone MARKS it uploaded into Uniware (green); only then does the PO
 * appear in PO Overview. Not-yet-uploaded POs show on Processed whatever date range is picked.
 */
export const UNIWARE_HANDOFF = {
  /** Routes under /po-review. */
  CSV_ONE: '/:uploadId/uniware-csv',
  CSV_MANY: '/uniware-csv',
  MARK_UPLOADED: '/uniware-uploaded',
  /** Most POs in one combined download / one mark. */
  MAX_IDS: 500,
  /** Body field names. */
  BODY_IDS: 'uploadIds',
  BODY_UNDO: 'undo',
} as const;

/*
 * Line items download (user, 2026-10-26): on the Processed tab, tick POs -> every line of them as CSV or Excel (built
 * by the screen from these rows). Read-only: nothing is marked. DB lines + the PO's own JSON in S3 (EAN, MRP, rate,
 * HSN, GST...), joined on the line's position. Kept under ~2 s: at most MAX_IDS POs, S3 read S3_PARALLEL at a time.
 */
export const LINE_ITEMS = {
  /** Route under /po-review. */
  ROUTE: '/line-items',
  MAX_IDS: 100,
  S3_PARALLEL: 20,
} as const;


/**
 * Re-check of POs in review after a master fix (user, 2026-10-22: "they directly pass and the issue resolves").
 * Validation runs again on each In Review PO (processed.json from S3, today's master). Only issues the master can fix
 * are closed by it; when nothing is left the PO is saved like an approved one (sale order + Uniware CSV, then Verify if
 * its channel is ON). Everything that needs a person (expired, FOC / revised, duplicate, OCR, qty, a Verify remark)
 * always waits. Runs after `masters:load --apply`, every RECHECK_MINUTES in the server (0 = off), and on the
 * "Re-check now" button (In Review tab). Later (backlog 4i): timer off + re-check right after each Masters page save.
 */
export const REVIEW_RECHECK = {
  /** Issue types a master change can fix (the rest are never closed by a re-check). */
  FIXABLE: ['SKU_NOT_MAPPED', 'LOCATION_NOT_MAPPED', 'MRP_MISMATCH', 'PRICE_MISMATCH', 'TOTAL_MISMATCH'] as readonly string[],
  /** Minutes between automatic re-checks when RECHECK_MINUTES is not set. */
  DEFAULT_MINUTES: 30,
  /** First automatic run this long after the server starts. */
  FIRST_DELAY_MS: 60_000,
  REMARK: 'Fixed in master, re-checked automatically',
  ROUTE: '/recheck',
  TRIGGER: { TIMER: 'timer', MASTER_LOAD: 'master_load', BUTTON: 'button', MASTER_ADD: 'master_add' },
} as const;
