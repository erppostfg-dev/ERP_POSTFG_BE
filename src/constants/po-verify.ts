/*
 * PO verification before Uniware (user, 2026-10-22). Every PO on the Processed tab (old and new) is checked by a person
 * against the original PO, side by side, before its sale order CSV can be downloaded or marked uploaded:
 *   verify     -> po_verifications row `verified` (who, when): the CSV is unlocked;
 *   send back  -> row `sent_back` with the remark: the saved PO is cancelled (statusActive Inactive, kept for history,
 *                 nothing deleted), the PO goes back to In Review with the remark as an open issue; once fixed and
 *                 approved it gets a NEW PO row + sale order code + CSV, and must be verified again.
 * Built so it can be removed later (user: "if 100% processed is correct, no need"): its own table, module, routes and a
 * gate in front of the existing hand-off routes (none of the existing APIs changed). PO_VERIFY_REQUIRED=false in
 * .env is the default for a channel; each channel has its own ON / OFF switch (po_verify_channel_settings, 2026-10-22).
 */

export const PO_VERIFY_ACTION = { VERIFIED: 'verified', SENT_BACK: 'sent_back' } as const;
export type PoVerifyAction = (typeof PO_VERIFY_ACTION)[keyof typeof PO_VERIFY_ACTION];

/** Where a processed PO stands for the Processed tab. */
export const PO_VERIFY_STATE = {
  VERIFIED: 'verified',
  TO_VERIFY: 'to_verify',
  /** Already marked uploaded into Uniware (before this step existed): nothing left to check. */
  NOT_NEEDED: 'not_needed',
  /** Its channel's switch is OFF: the CSV is not locked; verifying is optional. */
  NOT_REQUIRED: 'not_required',
} as const;
export type PoVerifyState = (typeof PO_VERIFY_STATE)[keyof typeof PO_VERIFY_STATE];

export const PO_VERIFY = {
  BASE: '/po-verify',
  ROUTES: {
    STATES: '/', ONE: '/:uploadId', VERIFY: '/:uploadId/verify', SEND_BACK: '/:uploadId/send-back',
    /** The per-channel switch (Users & Roles -> Settings; admin / developer). Registered before /:uploadId. */
    SETTINGS: '/settings', SETTING: '/settings/:channel',
  },
  BODY_REQUIRED: 'required',
  QUERY_IDS: 'uploadIds',
  BODY_REMARK: 'remark',
  /** States asked for at most this many uploads per call (the Processed tab loads up to 500). */
  MAX_IDS: 500,
  REMARK_MAX: 500,
  /** A line's saved rate may differ from the PO's by this much (₹) before it is flagged (as validation's tolerance). */
  RATE_TOLERANCE: 2,
  ISSUE_TEXT: (remark: string, by: string) => `Verification: ${remark} (sent back by ${by})`,
} as const;
