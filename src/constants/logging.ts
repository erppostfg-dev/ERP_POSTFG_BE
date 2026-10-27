/*
 * Logging (user, 2026-10-19): every log line has a CODE, the SOURCE it is about (our API, the database, S3, Gmail ...)
 * and, for a failure, the REASON in plain words and the FIX to try. Lines are JSON on EC2 (LOG_FORMAT=json, read by
 * the CloudWatch agent into /mcaffeine-erp-post-fg/po-api-ec2/<env>) and readable text locally (LOG_FORMAT=pretty).
 *
 * Codes:
 *   - events of our own app: API_*, DB_SLOW_QUERY, PROCESS_* ... (LOG_EVENTS below);
 *   - calls to another service: <SOURCE>_CALL (worked), <SOURCE>_SLOW (worked, but slower than the limit),
 *     <SOURCE>_<FAILURE> when it failed, e.g. S3_ACCESS_DENIED, GMAIL_BAD_CREDENTIALS, DB_SCHEMA_MISMATCH
 *     (FAILURES below = the reason; FIXES = what to do for that source).
 * In CloudWatch Logs Insights: `filter code like /_SLOW|DB_SLOW_QUERY/` or `filter level = "error" | stats count() by code`.
 */

export const LOG_LEVEL = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' } as const;
export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];
export const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_FORMAT = { JSON: 'json', PRETTY: 'pretty' } as const;
export type LogFormat = (typeof LOG_FORMAT)[keyof typeof LOG_FORMAT];

/** What a log line is about. The prefix is the start of its code (S3 -> S3_ACCESS_DENIED). */
export const LOG_SOURCE = {
  API: 'api', // our own HTTP API (one line per request)
  DB: 'db', // our MySQL (mcaff_postfg_*) and the read-only PEPIMS database
  S3: 's3', // AWS S3: email files, processed.json, Uniware CSVs
  SQS: 'sqs', // AWS SQS: the PO jobs queue (send / receive / delete), 2026-10-26
  GMAIL: 'gmail', // Gmail API: reading the Po-Intake mailbox, watch, labels
  PUBSUB: 'pubsub', // Google Pub/Sub: "the mailbox changed" notifications
  GOOGLE_LOGIN: 'google_login', // Google sign-in of the website users
  MAIL: 'mail', // emails we send (welcome email) through Gmail
  AMAZON: 'amazon', // Amazon SP-API (FBA inbound shipments)
  HTTP: 'http', // other web calls: PO file links in emails, our own intake endpoint
  OCR: 'ocr', // the Python OCR run as a child process
  PROCESS: 'process', // the Node.js process itself: memory, event loop, crashes, start / stop
  APP: 'app', // our own business steps (pipeline, review, intake) that are not a call to another service
} as const;
export type LogSource = (typeof LOG_SOURCE)[keyof typeof LOG_SOURCE];

/** Code prefix of each source. */
export const LOG_SOURCE_PREFIX: Record<LogSource, string> = {
  api: 'API', db: 'DB', s3: 'S3', sqs: 'SQS', gmail: 'GMAIL', pubsub: 'PUBSUB', google_login: 'GOOGLE_LOGIN', mail: 'MAIL',
  amazon: 'AMAZON', http: 'HTTP', ocr: 'OCR', process: 'PROCESS', app: 'APP',
};

/**
 * Why a call failed, in plain words. The code is <SOURCE PREFIX>_<key>, e.g. S3_ACCESS_DENIED.
 * `level`: how loud the line is (NOT_FOUND is often expected, e.g. "no corrected.json yet").
 */
export const FAILURES = {
  // --- any service ---
  NOT_FOUND: { level: 'info', reason: 'The thing asked for does not exist at the service (file, message, record).' },
  ACCESS_DENIED: { level: 'error', reason: 'The service knows us but refused: our login has no permission for this action.' },
  BAD_CREDENTIALS: { level: 'error', reason: 'The service did not accept our login: the key, token or password is wrong, expired or revoked.' },
  RATE_LIMITED: { level: 'warn', reason: 'Too many calls in a short time: the service asked us to slow down.' },
  UNAVAILABLE: { level: 'warn', reason: 'The service had a problem on its side (HTTP 5xx / UNAVAILABLE); it usually passes on retry.' },
  UNREACHABLE: { level: 'error', reason: 'Could not reach the service at all (network down, wrong host, DNS, connection refused or reset).' },
  TIMEOUT: { level: 'warn', reason: 'The service did not answer within the time limit.' },
  BAD_REQUEST: { level: 'error', reason: 'The service rejected what we sent (wrong, missing or too large input).' },
  CONFIG: { level: 'error', reason: 'A setting points to something that does not exist (bucket, subscription, project, file path, URL).' },
  ERROR: { level: 'error', reason: 'An unexpected error from the service; see `error` for its own message.' },
  // --- database only ---
  SCHEMA_MISMATCH: { level: 'error', reason: 'The code uses a table or column the database does not have: a migration has not been run, or the entity differs from the DB.' },
  DUPLICATE: { level: 'warn', reason: 'A row with the same unique value already exists.' },
  LINK_BROKEN: { level: 'error', reason: 'A foreign key check failed: the linked row does not exist, or other rows still point to this one.' },
  VALUE_TOO_LONG: { level: 'error', reason: 'A value is longer than its column allows.' },
  BAD_VALUE: { level: 'error', reason: 'A value does not fit its column (wrong type, NULL in a NOT NULL column, not in the ENUM list, bad date).' },
  LOCKED: { level: 'warn', reason: 'Another transaction held the rows too long (lock wait timeout) or two transactions blocked each other (deadlock).' },
  // --- OCR (child process) only ---
  NOT_INSTALLED: { level: 'error', reason: 'The program could not be started (Python or the OCR script not found at the configured path).' },
  FAILED: { level: 'error', reason: 'The program ran but ended with an error exit code.' },
} as const satisfies Record<string, { level: LogLevel; reason: string }>;
export type FailureKind = keyof typeof FAILURES;

/** What to do, per source and failure; a missing entry falls back to FIX_DEFAULT. */
export const FIXES: Partial<Record<LogSource, Partial<Record<FailureKind, string>>>> = {
  db: {
    SCHEMA_MISMATCH: 'Run `npm run migration:show`; if a migration is [ ], the user runs `npm run migration:run`, then restart the server.',
    UNREACHABLE: 'Check that MySQL is running and DB_HOST / DB_PORT; on EC2 check the security group to the DB.',
    BAD_CREDENTIALS: 'Check DB_USERNAME / DB_PASSWORD in .env (never print them).',
    LOCKED: 'Usually passes on retry. If it repeats, look for a long transaction (SHOW PROCESSLIST) or a script running at the same time.',
    DUPLICATE: 'The row is already there (often a retry of a step that already worked); check the unique value in `error`.',
    LINK_BROKEN: 'The linked id in `error` is missing or still used: check the master data (facility, location, user).',
    TIMEOUT: 'The DB was too slow or the connection pool was full: check DB_SLOW_QUERY / DB_POOL_WAITING lines around it.',
  },
  s3: {
    ACCESS_DENIED: 'The AWS key / EC2 role lacks this S3 permission (see `op`, e.g. s3:DeleteObject): ask the AWS admin.',
    BAD_CREDENTIALS: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY wrong or rotated (on EC2: the instance role).',
    CONFIG: 'S3_BUCKET or S3_REGION is wrong for this environment.',
    NOT_FOUND: 'The file is not in S3 yet (or was moved); `npm run s3:sync` uploads what is missing.',
    UNREACHABLE: 'No internet / AWS endpoint from this machine; the next sync retries.',
  },
  sqs: {
    ACCESS_DENIED: 'The AWS key / EC2 role lacks this SQS permission (see `op`: SendMessage, ReceiveMessage, DeleteMessage, ChangeMessageVisibility, GetQueueAttributes): ask the AWS admin.',
    BAD_CREDENTIALS: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY wrong or rotated (on EC2: the instance role).',
    CONFIG: 'SQS_PO_JOBS_ARN is wrong for this environment (region / account / queue name).',
    UNREACHABLE: 'No internet / AWS endpoint from this machine: jobs run in-process meanwhile, the worker retries receiving.',
  },
  gmail: {
    BAD_CREDENTIALS: 'The Gmail refresh token was revoked or expired: run `npm run gmail:token` and update .env.',
    ACCESS_DENIED: 'The token lacks a Gmail scope (readonly / send / pubsub): issue it again with all scopes.',
    NOT_FOUND: 'The message was deleted, or the history id is too old; the catch-up reads the label again.',
    RATE_LIMITED: 'Gmail quota hit; calls slow down and retry by themselves.',
  },
  pubsub: {
    CONFIG: 'GCP_PROJECT_ID / PUBSUB_SUBSCRIPTION do not match the Google Cloud project (project postfg).',
    ACCESS_DENIED: 'The login lacks Pub/Sub Subscriber on the subscription.',
    BAD_CREDENTIALS: 'The Pub/Sub key file or the Gmail token (pubsub scope) is invalid.',
    UNAVAILABLE: 'Pub/Sub reconnects by itself; missed changes are taken by the startup catch-up.',
  },
  google_login: {
    BAD_CREDENTIALS: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET wrong, or the sign-in code was used twice / expired (the user signs in again).',
    BAD_REQUEST: 'AUTH_CALLBACK_URL is not an Authorized redirect URI of the Google client.',
  },
  mail: {
    BAD_CREDENTIALS: 'The mailbox token was revoked: run `npm run gmail:token` (with the send scope).',
    ACCESS_DENIED: 'The mailbox token lacks the gmail.send scope.',
  },
  amazon: {
    BAD_CREDENTIALS: 'SPAPI_CLIENT_ID / SECRET / REFRESH_TOKEN wrong, or the client secret expired (renew in Seller Central every 180 days).',
    ACCESS_DENIED: 'The SP-API app lacks the role for this API (e.g. vendor POs need the Vendor role).',
    RATE_LIMITED: 'Amazon throttled us; the client waits and retries by itself.',
  },
  http: {
    NOT_FOUND: 'The link in the email expired or is wrong; the PO goes to review.',
    UNREACHABLE: 'The portal of the link is down or blocked from this machine.',
  },
  ocr: {
    NOT_INSTALLED: 'Check PYTHON_BIN (e.g. .venv-ocr/Scripts/python.exe) and OCR_SCRIPT in .env.',
    FAILED: 'See `logTail` for the Python error; the PO stays queued for the next run.',
    TIMEOUT: 'The OCR took longer than OCR_TIMEOUT_MS; a large file, or the OCR API is slow.',
  },
};
export const FIX_DEFAULT: Record<FailureKind, string> = {
  NOT_FOUND: 'Check the id / key in this line.',
  ACCESS_DENIED: 'Give the login the missing permission (see `op`).',
  BAD_CREDENTIALS: 'Check the keys / tokens of this service in .env (never print them).',
  RATE_LIMITED: 'Usually passes by itself; if it repeats, call less often.',
  UNAVAILABLE: 'Usually passes on retry; check the service status page if it repeats.',
  UNREACHABLE: 'Check the network and the host of the service.',
  TIMEOUT: 'Retry; if it repeats, the service or the network is slow.',
  BAD_REQUEST: 'Check the input in this line against the service API.',
  CONFIG: 'Check the related setting in .env.',
  ERROR: 'Read `error`; if unclear, follow the requestId / jobId through the other lines.',
  SCHEMA_MISMATCH: 'Run the pending migration.',
  DUPLICATE: 'Check the unique value in `error`.',
  LINK_BROKEN: 'Check the linked row in `error`.',
  VALUE_TOO_LONG: 'Shorten the value or widen the column (migration).',
  BAD_VALUE: 'Check the value against the column type in `error`.',
  LOCKED: 'Retry; look for long transactions.',
  NOT_INSTALLED: 'Check the program path in .env.',
  FAILED: 'Read the output of the program in this line.',
};

/** Events of our own app (not a call to another service). */
export const LOG_EVENTS = {
  // --- one line per API request ---
  API_REQUEST: { level: 'info', reason: 'An API request finished.' },
  API_SLOW: { level: 'warn', reason: 'An API request took longer than API_SLOW_MS: see dbQueries / extMs for where the time went.' },
  API_SERVER_ERROR: { level: 'error', reason: 'An API request failed on our side (HTTP 5xx); errorCode / error say why.' },
  API_CLIENT_ERROR: { level: 'info', reason: 'An API request was refused (HTTP 4xx: not signed in, no access, bad input); errorCode says why.' },
  API_STREAM_CLOSED: { level: 'debug', reason: 'A live-updates stream (SSE) was closed by the browser.' },
  // --- resource waste in one request / job ---
  API_TOO_MANY_QUERIES: { level: 'warn', reason: 'One request / job ran more DB queries than DB_QUERIES_WARN: usually a query inside a loop (N+1); load the rows in one query.' },
  API_RESPONSE_LARGE: { level: 'warn', reason: 'One response was bigger than RESPONSE_WARN_KB: page the list or send fewer columns.' },
  API_REPEATED_CALLS: { level: 'warn', reason: 'The same call to another service (same op + key) was made several times in one request / job: read it once and reuse it.' },
  // --- database ---
  DB_SLOW_QUERY: { level: 'warn', reason: 'One SQL query took longer than DB_SLOW_MS: check its WHERE / JOIN columns for an index, or fetch fewer rows.' },
  DB_POOL_WAITING: { level: 'warn', reason: 'Requests were waiting for a free DB connection: too many queries at once, or a transaction held a connection too long.' },
  DB_QUERY: { level: 'debug', reason: 'A SQL query (only with DB_LOGGING=true, or a write).' },
  DB_INFO: { level: 'info', reason: 'A message from TypeORM (schema / migration).' },
  // --- background jobs (no web request) ---
  JOB_DONE: { level: 'info', reason: 'A background job finished (Pub/Sub change, Amazon poll, OCR run, resume).' },
  JOB_SLOW: { level: 'warn', reason: 'A background job took longer than JOB_SLOW_MS.' },
  JOB_FAILED: { level: 'error', reason: 'A background job failed; it is retried by its own schedule (next notification / poll / start).' },
  // --- the Node.js process ---
  PROCESS_START: { level: 'info', reason: 'The server started (settings summary, no secrets).' },
  PROCESS_STOP: { level: 'info', reason: 'The server is stopping (signal received).' },
  PROCESS_HEARTBEAT: { level: 'info', reason: 'Periodic health: memory, CPU, event loop, requests, errors, DB pool (every MONITOR_HEARTBEAT_MINUTES).' },
  PROCESS_EVENT_LOOP_LAG: { level: 'warn', reason: 'The event loop was blocked longer than EVENT_LOOP_WARN_MS: some code ran a long synchronous step (big JSON / CSV, a loop over many rows), and every request waited.' },
  PROCESS_MEMORY_HIGH: { level: 'warn', reason: 'Process memory (RSS) is above MEMORY_WARN_MB: a large file or list held in memory, or a leak if it keeps growing.' },
  PROCESS_UNHANDLED_REJECTION: { level: 'error', reason: 'A promise failed and nothing handled it: a missing catch. The process exits and pm2 restarts it.' },
  PROCESS_UNCAUGHT_EXCEPTION: { level: 'error', reason: 'An error was thrown that nothing caught. The process exits and pm2 restarts it.' },
  // --- our app ---
  APP_INFO: { level: 'info', reason: 'A step of our own app.' },
  APP_WARN: { level: 'warn', reason: 'Something in our own app needs attention but the work went on.' },
  APP_ERROR: { level: 'error', reason: 'A step of our own app failed.' },
} as const satisfies Record<string, { level: LogLevel; reason: string }>;
export type LogEvent = keyof typeof LOG_EVENTS;

/** Defaults of the .env switches (env.log). */
export const LOG_DEFAULTS = {
  LEVEL: 'info' as LogLevel,
  FORMAT: 'pretty' as LogFormat,
  /** A query slower than this is a DB_SLOW_QUERY line (0 = off). */
  DB_SLOW_MS: 500,
  /** A request slower than this is API_SLOW. */
  API_SLOW_MS: 2000,
  /** A call to another service slower than this is <SOURCE>_SLOW. */
  EXT_SLOW_MS: 3000,
  /** A background job slower than this is JOB_SLOW. */
  JOB_SLOW_MS: 5 * 60 * 1000,
  /** More queries than this in one request / job: API_TOO_MANY_QUERIES. */
  DB_QUERIES_WARN: 100,
  /** A response bigger than this (KB): API_RESPONSE_LARGE. */
  RESPONSE_WARN_KB: 5 * 1024,
  /** The same op + key more often than this in one request / job: API_REPEATED_CALLS. */
  REPEAT_WARN: 3,
  /** Event loop blocked longer than this (ms): PROCESS_EVENT_LOOP_LAG. */
  EVENT_LOOP_WARN_MS: 200,
  /** Memory (RSS, MB) above this: PROCESS_MEMORY_HIGH. */
  MEMORY_WARN_MB: 1024,
  /** How often the process checks run (seconds), and the heartbeat line (minutes, 0 = off). */
  MONITOR_SECONDS: 15,
  HEARTBEAT_MINUTES: 5,
} as const;

/** The same warning is written at most once per this long (memory, event loop, pool), so a bad minute is not 100 lines. */
export const LOG_WARN_EVERY_MS = 60_000;
/** Header that carries the request id back to the browser (and into error responses as requestId). */
export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Field names whose values are never written (matched anywhere in the name, any case). */
export const LOG_SECRET_FIELDS = /pass(word)?|secret|token|authori[sz]ation|cookie|api[-_]?key|credential|private|signature|refresh/i;
/** Secret-looking text inside messages: bearer tokens, Google access tokens, AWS key ids, JWTs. */
export const LOG_SECRET_TEXT = [
  /Bearer\s+[\w.~+/-]+=*/gi,
  /ya29\.[\w.-]+/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /(refresh_token|client_secret|access_token)=[^&\s]+/gi,
];
export const LOG_MASK = '***';
/** Longest text written for one value (a query, an error message, a log tail). */
export const LOG_MAX_TEXT = 2000;
export const LOG_MAX_SQL = 600;
