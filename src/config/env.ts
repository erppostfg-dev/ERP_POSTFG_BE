import dotenv from 'dotenv';
import { ERROR_CODES } from '../constants/errors';
import { LOG_DEFAULTS, LOG_FORMAT, LOG_LEVEL_RANK, type LogFormat, type LogLevel } from '../constants/logging';
import { appError } from '../utils/AppError';

dotenv.config();

const required = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw appError(ERROR_CODES.ENV_MISSING, key);
  }
  return value;
};

const flag = (key: string, fallback = 'false'): boolean => (process.env[key] ?? fallback) === 'true';

const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return process.env[key] !== undefined && process.env[key] !== '' && Number.isFinite(v) ? v : fallback;
};
const logLevel = (process.env.LOG_LEVEL ?? LOG_DEFAULTS.LEVEL).toLowerCase() as LogLevel;
const logFormat = (process.env.LOG_FORMAT ?? LOG_DEFAULTS.FORMAT).toLowerCase() as LogFormat;

const port = Number(required('PORT', '3000'));
const apiPrefix = required('API_PREFIX', '/api/v1');

export const env = {
  nodeEnv: required('NODE_ENV', 'development'),
  port,
  apiPrefix,
  db: {
    // Off until MySQL is set up; the server then starts without a DB connection.
    enabled: flag('DB_ENABLED'),
    host: required('DB_HOST', 'localhost'),
    port: Number(required('DB_PORT', '3306')),
    username: required('DB_USERNAME'),
    password: required('DB_PASSWORD', ''),
    name: required('DB_NAME'),
    synchronize: flag('DB_SYNCHRONIZE'),
    logging: flag('DB_LOGGING'),
  },
  // Optional at startup; checked when the Gmail client is created.
  gmail: {
    mailbox: process.env.GMAIL_MAILBOX ?? 'erp.postfg@mcaffeine.com',
    authMode: (process.env.GMAIL_AUTH_MODE ?? 'service_account') as 'service_account' | 'oauth',
    serviceAccountKeyFile: process.env.GMAIL_SERVICE_ACCOUNT_KEY_FILE,
    oauthClientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  },
  // Gmail watch -> Pub/Sub topic -> pull subscription read by this server.
  pubsub: {
    enabled: flag('PUBSUB_ENABLED'),
    projectId: process.env.GCP_PROJECT_ID,
    topic: process.env.PUBSUB_TOPIC, // topic id, e.g. po-intake-gmail
    subscription: process.env.PUBSUB_SUBSCRIPTION, // subscription id, e.g. po-intake-gmail-sub
    // Optional service account key; when empty the Gmail login above is reused.
    keyFile: process.env.PUBSUB_KEY_FILE || undefined,
  },
  intake: {
    // Where label routes send emails; relative endpoints are joined to this.
    baseUrl: process.env.INTAKE_BASE_URL ?? `http://localhost:${port}${apiPrefix}`,
    webhookSecret: process.env.WEBHOOK_SECRET,
  },
  // Python OCR (ocr-service/, a git submodule), run as a child process by extractPo().
  ocr: {
    // true: every newly stored email goes to extractPo() straight away (testing; later a BullMQ worker does this).
    enabled: flag('OCR_ENABLED'),
    // true: the OCR reads its input files from the S3 copy (s3://<S3_BUCKET>/...) instead of the local folder. Needs S3_ENABLED.
    inputFromS3: flag('OCR_INPUT_FROM_S3'),
    // true: at startup, stored POs that have no ocr-result.json yet are queued too (oldest first).
    backlog: flag('OCR_BACKLOG'),
    // Most OCR runs per server start (new + backlog); 0 = no limit. Emails over the limit keep no result,
    // so the next start's backlog picks them up.
    runLimit: Number(process.env.OCR_RUN_LIMIT ?? 0),
    pythonBin: process.env.PYTHON_BIN ?? 'python',
    script: process.env.OCR_SCRIPT ?? 'ocr-service/dev/scripts/run_po.py',
    timeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 10 * 60 * 1000),
    concurrency: Number(process.env.OCR_CONCURRENCY ?? 2),
  },
  // Login: Google sign-in for the website (a Web application OAuth client; not the Gmail client above).
  auth: {
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Signs the session cookie (JWT, HS256).
    secret: process.env.AUTH_SECRET,
    // Google sends the user back here; must be an Authorized redirect URI on the OAuth client.
    callbackUrl: process.env.AUTH_CALLBACK_URL ?? `http://localhost:${port}${apiPrefix}/auth/google/callback`,
    // Where the browser goes after login (?error=<CODE> when refused).
    redirectUrl: process.env.AUTH_REDIRECT_URL ?? `http://localhost:${port}${apiPrefix}/auth/me`,
    // The frontend's origin: CORS with credentials is allowed only for it.
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    allowedEmailDomain: (process.env.ALLOWED_EMAIL_DOMAIN ?? 'mcaffeine.com').toLowerCase(),
    sessionDays: Number(process.env.SESSION_DAYS ?? 7),
    cookieSecure: flag('COOKIE_SECURE'),
  },
  // The chain after intake (po_uploads -> OCR -> processed.json -> validation -> DB -> Uniware CSV).
  pipeline: {
    // Most emails taken into the chain per process start (new intake + resume); 0 = no limit (production).
    // Emails over the limit are only stored as files (no po_uploads row, no OCR); po:pipeline / po:one take them later.
    limit: Number(process.env.PIPELINE_LIMIT ?? 0),
    // true: at server start, unfinished po_uploads rows are resumed (queued / extracting / processing).
    resumeOnStart: flag('PIPELINE_RESUME'),
  },
  // PO verification (2026-10-22): the Uniware CSV of a processed PO stays locked until a person verifies it against the
  // original PO (constants/po-verify.ts). On unless PO_VERIFY_REQUIRED=false (the switch to drop the step later).
  poVerify: {
    required: flag('PO_VERIFY_REQUIRED', 'true'),
  },
  // Channel API connectors (2026-10-16): POs pulled from channel APIs into the same chain. Off by default, like the
  // email listener; each connector also needs its own keys. Poll minutes: the connector's env value, else the constant.
  channelApi: {
    enabled: flag('CHANNEL_API_ENABLED'),
    amazon: {
      clientId: process.env.SPAPI_CLIENT_ID,
      clientSecret: process.env.SPAPI_CLIENT_SECRET,
      refreshToken: process.env.SPAPI_REFRESH_TOKEN,
      region: (process.env.SPAPI_REGION ?? 'EU').toUpperCase(),
      pollMinutes: process.env.AMAZON_POLL_MINUTES ? Number(process.env.AMAZON_POLL_MINUTES) : undefined,
    },
  },
  // Logging (2026-10-19; constants/logging.ts). EC2: LOG_FORMAT=json (the CloudWatch agent sends the pm2 log files to
  // /mcaffeine-erp-post-fg/po-api-ec2/<env>), DB_LOGGING=false. Limits in ms unless named otherwise; 0 switches one off.
  log: {
    level: (LOG_LEVEL_RANK[logLevel] ? logLevel : LOG_DEFAULTS.LEVEL) as LogLevel,
    format: (logFormat === LOG_FORMAT.JSON ? LOG_FORMAT.JSON : LOG_FORMAT.PRETTY) as LogFormat,
    dbSlowMs: num('DB_SLOW_MS', LOG_DEFAULTS.DB_SLOW_MS),
    apiSlowMs: num('API_SLOW_MS', LOG_DEFAULTS.API_SLOW_MS),
    extSlowMs: num('EXT_SLOW_MS', LOG_DEFAULTS.EXT_SLOW_MS),
    jobSlowMs: num('JOB_SLOW_MS', LOG_DEFAULTS.JOB_SLOW_MS),
    dbQueriesWarn: num('DB_QUERIES_WARN', LOG_DEFAULTS.DB_QUERIES_WARN),
    responseWarnKb: num('RESPONSE_WARN_KB', LOG_DEFAULTS.RESPONSE_WARN_KB),
    repeatWarn: num('REPEAT_WARN', LOG_DEFAULTS.REPEAT_WARN),
    eventLoopWarnMs: num('EVENT_LOOP_WARN_MS', LOG_DEFAULTS.EVENT_LOOP_WARN_MS),
    memoryWarnMb: num('MEMORY_WARN_MB', LOG_DEFAULTS.MEMORY_WARN_MB),
    monitorSeconds: num('MONITOR_SECONDS', LOG_DEFAULTS.MONITOR_SECONDS),
    heartbeatMinutes: num('MONITOR_HEARTBEAT_MINUTES', LOG_DEFAULTS.HEARTBEAT_MINUTES),
  },
  storage: {
    emailDir: process.env.EMAIL_STORAGE_DIR ?? 'storage/emails',
    gmailStateFile: process.env.GMAIL_STATE_FILE ?? 'storage/gmail-state.json',
  },
  // Copy of the email storage in S3: <prefix><label>/<folder>/<file>, the same layout as EMAIL_STORAGE_DIR.
  // Local storage stays; S3 is written after it. Credentials come from AWS_* (later the EC2 IAM role).
  s3: {
    enabled: flag('S3_ENABLED'),
    bucket: process.env.S3_BUCKET ?? 'mcaffeine-erp-post-fg-s3-dev',
    region: process.env.S3_REGION ?? process.env.AWS_REGION ?? 'ap-south-1',
    prefix: process.env.S3_EMAIL_PREFIX ?? '',
  },
};
