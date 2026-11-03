/*
 * Price check in PO review (user, 2026-10-30). A price or MRP mismatch is decided per line, by clicking: OURS (the sale
 * order keeps our master value; the line goes on the list to tell the channel) or CHANNEL (the sale order takes the PO's
 * value for this PO; optionally "update master": the channel SKU gets the PO's value when the PO is approved). Anyone who
 * may edit PO Processing & Review may tick it; the approver sees it before it applies.
 *
 * Price differences (to tell the channel): every approved line decided OURS, per PO and per channel, with an email
 * draft (subject, body, attachment) to copy and send by hand; "Mark as sent" keeps who / when. Sending from the app and
 * the channel's "To" address: later (user).
 */

export const PRICE_CHOICE = { OURS: 'ours', CHANNEL: 'channel' } as const;
export type PriceChoice = (typeof PRICE_CHOICE)[keyof typeof PRICE_CHOICE];

/** Which value a po_price_differences row is about. */
export const PRICE_DIFF_FIELD = { PRICE: 'price', MRP: 'mrp' } as const;
export type PriceDiffField = (typeof PRICE_DIFF_FIELD)[keyof typeof PRICE_DIFF_FIELD];

export const PRICE_DIFFS = {
  BASE: '/price-differences',
  ROUTES: { GROUPS: '/', LINES: '/lines', DRAFT: '/draft', SENT: '/sent' },
  /** Grouped by PO or by channel. */
  VIEW: { PO: 'po', CHANNEL: 'channel' },
  /** not sent / sent / both. */
  STATUS: { OPEN: 'open', SENT: 'sent', ALL: 'all' },
  QUERY: { VIEW: 'view', STATUS: 'status', CHANNEL: 'channel', UPLOAD_ID: 'uploadId', FROM: 'from', TO: 'to' },
  BODY: { IDS: 'ids' },
  /** At most this many groups / lines in one answer. */
  LIST_LIMIT: 500,
  LINES_LIMIT: 5000,
  /** Lines named in the email body; the rest are in the attachment. */
  BODY_LINES_MAX: 25,
} as const;

/** The email draft (one place to change the wording; sent by hand for now). */
export const PRICE_DIFF_EMAIL = {
  SUBJECT: (channel: string, what: string, date: string) => `mCaffeine | Price differences | ${channel} | ${what} | ${date}`,
  WHAT_PO: (po: string) => `PO ${po}`,
  WHAT_POS: (n: number) => `${n} POs`,
  GREETING: 'Hi team,',
  INTRO: 'On the PO(s) below your price / MRP differs from the agreed one. We have processed them at our agreed values. Please update your system so future POs carry the right values.',
  PO_LINE: (po: string, date: string) => `PO ${po}${date ? ` (${date})` : ''}`,
  ITEM: (product: string, code: string, field: string, theirs: string, ours: string) => `  ${product} · ${code} · ${field}: PO ${theirs} · Agreed ${ours}`,
  MORE: (n: number) => `  … and ${n} more line(s) in the attachment`,
  ATTACHED: 'The full list is attached.',
  SIGN: (name: string) => `Regards,\n${name}\nmCaffeine`,
  FILE: (channel: string, what: string, date: string) => `price_differences_${`${channel}_${what}`.replace(/[^A-Za-z0-9]+/g, '_')}_${date}`,
  FIELD_LABEL: { price: 'Price', mrp: 'MRP' } as Record<string, string>,
} as const;
