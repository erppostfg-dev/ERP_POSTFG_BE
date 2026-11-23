/*
 * Dates for test data that must stay valid whatever day the tests run (2026-11-23).
 * Why: the PO checks compare the expiry date with TODAY (validate-po todayIst). A fixed future expiry in test data
 * passes until that day and then turns the PO "expired" -> In Review: tests fail and CI blocks every deploy
 * (First Club data with expiry 2026-11-22 did that on 23 Nov). Use these for every expiry date a test runs through
 * the chain with the real clock; test/meta/test-dates.test.ts refuses a fixed future expiry date.
 */

/** YYYY-MM-DD, `days` after today (UTC). */
export const daysFromNow = (days: number, now = new Date()): string =>
  new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** A YYYY-MM-DD date as a channel prints it: DD<sep>MM<sep>YYYY (Purplle 06.12.2026, others 06-12-2026 / 06/12/2026). */
export const dmy = (iso: string, sep = '.'): string => iso.split('-').reverse().join(sep);

/** An expiry date always a year ahead: a PO with it is never expired. */
export const FUTURE_EXPIRY = daysFromNow(365);
