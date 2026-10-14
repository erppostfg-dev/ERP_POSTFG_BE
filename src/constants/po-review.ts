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
