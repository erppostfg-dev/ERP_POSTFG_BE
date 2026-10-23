/*
 * PO issues per channel (user, 2026-10-22; Users & Roles -> PO issues, admin / developer): counts from what is already
 * stored (po_uploads, po_issues, po_review_submissions, po_verifications), once per PO. No table of its own.
 */
export const PO_ISSUES = {
  BASE: '/admin/po-issues',
  ROUTES: { LIST: '/', POS: '/pos' },
  QUERY: { DAYS: 'days', CHANNEL: 'channel', KIND: 'kind', ITEM: 'item' },
  /** Window choices (days back from now, on the PO's arrival); default 30. */
  DAYS: [7, 30, 90, 365] as readonly number[],
  DEFAULT_DAYS: 30,
  /** Kinds besides the po_issues types. */
  KIND: { REJECTED: 'REJECTED', SENT_BACK: 'SENT_BACK' },
  /** Items listed per kind, POs listed per click, characters of a problem's text used as its item. */
  ITEMS_MAX: 200,
  POS_MAX: 200,
  ITEM_MAX: 120,
  /** The live "still a problem?" words (po-issues.service liveChecks). */
  NOTE: {
    SKU_IN_MASTER: 'In the SKU master now',
    SKU_MISSING: 'Still missing in the SKU master',
    SKU_AMBIGUOUS: (n: number) => `${n} rows in the SKU master for this code (pick one)`,
    LOCATION_FOUND: 'Location found and complete now',
    LOCATION_MISSING: 'Still no matching location',
    LOCATION_MANY: (n: number) => `Matches ${n} locations (needs one)`,
    LOCATION_INCOMPLETE: 'Location found but customer code / facility / channel code missing',
    MATCHES_NOW: (what: string) => `Master ${what} matches the PO now`,
    STILL_DIFFERS: (what: string, ours: string, po: string) => `Master ${what} ${ours} vs PO ${po}`,
    OPEN_IN_REVIEW: 'Still open in review',
    RESOLVED_IN_REVIEW: 'Resolved in review',
    FINAL: 'Final outcome',
  },
} as const;
