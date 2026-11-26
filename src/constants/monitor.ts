/*
 * Admin > Monitor (2026-11-05, developers only): the server's own CloudWatch logs and metrics in the app. Read with the
 * EC2's OWN role (instance metadata), never with AWS keys from .env: on a laptop it says "not on the server".
 */
export const MONITOR = {
  /** Windows the page offers, in seconds. */
  WINDOWS: { '1h': 3600, '24h': 86_400, '7d': 604_800 } as Record<string, number>,
  DEFAULT_WINDOW: '24h',
  /** A Logs Insights query is given this long, polled every POLL_MS. */
  QUERY_TIMEOUT_MS: 25_000,
  POLL_MS: 700,
  /** The same view asked again within this time is answered from memory (each Logs Insights scan is metered). */
  CACHE_SECONDS: 60,
  /** Newest alerts listed. */
  ALERT_LIMIT: 100,
  /** "What was running": the health line covers the 5 minutes before it. */
  PEAK_BEFORE_MS: 5 * 60_000,
  PEAK_AFTER_MS: 60_000,
  PEAK_LIMIT: 25,
  /** Instance metadata (IMDSv2) on EC2; unreachable on a laptop. */
  IMDS_TIMEOUT_MS: 1000,
  ROUTES: {
    ACCESS: '/monitor/access', OVERVIEW: '/monitor/overview', PEAK: '/monitor/peak',
    ERRORS: '/monitor/errors', ERRORS_COUNT: '/monitor/errors/count', ERROR_REQUEST: '/monitor/errors/request/:requestId',
  },
} as const;

/*
 * Admin > Monitor > Errors (2026-11-26, user: "we need to see these errors in a tab so we see the problems immediately
 * and solve them"). Read from CloudWatch (no table): what people were refused / what failed on the server (API lines),
 * what failed in the background (warn / error lines of jobs), and what failed in a browser (CLIENT_ERROR lines).
 */
export const MONITOR_ERRORS = {
  /** Groups listed per kind. */
  LIMIT: 100,
  /** The tab's red count (errors of the last hour) is asked at most this often (each scan is metered). */
  COUNT_CACHE_SECONDS: 300,
  COUNT_WINDOW_SECONDS: 3600,
  /** Refusals that are not problems: a signed-out check. */
  SKIP_ERROR_CODES: ['UNAUTHENTICATED'],
  /** API lines that are errors a person saw. */
  API_CODES: ['API_SERVER_ERROR', 'API_CLIENT_ERROR'],
  /** warn / error lines that are not failures (load hints, shown elsewhere in the Monitor). */
  NOT_FAILURES: ['API_SLOW', 'API_TOO_MANY_QUERIES', 'API_RESPONSE_LARGE', 'API_REPEATED_CALLS', 'API_SERVER_ERROR', 'API_CLIENT_ERROR', 'CLIENT_ERROR'],
  /** One request's lines: looked for this far back, at most this many. */
  REQUEST_LOOKBACK_DAYS: 7,
  REQUEST_LINES: 200,
  REQUEST_ID_PATTERN: /^[A-Za-z0-9._:-]{4,100}$/,
  KINDS: ['server', 'background', 'browser'] as const,
} as const;
export type MonitorErrorKind = (typeof MONITOR_ERRORS.KINDS)[number];

/*
 * POST /client-errors (2026-11-26): a browser tells the server about an error the server never saw (page crash,
 * server unreachable, page file missing after a deploy); the server writes one CLIENT_ERROR log line. No table.
 */
export const CLIENT_ERRORS = {
  BASE: '/client-errors',
  ROUTES: { REPORT: '/' },
  KINDS: ['crash', 'network', 'stale_chunk', 'other'] as const,
  /** Lines per person per minute; more are dropped (a crash loop must not flood the logs). */
  PER_MINUTE: 20,
  MESSAGE_MAX: 1000,
  FIELD_MAX: 200,
} as const;
export type ClientErrorKind = (typeof CLIENT_ERRORS.KINDS)[number];

/** The CloudWatch read permissions the Monitor uses, as shown in its "AWS access" panel. */
export const MONITOR_ACCESS = {
  DESCRIBE_LOG_GROUPS: 'logs:DescribeLogGroups',
  START_QUERY: 'logs:StartQuery + GetQueryResults',
  FILTER_LOG_EVENTS: 'logs:FilterLogEvents',
} as const;
