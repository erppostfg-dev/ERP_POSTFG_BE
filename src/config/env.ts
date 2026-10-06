import dotenv from 'dotenv';

dotenv.config();

const required = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const flag = (key: string, fallback = 'false'): boolean => (process.env[key] ?? fallback) === 'true';

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
