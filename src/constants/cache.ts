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
  /** Memory store: at most this many answers (oldest dropped first). */
  MEMORY_MAX_KEYS: 5_000,
  /** A bigger answer is not cached (served from the DB every time; logged once per key per 10 min). */
  VALUE_MAX_KB: 4_096,
  /** A Redis command that takes longer fails and the request goes on without Redis. */
  COMMAND_TIMEOUT_MS: 500,
  CONNECT_TIMEOUT_MS: 5_000,
  /** Reconnect waits grow to at most this. */
  RETRY_MAX_MS: 30_000,
  /** Redis errors are logged at most once per this (the first one always). */
  ERROR_LOG_EVERY_MS: 60_000,
  /** A summary line (hits / misses per kind) every this many minutes, only when the cache was used. */
  STATS_EVERY_MINUTES: 15,
} as const;

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
