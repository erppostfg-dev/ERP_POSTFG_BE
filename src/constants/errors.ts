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
  ROUTE_FORWARD_FAILED: define(502, (url: string, status: number, body: string) => `POST ${url} -> ${status}: ${body}`),

  // --- Storage / S3 -----------------------------------------------------------------------------------------------
  PATH_OUTSIDE_STORAGE: define(500, (file: string, storageDir: string) => `${file} is not under ${storageDir}`),

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
