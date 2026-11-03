/*
 * Mailing lists (2026-10-30, user: "an Email section on Users & Roles ... add people to it"). Every mail the ERP sends
 * is one list here; its recipients (any email address, To / CC / BCC, can be paused) are kept in mail_recipients and
 * managed on Users & Roles -> Email. A new mail type is added to MAIL_LISTS by code and then shows on the page.
 * Sending the mails themselves is wired separately (sendToList in modules/mail/mail-lists.service.ts).
 */

export interface MailListDef {
  /** Stable id, stored with each recipient. */
  key: string;
  name: string;
  /** What the mail holds and when it goes out (shown on the page). */
  description: string;
  /** The part of the ERP it belongs to. */
  area: string;
}

export const MAIL_LIST = {
  INTRANSIT_DAILY: 'intransit-daily',
  INTRANSIT_FETCH_FAILURE: 'intransit-fetch-failure',
  INTRANSIT_FACILITY_CHANGES: 'intransit-facility-changes',
} as const;
export type MailListKey = (typeof MAIL_LIST)[keyof typeof MAIL_LIST];

export const MAIL_LISTS: readonly MailListDef[] = [
  {
    key: MAIL_LIST.INTRANSIT_DAILY,
    name: 'In-transit daily report',
    description: 'GMV, units and COGS per warehouse (stock on hand + in transit) of an in-transit build, with its Stock and B2C-Format-Data-Planning workbooks attached. Sent from the Send mail button on the report of a build.',
    area: 'In-transit Stock',
  },
  {
    key: MAIL_LIST.INTRANSIT_FETCH_FAILURE,
    name: 'In-transit fetch failures',
    description: 'Sent when a Myntra, Flipkart, Amazon or Uniware fetch fails, with what happened and what to do.',
    area: 'In-transit Stock',
  },
  {
    key: MAIL_LIST.INTRANSIT_FACILITY_CHANGES,
    name: 'In-transit facility changes',
    description: 'Monday check of Uniware: facilities enabled there but not in the in-transit report yet, and ones disabled there but still exported / counted.',
    area: 'In-transit Stock',
  },
];

/** mail_recipients.kind: where the address goes in the mail. */
export const RECIPIENT_KIND = { TO: 'to', CC: 'cc', BCC: 'bcc' } as const;
export type RecipientKind = (typeof RECIPIENT_KIND)[keyof typeof RECIPIENT_KIND];

/** Longest email address (RFC 5321). */
export const MAIL_ADDRESS_MAX = 254;
/** A plain address check: something@domain.tld, no spaces (the mail server has the final say). */
export const MAIL_ADDRESS_PATTERN = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
/** Prefix of a mail list's change rows in activity_log (method AUDIT), so its history can be read back. */
export const MAIL_LIST_AUDIT_PREFIX = 'mail-list:';
/** Changes shown by the history (newest first). */
export const MAIL_LIST_HISTORY_LIMIT = 200;

export const MAIL_LISTS_ROUTES = {
  BASE: '/admin/mail-lists',
  LIST: '/',
  ONE: '/:key',
  RECIPIENTS: '/:key/recipients',
  RECIPIENT: '/:key/recipients/:id',
  HISTORY: '/:key/history',
  TEST: '/:key/test',
} as const;

export const MAIL_LIST_BODY = { ENABLED: 'enabled', EMAIL: 'email', KIND: 'kind', PAUSED: 'paused', ONLY_ME: 'onlyMe' } as const;
