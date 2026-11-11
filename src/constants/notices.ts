/*
 * Notices (2026-11-10, user: "I add a person and a message, they get a notification with the message and it stays 2
 * days; not a chat"). One-way notes shown in the top-bar bell (next to Feedback's). No history: every notice is deleted
 * 2 days after it was sent. No delete, no read receipts. Reply = a new notice back to the sender only (never to an
 * "everyone" notice). Admin / developer may send to EVERYONE; everyone else one person per notice.
 * Load: a notice to everyone is ONE row (to_user_id NULL), never one per person; "seen" = one row per person (the newest
 * notice id they have seen), not one per notice; the bell answer comes from a small in-memory list of the active
 * notices (the last 2 days), re-read only after a send or every CACHE_MS: a bell check costs no DB query.
 */

export const NOTICES = {
  BASE: '/notices',
  ROUTES: {
    MINE: '/',
    SEND: '/',
    SEEN: '/seen',
    PEOPLE: '/people',
    SETTINGS: '/settings',
  },
  /** Kept this long, then deleted (on the next send / the hourly sweep); never shown after. */
  KEEP_MS: 2 * 24 * 3600_000,
  TEXT_MAX: 500,
  /** An in-app page path only (starts with "/"), e.g. /operations/po-review?tab=processed. */
  LINK_MAX: 300,
  /** Notices one person may send in 24 hours (replies included). */
  PER_DAY: 20,
  /** The bell shows at most this many (newest first). */
  LIST_MAX: 50,
  /** The active-notice list and the seen marks are re-read from the DB at most this often (a send refreshes at once). */
  CACHE_MS: 60_000,
  /** app_state key of the admin switch { enabled }. Default ON. */
  SETTINGS_KEY: 'notices:settings',
  /** Reply text shows the start of the notice it answers. */
  REPLY_QUOTE_MAX: 60,
} as const;

/** "to" value for a notice to every signed-in person. */
export const NOTICE_TO_EVERYONE = 'everyone';
