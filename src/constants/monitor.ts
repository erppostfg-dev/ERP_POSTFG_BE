/*
 * Admin > Monitor (2026-11-05, developers only): the server's own CloudWatch logs and metrics in the app. Read with the
 * EC2's OWN role (instance metadata), never with AWS keys from .env: on a laptop it says "not on the server".
 */
export const MONITOR = {
  /** Windows the page offers, in seconds. */
  WINDOWS: { '1h': 3600, '24h': 86_400, '7d': 604_800 } as Record<string, number>,
  DEFAULT_WINDOW: '24h',
  /** Metric period (seconds) per window: 5 minutes, except 1 hour for 7 days. */
  PERIOD: { '1h': 300, '24h': 300, '7d': 3600 } as Record<string, number>,
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
  ROUTES: { ACCESS: '/monitor/access', OVERVIEW: '/monitor/overview', PEAK: '/monitor/peak' },
} as const;

/** The CloudWatch read permissions the Monitor uses, as shown in its "AWS access" panel. */
export const MONITOR_ACCESS = {
  DESCRIBE_LOG_GROUPS: 'logs:DescribeLogGroups',
  START_QUERY: 'logs:StartQuery + GetQueryResults',
  FILTER_LOG_EVENTS: 'logs:FilterLogEvents',
  GET_METRIC_DATA: 'cloudwatch:GetMetricData',
  DESCRIBE_ALARMS: 'cloudwatch:DescribeAlarms',
} as const;
