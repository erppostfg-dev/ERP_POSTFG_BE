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

