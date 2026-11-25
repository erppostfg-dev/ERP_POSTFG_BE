/*
 * POs punched in Uniware OUTSIDE POST_FG (2026-11-25, user: "if some are rejected in review they make a sale order
 * outside and punch it in Uniware; if it is in Uniware and not processed in review or not downloaded and punched,
 * show a warning so they can check those POs"). Read-only on Uniware: saleOrder/search.
 *
 * How (probed read-only 2026-11-25 on the dev account):
 *   - saleOrder/search WITHOUT orderCategory answers B2C orders only (thousands an hour: Meesho, Shopify ...); WITH
 *     orderCategory "B2B" it answers the B2B ones (ours: BLINKIT_B2B ..., erp_ codes and sf_ / other codes), each with
 *     code, displayOrderCode (= the PO number, as our CSV sends it), channel (Uniware channel), status, created;
 *   - fromDate / toDate in epoch ms + dateType CREATED; one call per window covers every channel: a run is 1-2 calls.
 *   - match: Uniware channel = a details_channels.channel_code of the PO's channel AND displayOrderCode = the PO number;
 *     our own sale order code (orderNo1) is never a finding; a PO already marked uploaded is not one either.
 */

export const UNIWARE_OUTSIDE = {
  SEARCH: '/services/rest/v1/oms/saleOrder/search',
  ORDER_CATEGORY: 'B2B',
  DATE_TYPE: 'CREATED',
  /** MySQL lock (one server at a time) + job name + app_state key of the run state / the button. */
  LOCK: 'uniware-outside-check',
  JOB: 'uniware-outside-check',
  STATE_KEY: 'uniware-outside:state',
  BUTTON_STATE_KEY: 'uniware-outside:button',
  /** Timed runs every EVERY_MIN; the first one FIRST_DELAY_MS after a start (not with the deploy's other jobs). */
  EVERY_MIN: 120,
  FIRST_DELAY_MS: 6 * 60_000,
  /**
   * First run reads BACKFILL_DAYS back; each call reads at most STEP_HOURS; at most MAX_CALLS_PER_RUN calls a run.
   * 2026-11-25 (first dev run: 8 calls of 24 h = 1,009 B2B orders in 14.5 s, ~126 a day): 48 h a call + 15 calls = the
   * 30-day catch-up in ONE run (~30 s, ~250 orders / ~100 KB a call); a normal run (2 h) stays 1 call.
   */
  BACKFILL_DAYS: 30,
  STEP_HOURS: 48,
  MAX_CALLS_PER_RUN: 15,
  /** A new run starts OVERLAP_MIN before the end of the last one (orders created during a run are not missed). */
  OVERLAP_MIN: 30,
  /** The API user is shared with in-transit, D2C and the PO sync: one call at a time, a pause between. */
  CALL_GAP_MS: 1500,
  /** "Check Uniware now": one click per BUTTON_EVERY_MIN for the whole team. */
  BUTTON_EVERY_MIN: 30,
  /** Uniware statuses that are not a real order (nothing to warn about). */
  IGNORED_STATUSES: ['CANCELLED'] as readonly string[],
  REMARK_MAX: 500,
  ROUTES: { STATUS: '/uniware-outside', CHECK: '/uniware-outside/check', RESOLVE: '/uniware-outside/:id/resolve' },
} as const;

/** Where the PO was in POST_FG when Uniware was found to have it. */
export const UNIWARE_OUTSIDE_KIND = { REVIEW: 'review', REJECTED: 'rejected', PROCESSED: 'processed' } as const;
export type UniwareOutsideKind = (typeof UNIWARE_OUTSIDE_KIND)[keyof typeof UNIWARE_OUTSIDE_KIND];

export const UNIWARE_OUTSIDE_STATE = { OPEN: 'open', RESOLVED: 'resolved' } as const;
export type UniwareOutsideState = (typeof UNIWARE_OUTSIDE_STATE)[keyof typeof UNIWARE_OUTSIDE_STATE];

/**
 * What the person did (POST .../resolve { action, remark }):
 *   reject       In Review: the PO is rejected here ("punched in Uniware outside POST_FG as <code>"), nothing made;
 *   use_code     Processed, not uploaded: the saved PO takes Uniware's code (our erp_ code noted as not used) and is
 *                marked uploaded, so PO Overview + the Uniware sync follow the real order;
 *   acknowledge  Rejected: noted (the PO stays rejected);
 *   dismiss      any: not the same order (remark required).
 */
export const UNIWARE_OUTSIDE_ACTION = { REJECT: 'reject', USE_CODE: 'use_code', ACKNOWLEDGE: 'acknowledge', DISMISS: 'dismiss' } as const;
export type UniwareOutsideAction = (typeof UNIWARE_OUTSIDE_ACTION)[keyof typeof UNIWARE_OUTSIDE_ACTION];

/** Which actions fit which kind. */
export const UNIWARE_OUTSIDE_ACTIONS_FOR: Record<UniwareOutsideKind, readonly UniwareOutsideAction[]> = {
  review: ['reject', 'dismiss'],
  rejected: ['acknowledge', 'dismiss'],
  processed: ['use_code', 'dismiss'],
};

export const UNIWARE_OUTSIDE_TEXT = {
  REJECT_REMARK: (code: string, remark: string) => `Punched in Uniware outside POST_FG as ${code}${remark ? `: ${remark}` : ''}`,
  USE_CODE_REMARK: (code: string, ours: string | null, remark: string) =>
    `${code} found in Uniware (punched outside POST_FG)${ours ? `; our ${ours} not used` : ''}${remark ? `: ${remark}` : ''}`,
} as const;
