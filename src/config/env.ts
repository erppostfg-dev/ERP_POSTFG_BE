import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ERROR_CODES } from '../constants/errors';
import { LOG_DEFAULTS, LOG_FORMAT, LOG_LEVEL_RANK, type LogFormat, type LogLevel } from '../constants/logging';
import { PO_JOBS, QUEUE_MODE, type QueueMode } from '../constants/po-jobs';
import { REVIEW_RECHECK } from '../constants/po-review';
import { appError } from '../utils/AppError';

dotenv.config();

/**
 * Laptop mode (user, 2026-10-27): the laptop and the dev EC2 share mcaff_postfg_dev, so `npm run dev` (src/dev.ts sets
 * LAPTOP_MODE=true) never does background work on it: no Gmail / Pub/Sub intake, OCR, OCR backlog, resume, channel API
 * polling, local cleanup, SQS worker, and no timed re-check; server.ts also skips the intake release and the
 * manual-upload queue resume. .env keeps its own values for `npm run dev:full` / EC2.
 */
const laptopMode = process.env.LAPTOP_MODE === 'true';
export const LAPTOP_MODE_OFF = {
  PUBSUB_ENABLED: 'false', OCR_ENABLED: 'false', OCR_BACKLOG: 'false', PIPELINE_RESUME: 'false', CHANNEL_API_ENABLED: 'false',
  LOCAL_CLEANUP_ENABLED: 'false', WORKER_IN_SERVER: 'false', QUEUE_MODE: 'local', RECHECK_MINUTES: '0',
} as const;
if (laptopMode) Object.assign(process.env, LAPTOP_MODE_OFF);

/**
 * A list setting: "A,B,C" or "[A, B, C]". A bracketed list may also run over several lines of .env, as the Python
 * in-transit tool's .env allowed (user, 2026-10-16):
 *   UNIWARE_FACILITY=[A ,
 *    B ,
 *    C]
 * dotenv keeps only the first line of such a value, so the following lines are read from .env here, up to the "]"
 * (stopping at the next KEY= line if the "]" is missing).
 */
const list = (key: string): string[] => {
  let value = process.env[key] ?? '';
  if (value.trim().startsWith('[') && !value.includes(']')) {
    try {
      const lines = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8').split(/\r?\n/);
      const start = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
      for (let i = start + 1; start >= 0 && i < lines.length && !value.includes(']'); i++) {
        if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(lines[i])) break;
        value += `,${lines[i]}`;
      }
    } catch {
      // no readable .env (variables set by the host): keep what the environment gave
    }
  }
  return value.replace(/[[\]]/g, '').split(',').map((v) => v.trim()).filter(Boolean);
};

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
  laptopMode,
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
    // connections in the pool (the in-transit store holds one briefly per upload lock, 2026-10-25)
    poolSize: Number(process.env.DB_POOL_SIZE ?? 20),
    // Nothing waits forever (2026-10-27): MySQL stops a SELECT after this (0 = off), a write waiting on a row lock
    // gives up after DB_LOCK_WAIT_S, at most DB_QUEUE_LIMIT requests wait for a free connection (0 = no limit),
    // and /health reports the DB down when SELECT 1 takes longer than DB_HEALTH_TIMEOUT_MS.
    queryTimeoutMs: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 30_000),
    lockWaitS: Number(process.env.DB_LOCK_WAIT_S ?? 20),
    queueLimit: Number(process.env.DB_QUEUE_LIMIT ?? 200),
    healthTimeoutMs: Number(process.env.DB_HEALTH_TIMEOUT_MS ?? 3_000),
  },
  // Optional at startup; checked when the Gmail client is created.
  gmail: {
    mailbox: process.env.GMAIL_MAILBOX ?? 'erp.postfg@mcaffeine.com',
    authMode: (process.env.GMAIL_AUTH_MODE ?? 'service_account') as 'service_account' | 'oauth',
    serviceAccountKeyFile: process.env.GMAIL_SERVICE_ACCOUNT_KEY_FILE,
    oauthClientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
    // one outgoing email (welcome) gives up after this; its retries then take over (2026-10-27)
    sendTimeoutMs: Number(process.env.MAIL_SEND_TIMEOUT_MS ?? 30_000),
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
    // Seconds a session check and a person's page access are kept in memory (2026-10-27; 0 = always read the DB).
    // Logout and every change in Users & Roles clear them at once; a change made by another server waits this long.
    cacheSeconds: Number(process.env.AUTH_CACHE_SECONDS ?? 30),
    cookieSecure: flag('COOKIE_SECURE'),
  },
  // The chain after intake (po_uploads -> OCR -> processed.json -> validation -> DB -> Uniware CSV).
  // PO jobs queue (2026-10-26, constants/po-jobs.ts): local = in-process as before; sqs = SQS queue + worker.
  queue: {
    mode: (process.env.QUEUE_MODE === QUEUE_MODE.SQS ? QUEUE_MODE.SQS : QUEUE_MODE.LOCAL) as QueueMode,
    jobsArn: process.env.SQS_PO_JOBS_ARN ?? '',
    dlqArn: process.env.SQS_PO_JOBS_DLQ_ARN ?? '',
    /** POs worked on at the same time by one worker process (1 = one after another). */
    concurrency: Math.max(1, num('WORKER_CONCURRENCY', PO_JOBS.DEFAULT_CONCURRENCY)),
    /** Pause after each job, so a burst becomes a steady line (0 = none). */
    pauseMs: Math.max(0, num('WORKER_PAUSE_MS', PO_JOBS.DEFAULT_PAUSE_MS)),
    /** true: the API server also runs the worker (local dev, one process). On EC2: a separate `npm run worker` (pm2). */
    workerInServer: flag('WORKER_IN_SERVER'),
  },
  pipeline: {
    // Most emails taken into the chain per process start (new intake + resume); 0 = no limit (production).
    // Emails over the limit are only stored as files (no po_uploads row, no OCR); po:pipeline / po:one take them later.
    limit: Number(process.env.PIPELINE_LIMIT ?? 0),
    // true: at server start, unfinished po_uploads rows are resumed (queued / extracting / processing).
    resumeOnStart: flag('PIPELINE_RESUME'),
  },
  // Demand Planning > In-transit Stock (TypeScript port of the Python tool). Runs in a child process, one at a time.
  intransit: {
    // inputs/ (the 19 CSVs + template), runs/<id>/ (each report), exports/ (connector downloads), cache/
    dir: process.env.INTRANSIT_DIR ?? 'storage/intransit',
    runTimeoutMs: Number(process.env.INTRANSIT_RUN_TIMEOUT_MS ?? 15 * 60 * 1000),
    // Connectors wait on Uniware export jobs (up to an hour each) and Amazon's pacing.
    connectorTimeoutMs: Number(process.env.INTRANSIT_CONNECTOR_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
    // Heap of the child process that builds the report (~100 MB of CSVs in, ~40 MB workbook out).
    workerMaxMemoryMb: Number(process.env.INTRANSIT_WORKER_MAX_MEMORY_MB ?? 3072),
    // Default start date of a report: shipments with an earlier Entry Date are left out. "2026-08-01" (fixed),
    // "79" (the last 79 days before as-of; the team's choice, 2026-10-21) or blank (all). A run can override it.
    // Open Uniware POs are never cut by it (stage combined_intransit).
    fromDate: process.env.INTRANSIT_FROM_DATE ?? '',
    // Shipment_Status / PO_Format: 'pepims' = read from PEPIMS at each build for today; anything else = uploaded
    poSource: (process.env.INTRANSIT_PO_SOURCE ?? 'upload').trim().toLowerCase() === 'pepims' ? 'pepims' : 'upload',
    // The 7 masters + Channel SKU Mapping: 'db' = written from the database into each build's snapshot; else the files
    mastersSource: (process.env.INTRANSIT_MASTERS_SOURCE ?? 'files').trim().toLowerCase() === 'db' ? 'db' : 'files',
    // The upload page warns when the daily inputs were saved more than this many hours apart.
    inputSpreadWarnHours: Number(process.env.INTRANSIT_INPUT_SPREAD_WARN_HOURS ?? 6),
    amazon: {
      clientId: process.env.SPAPI_CLIENT_ID,
      clientSecret: process.env.SPAPI_CLIENT_SECRET,
      refreshToken: process.env.SPAPI_REFRESH_TOKEN,
    },
    flipkart: {
      appId: process.env.FLIPKART_APP_ID,
      appSecret: process.env.FLIPKART_APP_SECRET,
    },
    uniware: {
      // tenant name, or the address copied from the browser (https://<tenant>.unicommerce.com/...)
      tenant: process.env.UNIWARE_TENANT,
      username: process.env.UNIWARE_USERNAME,
      password: process.env.UNIWARE_PASSWORD,
      // OLD, optional: the facilities to export now come from master_facilities.uniware_export (2026-10-26). This list
      // ("A,B,C" or "[A, B, C]", may span lines) is used only where the database has no such column or none is connected.
      facilities: list('UNIWARE_FACILITY'),
      // export jobs at a time (10 measured fine on 19-Oct: 58 jobs in 44 s, no throttling)
      parallel: Number(process.env.UNIWARE_PARALLEL ?? 10),
    },
    // This machine's name in the shared database: its runs carry it, so a restart only closes its own runs.
    hostId: (process.env.INTRANSIT_HOST_ID ?? '').trim() || os.hostname(),
    // Every in-transit file is kept in S3 (user, 2026-10-26; bucket S3_BUCKET): the live server under inventory/, test
    // machines under inventory-test/ (reading inventory/ too). Off = the disk store under INTRANSIT_DIR, as before.
    s3Enabled: flag('INTRANSIT_S3_ENABLED'),
    // A test machine (user, 2026-10-26: one shared test folder): INTRANSIT_TEST=true, or unset on a machine that is
    // not NODE_ENV=production - a laptop that forgot the flag never writes the live reports.
    test: (process.env.INTRANSIT_TEST ?? '').trim()
      ? flag('INTRANSIT_TEST')
      : (process.env.NODE_ENV ?? 'development') !== 'production',
    // Files waiting on this server while S3 cannot be reached (and kept job folders): past this, new work is refused.
    spoolMaxMb: Number(process.env.INTRANSIT_SPOOL_MAX_MB ?? 5000),
  },
  // PO verification (2026-10-22): the Uniware CSV of a processed PO stays locked until a person verifies it against the
  // original PO (constants/po-verify.ts). On unless PO_VERIFY_REQUIRED=false (the switch to drop the step later).
  poVerify: {
    required: flag('PO_VERIFY_REQUIRED', 'true'),
  },
  // Re-check of POs in review after a master fix (2026-10-22, constants/po-review REVIEW_RECHECK): minutes between
  // automatic runs; 0 = only after masters:load and on the button.
  recheck: {
    minutes: Number(process.env.RECHECK_MINUTES ?? REVIEW_RECHECK.DEFAULT_MINUTES),
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
    // Remove finished emails' local folders once their files are confirmed in S3 (constants LOCAL_CLEANUP; 2026-10-23).
    cleanupEnabled: flag('LOCAL_CLEANUP_ENABLED'),
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
