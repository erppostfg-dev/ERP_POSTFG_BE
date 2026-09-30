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
  storage: {
    emailDir: process.env.EMAIL_STORAGE_DIR ?? 'storage/emails',
    gmailStateFile: process.env.GMAIL_STATE_FILE ?? 'storage/gmail-state.json',
  },
};
