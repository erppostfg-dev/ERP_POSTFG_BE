import { keysOf } from './keys';

/*
 * Every error code and its message, in one place. Code throws `appError(ERROR_CODES.X, ...)` (utils/AppError.ts) or
 * records `errorMessage(ERROR_CODES.X, ...)` as a reason; the API answers { error: { code, message, details } }
 * with the HTTP status given here.
 *
 * `status` is the HTTP status when the error reaches an API response; errors that only happen in the background
 * (Gmail sync, S3, OCR, scripts) use 500.
 */

const define = <A extends unknown[]>(status: number, message: (...args: A) => string) => ({ status, message });

export const ERRORS = {
  // --- API requests -----------------------------------------------------------------------------------------------
  ROUTE_NOT_FOUND: define(404, (method: string, url: string) => `Route not found: ${method} ${url}`),
  UPLOAD_REJECTED: define(400, (reason: string) => `Upload rejected: ${reason}`),
  WEBHOOK_SECRET_NOT_SET: define(500, () => 'WEBHOOK_SECRET is not set on the server'),
  WEBHOOK_SECRET_INVALID: define(401, () => 'Invalid webhook secret'),
  NO_FILES_UPLOADED: define(400, () => 'No files uploaded; send them in the "files" field'),
  VALIDATION_FAILED: define(400, () => 'Validation failed'),
  INTERNAL: define(500, () => 'Internal server error'),

  // --- Request field checks (details of VALIDATION_FAILED) --------------------------------------------------------
  FIELD_NOT_EMAIL: define(400, (field: string) => `${field} must be an email`),
  FIELD_NOT_ISO_DATE: define(400, (field: string) => `${field} must be an ISO date`),
  FIELD_NOT_DAY: define(400, (field: string) => `${field} must be a date as YYYY-MM-DD`),
  FIELD_NOT_ONE_OF: define(400, (field: string, allowed: string) => `${field} must be one of: ${allowed}`),
  FIELD_NOT_INT_RANGE: define(400, (field: string, min: number, max: number) => `${field} must be a whole number from ${min} to ${max}`),
  FIELD_RANGE_REVERSED: define(400, (from: string, to: string) => `${from} must not be after ${to}`),
  FIELD_REQUIRED: define(400, (field: string) => `${field} is required`),
  FIELD_TOO_LONG: define(400, (field: string, max: number) => `${field} must be at most ${max} characters`),
  FIELD_NOT_TEXT: define(400, (field: string) => `${field} must be text`),
  FIELD_NOT_NUMBER: define(400, (field: string) => `${field} must be a number of 0 or more`),
  FIELD_NOT_LIST: define(400, (field: string) => `${field} must be a list`),
  FIELD_NOT_OBJECT: define(400, (field: string) => `${field} must be an object`),

  // --- Configuration (.env) ---------------------------------------------------------------------------------------
  ENV_MISSING: define(500, (key: string) => `Missing required environment variable: ${key}`),
  GMAIL_SERVICE_ACCOUNT_KEY_MISSING: define(500, () => 'GMAIL_SERVICE_ACCOUNT_KEY_FILE is required when GMAIL_AUTH_MODE=service_account'),
  GMAIL_OAUTH_CONFIG_MISSING: define(
    500,
    () => 'GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET and GMAIL_OAUTH_REFRESH_TOKEN are required when GMAIL_AUTH_MODE=oauth',
  ),
  GMAIL_OAUTH_CLIENT_MISSING: define(500, () => 'Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env first.'),
  GMAIL_WATCH_CONFIG_MISSING: define(500, () => 'GCP_PROJECT_ID and PUBSUB_TOPIC are required for the Gmail watch'),
  PUBSUB_SUBSCRIPTION_MISSING: define(500, () => 'PUBSUB_SUBSCRIPTION is required'),
  S3_DISABLED: define(500, () => 'S3_ENABLED is not true in .env'),
  S3_URL_INVALID: define(500, (url: string, bucket: string) => `Not an s3:// URL in bucket ${bucket}: ${url}`),
  DB_NOT_ALLOWED: define(
    500,
    (database: string, allowed: string) => `Database "${database}" is not allowed; the app may only use: ${allowed} (constants/db.ts)`,
  ),

  // --- Gmail ------------------------------------------------------------------------------------------------------
  GMAIL_LABEL_NOT_FOUND: define(
    500,
    (label: string, mailbox: string) => `Gmail label "${label}" not found in ${mailbox}. Create it or fix label-routes.ts.`,
  ),
  GMAIL_NO_REFRESH_TOKEN: define(
    500,
    () => 'No refresh token returned. Remove the app at https://myaccount.google.com/permissions and run again.',
  ),
  /** The intake endpoint answered 5xx: the email is retried. */
  PIPELINE_LIMIT_REACHED: define(503, (limit: number) => `PIPELINE_LIMIT ${limit} reached: intake stopped until the next start`),
  ROUTE_FORWARD_FAILED: define(502, (url: string, status: number, body: string) => `POST ${url} -> ${status}: ${body}`),

  // --- Storage / S3 -----------------------------------------------------------------------------------------------
  PATH_OUTSIDE_STORAGE: define(500, (file: string, storageDir: string) => `${file} is not under ${storageDir}`),

  // --- Login and page access -------------------------------------------------------------------------------------
  AUTH_NOT_CONFIGURED: define(500, (keys: string) => `Login is not configured: set ${keys} in .env`),
  UNAUTHENTICATED: define(401, () => 'Sign in to continue'),
  OAUTH_STATE_INVALID: define(400, () => 'The sign-in link expired or was not started here; sign in again'),
  GOOGLE_TOKEN_INVALID: define(401, () => 'Google sign-in could not be verified'),
  NOT_ALLOWED_DOMAIN: define(403, (domain: string) => `Only ${domain} accounts can sign in`),
  USER_NOT_FOUND: define(403, (email: string) => `${email} has no access to POST_FG yet; ask an admin`),
  // --- Uniware hand-off (2026-10-19) ---
  UNIWARE_CSV_NOT_READY: define(409, (ids: string) => `No Uniware CSV yet for upload(s) ${ids}: only completed POs have one`),
  UNIWARE_NOT_DOWNLOADED: define(409, (ids: string) => `Download the sale order CSV first: upload(s) ${ids} not downloaded yet`),
  UPLOAD_IDS_REQUIRED: define(400, () => 'Pick at least one PO (uploadIds)'),
  // --- Channel API connectors (2026-10-16) ---
  SPAPI_LOGIN_FAILED: define(502, (reason: string) => `Amazon SP-API login refused: ${reason} (check SPAPI_* in .env; the client secret expires 180 days after issue)`),
  SPAPI_CALL_FAILED: define(502, (status: number, path: string, reason: string) => `Amazon SP-API ${path} -> ${status}: ${reason}`),
  CONNECTOR_UNKNOWN: define(400, (key: string, known: string) => `No channel API connector "${key}" (known: ${known})`),
  // --- Users & Roles admin (2026-10-15) ---
  NOT_A_USER_ADMIN: define(403, (roles: string) => `Only ${roles} can add or change users and roles`),
  USER_ID_NOT_FOUND: define(404, (id: string) => `No user ${id}`),
  USER_EXISTS: define(409, (email: string) => `${email} is already a user`),
  EMAIL_DOMAIN_NOT_ALLOWED: define(400, (domain: string) => `Only ${domain} email addresses can be added (they sign in with Google)`),
  ROLE_NOT_FOUND: define(400, (role: string) => `No role "${role}"`),
  ROLE_EXISTS: define(409, (role: string) => `A role "${role}" already exists`),
  ROLE_IS_SYSTEM: define(403, (role: string) => `"${role}" is a built-in role with full access; it cannot be changed here`),
  ROLE_PAGE_NOT_ALLOWED: define(400, (page: string) => `A role cannot be given ${page} here`),
  FACILITY_NOT_FOUND: define(400, (codes: string) => `Unknown facility code(s): ${codes} (codes are case-sensitive)`),
  CANNOT_CHANGE_OWN_ACCESS: define(400, () => 'You cannot switch yourself off or remove your own admin / developer role'),
  MAIL_SEND_NOT_ALLOWED: define(500, (mailbox: string) => `The Gmail login of ${mailbox} has no send permission yet: run npm run gmail:token again and allow sending`),
  MAIL_SEND_FAILED: define(500, (reason: string) => `Email not sent: ${reason}`),
  USER_INACTIVE: define(403, (email: string) => `${email} is switched off; ask an admin`),
  FORBIDDEN_PAGE: define(
    403,
    (page: string, needed: string, have: string) =>
      have === 'viewer'
        ? `Access denied: you have view-only access to ${page}. Ask an admin for ${needed} access to make changes.`
        : `Access denied: you have no access to ${page}. Ask an admin for ${needed} access.`,
  ),

  // --- PO review API ----------------------------------------------------------------------------------------------
  UPLOAD_NOT_FOUND: define(404, (uploadId: string) => `No PO upload ${uploadId}`),
  SHIPMENT_NOT_FOUND: define(404, (uid: string) => `No shipment ${uid}`),
  // --- PO Overview editing (2026-10-14) ---
  SHIPMENT_NOT_EDITABLE: define(403, (uid: string) => `You can't edit shipment ${uid} (not one of your facilities, or view-only access)`),
  FIELDS_NOT_EDITABLE: define(403, (fields: string) => `You can't edit: ${fields}`),
  FIELDS_CHANGED_MEANWHILE: define(409, (count: number) => `${count} field(s) were changed by someone else since you opened the shipment`),
  APPOINTMENT_REMARK_REQUIRED: define(400, () => 'A changed appointment date needs a remark from the appointment remark list'),
  NO_CHANGES: define(400, () => 'Nothing to save: no field was changed'),
  PROCESSED_JSON_MISSING: define(409, (uploadId: string) => `PO upload ${uploadId} has no processed.json in S3 yet`),
  PO_FILE_MISSING: define(404, (uploadId: string) => `PO upload ${uploadId} has no PO file in S3`),
  UPLOAD_NOT_IN_REVIEW: define(409, (uploadId: string, status: string) => `PO upload ${uploadId} is ${status}, not in review any more; reload it`),
  REVIEW_INCOMPLETE: define(422, (count: number) => `${count} issue(s) are still open: correct them, accept them (where allowed) or reject the PO`),
  // --- PO review approvals (2026-10-15) ---
  SUBMISSION_NOT_FOUND: define(404, (id: string) => `No PO review submission ${id}`),
  SUBMISSION_NOT_PENDING: define(409, (id: string, status: string) => `Submission ${id} is ${status}, not pending any more; reload it`),
  NOT_AN_APPROVER: define(403, (roles: string) => `Only ${roles} can approve or reject PO reviews`),
  REVIEW_RETURNED: define(409, (count: number) => `The PO no longer passes the checks (${count} issue(s)); it went back to In Review with the reason`),
  ISSUE_NOT_ACCEPTABLE: define(422, (issueId: string, type: string) => `Issue ${issueId} (${type}) cannot be accepted: correct it or reject the PO`),
  ISSUE_NOT_OPEN: define(400, (issueId: string) => `Issue ${issueId} is not an open issue of this PO`),
  SKU_NOT_IN_MASTER: define(400, (pepCode: string, channel: string) => `${pepCode} is not in the ${channel} SKU master`),
  LOCATION_NOT_IN_CHANNEL: define(400, (id: string, channel: string) => `Location ${id} is not a ${channel} delivery location`),
  LINE_NOT_IN_PO: define(400, (lineNo: string) => `The PO has no line ${lineNo}`),

  // --- PO chain (po_uploads.error_details, resume) ----------------------------------------------------------------
  UNIWARE_CSV_MISSING: define(500, (csvPath: string) => `Uniware CSV ${csvPath} not found after the PO rows were saved; the sale order code must be checked by hand`),
  EMAIL_FOLDER_NOT_FOUND: define(500, (messageId: string) => `No stored email folder for message ${messageId}`),
  TOO_MANY_OCR_ATTEMPTS: define(500, (attempts: number, max: number) => `OCR already tried ${attempts} times (max ${max})`),

  // --- Channel detection: why an email is not a PO (reason.json / report.csv) ------------------------------------
  NO_SENDER: define(422, () => 'email has no sender'),
  UNKNOWN_SENDER: define(422, (from: string) => `no channel configured for sender ${from}`),
  NOT_PO_SUBJECT: define(
    422,
    (from: string, channels: string) => `sender ${from} is ${channels}, but the subject is not a PO subject`,
  ),

  // --- Linked files (channels that send download links: FirstCry) -------------------------------------------------
  LINK_NOT_FOUND: define(502, (text: string) => `no link with text ${text}`),
  LINK_HOST_NOT_ALLOWED: define(502, (protocol: string, host: string) => `host not allowed: ${protocol}//${host}`),
  LINK_HTTP_ERROR: define(502, (status: number, host: string) => `HTTP ${status} from ${host}`),
  LINK_FILE_TOO_LARGE: define(502, (maxBytes: number) => `file over ${maxBytes} bytes`),
  LINK_NO_FILE: define(502, (host: string) => `no file and no redirect from ${host} (link expired?)`),
  LINK_TOO_MANY_REDIRECTS: define(502, () => 'too many redirects'),
  LINK_NOT_DOWNLOADED: define(502, () => 'not downloaded'),

  // --- OCR run (ocr-result.json: status skipped / failed) ---------------------------------------------------------
  OCR_FILES_MISSING: define(
    422,
    (channel: string, kind: string, pattern: string, files: string) => `${channel} needs a ${kind} matching ${pattern}, got [${files}]`,
  ),
  OCR_DOWNLOAD_FAILED: define(502, (problems: string) => `download failed: ${problems}`),
  OCR_S3_INPUT_DISABLED: define(500, () => 'OCR_INPUT_FROM_S3 needs S3_ENABLED=true'),
  OCR_S3_UPLOAD_FAILED: define(502, (reason: string) => `S3 upload before OCR failed: ${reason}`),
  OCR_TIMED_OUT: define(504, (ms: number) => `timed out after ${ms} ms`),
  /** The OCR's own error message, passed on as it is. */
  OCR_FAILED: define(502, (message: string) => message),
  OCR_EXITED: define(502, (exitCode: number | null) => `OCR exited with code ${exitCode}`),

  // --- PO processing (processed.json) -----------------------------------------------------------------------------
  NO_PROCESSING_ROUTE: define(422, (channel: string) => `no processing route for ${channel} yet`),
  NO_RAW_OUTPUT: define(422, () => 'no raw OCR output yet'),
  RAW_OUTPUT_INVALID: define(500, (file: string) => `${file}: no "Field,Value" header block`),

  // --- Command-line scripts ---------------------------------------------------------------------------------------
  CLI_USAGE: define(400, (usage: string) => usage),
  CLI_LABEL_ROUTE_NOT_FOUND: define(400, (label: string, routes: string) => `No route for label "${label}". Routes: ${routes}`),
};

export type ErrorCode = keyof typeof ERRORS;
export type ErrorArgs<C extends ErrorCode> = Parameters<(typeof ERRORS)[C]['message']>;

/** ERROR_CODES.NO_SENDER === 'NO_SENDER', and so on for every error. */
export const ERROR_CODES = keysOf(ERRORS);

/** Why an email is not a PO: no sender, a sender that is no channel's, or a channel's sender with a non-PO subject. */
export type NotPoCode = typeof ERROR_CODES.NO_SENDER | typeof ERROR_CODES.UNKNOWN_SENDER | typeof ERROR_CODES.NOT_PO_SUBJECT;

/** The message of an error, e.g. errorMessage(ERROR_CODES.UNKNOWN_SENDER, 'a@b.com'). */
export const errorMessage = <C extends ErrorCode>(code: C, ...args: ErrorArgs<C>): string =>
  (ERRORS[code].message as (...a: ErrorArgs<C>) => string)(...args);
