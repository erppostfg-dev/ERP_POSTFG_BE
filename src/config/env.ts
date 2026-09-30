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
};
