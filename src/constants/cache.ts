/*
 * Shared cache (2026-11-10, user: "use the AWS service, clear the cache on any add / update, keep 60 s"). modules/cache:
 * AWS ElastiCache (Redis OSS / Valkey) when REDIS_URL is set, else this server's memory (laptop, tests, scripts, and
 * whenever Redis does not answer). Every answer is kept at most CACHE_TTL_SECONDS (default 60) and dropped AT ONCE by the
 * write that changes it (forgetCache), so the time limit is only the safety net. Settings: config/env.ts `cache`.
 */
export const CACHE = {
  /** Default life of a cached answer (CACHE_TTL_SECONDS overrides). */
  TTL_SECONDS: 60,
  /** Default start of every key (CACHE_KEY_PREFIX overrides: one ElastiCache can then serve dev and prod apart). */
  KEY_PREFIX: 'postfg:',
  /** Memory store: at most this much RAM for all answers (CACHE_MEMORY_MAX_MB overrides), oldest dropped first. Never disk. */
  MEMORY_MAX_MB: 64,
  /** Memory store: at most this many answers (oldest dropped first). */
  MEMORY_MAX_KEYS: 5_000,
  /** A bigger answer is not cached (served from the DB every time; logged once per key per 10 min). */
  VALUE_MAX_KB: 4_096,
  /** A Redis command that takes longer fails and the request goes on without Redis. */
  COMMAND_TIMEOUT_MS: 500,
  CONNECT_TIMEOUT_MS: 5_000,
  /** Reconnect waits grow to at most this. */
  RETRY_MAX_MS: 30_000,
  /** Repeats are quiet: "still down" and a repeated command error at most once per this (the first one always). */
  REPEAT_LOG_EVERY_MS: 300_000,
  /** One CACHE_STATS summary every this many minutes when the cache was used (CACHE_STATS_MINUTES; 0 = never). */
  STATS_EVERY_MINUTES: 60,
  /** "Not cached: too big" for the same key at most once per this. */
  TOO_BIG_LOG_EVERY_MS: 3_600_000,
} as const;

/**
 * What to fix, from the words of a Redis / network error (first match wins). Written on CACHE_DOWN / CACHE_<FAILURE> lines
 * as `fix`, so the line alone says what to change. `kind` = the failure kind (constants/logging FAILURES).
 */
export const CACHE_HINTS: readonly { test: RegExp; kind: 'UNREACHABLE' | 'BAD_CREDENTIALS' | 'TIMEOUT' | 'CONFIG' | 'ERROR'; fix: string }[] = [
  { test: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i, kind: 'CONFIG', fix: 'The host in REDIS_URL does not exist: copy the Primary endpoint (or Configuration endpoint) of the ElastiCache cluster.' },
  { test: /NOAUTH|WRONGPASS|invalid username-password|AUTH failed|ERR AUTH/i, kind: 'BAD_CREDENTIALS', fix: 'REDIS_PASSWORD (ElastiCache AUTH token) is missing or wrong, or REDIS_USERNAME does not match the RBAC user. Fix it in SSM and redeploy.' },
  { test: /wrong version number|EPROTO|SSL|TLS|certificate/i, kind: 'CONFIG', fix: 'TLS mismatch: in-transit encryption ON needs rediss:// (or REDIS_TLS=true); OFF needs redis://.' },
  { test: /MOVED|CLUSTERDOWN|CROSSSLOT|cluster support disabled/i, kind: 'CONFIG', fix: 'This is a cluster (ElastiCache Serverless or cluster mode enabled): set REDIS_CLUSTER=true and use the Configuration endpoint.' },
  { test: /READONLY/i, kind: 'CONFIG', fix: 'REDIS_URL points to a replica (Reader endpoint): use the Primary endpoint.' },
  { test: /OOM|maxmemory/i, kind: 'CONFIG', fix: 'Redis memory is full and it does not drop old keys: set maxmemory-policy = allkeys-lru in the parameter group (or a bigger node).' },
  { test: /Command timed out/i, kind: 'TIMEOUT', fix: 'Redis took over 500 ms: check the ElastiCache CPU / memory / network metrics (or the EC2 network). Answers come from memory meanwhile.' },
  { test: /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|connect timeout|Connection is closed|Stream isn't writeable/i, kind: 'UNREACHABLE', fix: 'Redis cannot be reached: the ElastiCache security group must allow TCP 6379 from the EC2 security group, both in the same VPC; check the host / port in REDIS_URL; with encryption ON the URL must be rediss:// (a reset right after connecting = TLS needed).' },
];

/** What is cached (the first part of every key). forgetCache(ns) drops every answer of one kind. */
export const CACHE_NS = {
  /** Approvals lists + the sidebar badge (GET /approvals/po-reviews): dropped on every review change (bumpReview). */
  APPROVALS: 'approvals',
  /** The Feedback bell per person (GET /feedback/notifications): dropped when someone is notified / reads. */
  FEEDBACK_BELL: 'feedback-bell',
  /** Masters lists + Add form choices (GET /masters/...): dropped on any master add / edit / switch / approval. */
  MASTERS: 'masters',
  /** PO Overview dropdowns (GET /po-overview/filter-options): dropped on a new / changed PO and a master change. */
  PO_OVERVIEW_FILTERS: 'po-overview-filters',
  /** PO issues per channel (GET /po-review/issues): dropped on review / master changes (was in memory since 2026-10-29). */
  PO_ISSUES: 'po-issues',
} as const;
export type CacheNs = (typeof CACHE_NS)[keyof typeof CACHE_NS];

/** Where answers are kept right now (GET /health `cache`, log lines). */
export const CACHE_MODE = {
  REDIS: 'redis',
  MEMORY: 'memory',
  /** REDIS_URL is set but Redis does not answer: memory until it is back. */
  REDIS_DOWN: 'redis_down',
  /** CACHE_ENABLED=false: nothing is cached. */
  OFF: 'off',
} as const;
export type CacheMode = (typeof CACHE_MODE)[keyof typeof CACHE_MODE];
