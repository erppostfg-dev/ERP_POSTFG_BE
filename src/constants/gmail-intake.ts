/*
 * Gmail intake load (2026-10-29, user: "the approach that actually reduces the load on server and DB and waste calls";
 * backlog B1). The mailbox's Gmail limit is 6,000 units per minute per user (Google lowered it from 15,000); on 28 Oct
 * ten catch-ups each downloaded the whole Po-Intake label (~120 emails) to find their own channel's emails -> 429.
 *   1. Each email is read once: its channel is kept in gmail_messages (headers only when we may not take it), so a
 *      later catch-up picks its emails from the DB with no Gmail call.
 *   2. Catch-ups of several channels run as one pass (one list, each email read once for all of them).
 *   3. Every Gmail call of the intake goes through one pace (units per minute) and waits + retries on a rate limit.
 *   4. A catch-up is a row (intake_catchups): a failed one tries again by itself, also after a restart.
 */

/** Gmail API cost of each call we make, in quota units (Gmail's published table). */
export const GMAIL_UNITS = {
  MESSAGES_LIST: 5,
  MESSAGES_GET: 5,
  ATTACHMENT_GET: 5,
  HISTORY_LIST: 2,
  GET_PROFILE: 1,
  LABELS_LIST: 1,
  WATCH: 100,
} as const;

export const GMAIL_PACE = {
  /** Our share of the mailbox's 6,000 units / minute (half: room for anything else using it). GMAIL_UNITS_PER_MINUTE overrides. */
  UNITS_PER_MINUTE: 3_000,
  /** At most this part of a minute's units may be spent at once (Gmail also refuses short bursts). */
  BURST_SECONDS: 5,
  /** A call refused for the rate limit is tried this many times in all, waiting longer each time. */
  MAX_TRIES: 6,
  FIRST_WAIT_MS: 1_000,
  MAX_WAIT_MS: 60_000,
} as const;

/** Headers read when an email is only looked at (who sent it -> its channel; Message-ID -> already stored?). */
export const GMAIL_META_HEADERS = ['From', 'Subject', 'X-Original-Sender', 'Reply-To', 'Message-ID'] as const;

export const CATCHUP_STATUS = { WAITING: 'waiting', RUNNING: 'running', DONE: 'done', FAILED: 'failed' } as const;
export type CatchupStatus = (typeof CATCHUP_STATUS)[keyof typeof CATCHUP_STATUS];

export const CATCHUP = {
  /** Minutes before the 1st, 2nd, ... new try of a failed catch-up (then the last one again). */
  RETRY_MINUTES: [2, 5, 15, 30, 60],
  LAST_ERROR_MAX: 500,
  SUBJECT_MAX: 300,
} as const;
