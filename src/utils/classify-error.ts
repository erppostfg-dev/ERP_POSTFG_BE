import { LOG_SOURCE, type FailureKind, type LogSource } from '../constants/logging';
import { AppError } from './AppError';
import { logFailure, maskText, type LogFields } from './logger';
import { whereFailed } from './where';

/*
 * Turns any error from a service into a FailureKind (constants/logging FAILURES: the plain reason + the fix), so a log
 * line says WHY, e.g. S3 "AccessDenied" -> S3_ACCESS_DENIED, MySQL ER_BAD_FIELD_ERROR -> DB_SCHEMA_MISMATCH,
 * Google "invalid_grant" -> GMAIL_BAD_CREDENTIALS, Node ECONNREFUSED -> <SOURCE>_UNREACHABLE.
 * It reads the shapes of the libraries we use: AWS SDK v3 (name + $metadata.httpStatusCode), gaxios / googleapis
 * (response.status + response.data.error), gRPC (Pub/Sub numeric code), mysql2 (code / errno, also inside TypeORM's
 * QueryFailedError.driverError), fetch (cause.code, TimeoutError) and our own AppError.
 */

export interface ErrorFacts {
  kind: FailureKind;
  /** HTTP status of the service's answer, when there was one. */
  status?: number;
  /** The service's own error code / name (AccessDenied, ER_DUP_ENTRY, invalid_grant, ECONNRESET ...). */
  errorCode?: string;
  /** The service's message, secrets masked. */
  error: string;
}

const NETWORK = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'PROTOCOL_CONNECTION_LOST', 'ECONNABORTED']);
const TIMEOUTS = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'TimeoutError', 'RequestTimeout', 'UND_ERR_HEADERS_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT']);

/** mysql2 error codes -> kind. */
const MYSQL: Record<string, FailureKind> = {
  ER_BAD_FIELD_ERROR: 'SCHEMA_MISMATCH', ER_NO_SUCH_TABLE: 'SCHEMA_MISMATCH', ER_BAD_TABLE_ERROR: 'SCHEMA_MISMATCH',
  ER_DUP_ENTRY: 'DUPLICATE',
  ER_NO_REFERENCED_ROW: 'LINK_BROKEN', ER_NO_REFERENCED_ROW_2: 'LINK_BROKEN', ER_ROW_IS_REFERENCED: 'LINK_BROKEN', ER_ROW_IS_REFERENCED_2: 'LINK_BROKEN',
  ER_DATA_TOO_LONG: 'VALUE_TOO_LONG',
  ER_BAD_NULL_ERROR: 'BAD_VALUE', WARN_DATA_TRUNCATED: 'BAD_VALUE', ER_TRUNCATED_WRONG_VALUE: 'BAD_VALUE', ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: 'BAD_VALUE', ER_WARN_DATA_OUT_OF_RANGE: 'BAD_VALUE', ER_NO_DEFAULT_FOR_FIELD: 'BAD_VALUE',
  ER_LOCK_WAIT_TIMEOUT: 'LOCKED', ER_LOCK_DEADLOCK: 'LOCKED',
  ER_ACCESS_DENIED_ERROR: 'BAD_CREDENTIALS', ER_DBACCESS_DENIED_ERROR: 'ACCESS_DENIED', ER_TABLEACCESS_DENIED_ERROR: 'ACCESS_DENIED',
  ER_BAD_DB_ERROR: 'CONFIG',
  ER_PARSE_ERROR: 'BAD_REQUEST',
  ER_CON_COUNT_ERROR: 'UNAVAILABLE', ER_SERVER_SHUTDOWN: 'UNAVAILABLE',
};

/** AWS S3 error names -> kind. */
const AWS: Record<string, FailureKind> = {
  NoSuchKey: 'NOT_FOUND', NotFound: 'NOT_FOUND',
  NoSuchBucket: 'CONFIG', PermanentRedirect: 'CONFIG', AuthorizationHeaderMalformed: 'CONFIG',
  AccessDenied: 'ACCESS_DENIED', AllAccessDisabled: 'ACCESS_DENIED',
  InvalidAccessKeyId: 'BAD_CREDENTIALS', SignatureDoesNotMatch: 'BAD_CREDENTIALS', ExpiredToken: 'BAD_CREDENTIALS',
  CredentialsProviderError: 'BAD_CREDENTIALS', InvalidToken: 'BAD_CREDENTIALS',
  SlowDown: 'RATE_LIMITED', ThrottlingException: 'RATE_LIMITED',
  InternalError: 'UNAVAILABLE', ServiceUnavailable: 'UNAVAILABLE',
  EntityTooLarge: 'BAD_REQUEST', InvalidArgument: 'BAD_REQUEST',
};

/** gRPC status numbers (Pub/Sub) -> kind. */
const GRPC: Record<number, FailureKind> = { 3: 'BAD_REQUEST', 4: 'TIMEOUT', 5: 'NOT_FOUND', 7: 'ACCESS_DENIED', 8: 'RATE_LIMITED', 13: 'UNAVAILABLE', 14: 'UNAVAILABLE', 16: 'BAD_CREDENTIALS' };

/** Google OAuth error strings -> kind. */
const OAUTH: Record<string, FailureKind> = {
  invalid_grant: 'BAD_CREDENTIALS', invalid_client: 'BAD_CREDENTIALS', unauthorized_client: 'BAD_CREDENTIALS',
  invalid_scope: 'ACCESS_DENIED', insufficientPermissions: 'ACCESS_DENIED', redirect_uri_mismatch: 'BAD_REQUEST',
  rateLimitExceeded: 'RATE_LIMITED', userRateLimitExceeded: 'RATE_LIMITED', quotaExceeded: 'RATE_LIMITED',
};

/** HTTP status -> kind (any web service). */
export const kindOfStatus = (status: number): FailureKind =>
  status === 401 ? 'BAD_CREDENTIALS'
    : status === 403 ? 'ACCESS_DENIED'
      : status === 404 || status === 410 ? 'NOT_FOUND'
        : status === 408 ? 'TIMEOUT'
          : status === 429 ? 'RATE_LIMITED'
            : status >= 500 ? 'UNAVAILABLE'
              : status >= 400 ? 'BAD_REQUEST'
                : 'ERROR';

type Loose = {
  name?: string; code?: unknown; errno?: unknown; message?: string; status?: unknown; statusCode?: unknown;
  $metadata?: { httpStatusCode?: number };
  response?: { status?: number; data?: { error?: unknown; error_description?: string } };
  errors?: { reason?: string }[];
  cause?: { code?: string; name?: string; message?: string };
  driverError?: Loose;
};

export const classifyError = (source: LogSource, err: unknown): ErrorFacts => {
  const e = (err ?? {}) as Loose;
  const inner = e.driverError ?? e; // TypeORM QueryFailedError wraps the mysql2 error
  const message = maskText(String(inner.message ?? e.message ?? err));
  const name = String(inner.name ?? '');
  const code = typeof inner.code === 'string' ? inner.code : undefined;
  const causeCode = e.cause?.code ?? e.cause?.name;
  const data = e.response?.data;
  const googleReason = typeof data?.error === 'string' ? data.error
    : (data?.error as { errors?: { reason?: string }[]; status?: string } | undefined)?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  const status = e.$metadata?.httpStatusCode ?? e.response?.status ?? (typeof e.status === 'number' ? e.status : undefined)
    ?? (typeof e.statusCode === 'number' && !(err instanceof AppError) ? e.statusCode : undefined);

  const facts = (kind: FailureKind, errorCode?: string): ErrorFacts => ({ kind, status, errorCode: errorCode ?? code ?? (name || undefined), error: message });

  if (code && MYSQL[code]) return facts(MYSQL[code], code);
  if (code && (NETWORK.has(code))) return facts('UNREACHABLE', code);
  if (causeCode && NETWORK.has(causeCode)) return facts('UNREACHABLE', causeCode);
  if ((code && TIMEOUTS.has(code)) || TIMEOUTS.has(name) || (causeCode && TIMEOUTS.has(causeCode))) return facts('TIMEOUT', code ?? name);
  if (code === 'ENOENT' && source === LOG_SOURCE.OCR) return facts('NOT_INSTALLED', code);
  if (code === 'ENOENT') return facts('CONFIG', code);
  if (AWS[name]) return facts(AWS[name], name);
  if (googleReason && OAUTH[googleReason]) return facts(OAUTH[googleReason], googleReason);
  if (typeof e.code === 'number' && source === LOG_SOURCE.PUBSUB && GRPC[e.code]) return facts(GRPC[e.code], `grpc ${e.code}`);
  if (status) return facts(kindOfStatus(status), googleReason ?? code ?? (name || undefined));
  if (/fetch failed/i.test(message)) return facts('UNREACHABLE', causeCode);
  return facts('ERROR');
};

/**
 * Logs a caught error of a source with its reason and fix, e.g. in a catch block:
 *   catch (err) { logError(LOG_SOURCE.S3, 'startup sync failed (the next sync retries)', err, { dir }) }
 */
export const logError = (source: LogSource, msg: string, err: unknown, fields: LogFields = {}): ErrorFacts => {
  const f = classifyError(source, err);
  // failedAt: the file and line in our code (2026-10-27)
  logFailure(source, f.kind, msg, { status: f.status, errorCode: f.errorCode, error: f.error, failedAt: whereFailed(err), ...fields });
  return f;
};
