import dotenv from 'dotenv';

dotenv.config();

const required = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const env = {
  nodeEnv: required('NODE_ENV', 'development'),
  port: Number(required('PORT', '3000')),
  apiPrefix: required('API_PREFIX', '/api/v1'),
  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(required('DB_PORT', '3306')),
    username: required('DB_USERNAME'),
    password: required('DB_PASSWORD', ''),
    name: required('DB_NAME'),
    synchronize: required('DB_SYNCHRONIZE', 'false') === 'true',
    logging: required('DB_LOGGING', 'false') === 'true',
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
  storage: {
    emailDir: process.env.EMAIL_STORAGE_DIR ?? 'storage/emails',
  },
};
