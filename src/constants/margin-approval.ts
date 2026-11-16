import { ROLES } from './auth';

/*
 * Two-layer approval of margin changes (2026-11-06, user: "add a 2 layer approval mechanism of margin updates";
 * layer 1 = Operations Manager, layer 2 = Admin; edits AND new channel SKU rows). A change to a channel SKU's margin %
 * or rate after margin (Masters Edit, the price check's "update master") and a new channel SKU row (Masters Add) are
 * saved as a REQUEST; nothing changes in master_channel_skus until both layers approve. POs keep the old rate until then.
 *   pending_l1 --L1 approves--> pending_l2 --L2 approves--> applied (the master row changed / added + its History rows)
 *        \--------------------------\--- either rejects (reason) --> rejected
 * The requester never approves their own request; layer 1 and layer 2 are two different people.
 * 2026-11-10 (user): a NEW channel SKU row (kind add) needs ONE approval only: layer 1 (Operations Manager / admin /
 * developer) adds the row at once (pending_l1 --L1 approves--> applied). Changes to an EXISTING row's margin / rate
 * (kind edit) keep both layers. An add already waiting at pending_l2 (asked before this rule) is added by one more
 * layer 1 approval (any layer 1 person but the requester).
 */

export const MARGIN_REQUEST_KIND = { EDIT: 'edit', ADD: 'add' } as const;
export type MarginRequestKind = (typeof MARGIN_REQUEST_KIND)[keyof typeof MARGIN_REQUEST_KIND];

export const MARGIN_REQUEST_STATUS = { PENDING_L1: 'pending_l1', PENDING_L2: 'pending_l2', APPLIED: 'applied', REJECTED: 'rejected' } as const;
export type MarginRequestStatus = (typeof MARGIN_REQUEST_STATUS)[keyof typeof MARGIN_REQUEST_STATUS];
export const MARGIN_REQUEST_OPEN: readonly MarginRequestStatus[] = [MARGIN_REQUEST_STATUS.PENDING_L1, MARGIN_REQUEST_STATUS.PENDING_L2];

/** Where the request came from. */
export const MARGIN_REQUEST_SOURCE = { MASTERS: 'masters', PRICE_CHECK: 'price_check' } as const;
export type MarginRequestSource = (typeof MARGIN_REQUEST_SOURCE)[keyof typeof MARGIN_REQUEST_SOURCE];

export const MARGIN_APPROVAL = {
  /** Layer 1: Operations Manager (admin / developer may act too). */
  L1_ROLES: ['operations-manager', ROLES.ADMIN, ROLES.DEVELOPER] as readonly string[],
  /** Layer 2, the final approval: Admin (developer may act too). */
  L2_ROLES: [ROLES.ADMIN, ROLES.DEVELOPER] as readonly string[],
  /** How many approvals each kind needs (add = new channel SKU: one; edit = existing row's margin / rate: two). */
  APPROVALS_NEEDED: { add: 1, edit: 2 } as Readonly<Record<MarginRequestKind, 1 | 2>>,
  /** The Masters edit form keys that need the approvals (master_channel_skus margin / rate_after_margin). */
  FIELDS: ['marginPercent', 'rateAfterMargin'] as readonly string[],
  /** Why a person can't decide (shown on the card + in the 403), in plain words: no "layer" on screen (user 2026-11-12). */
  WHY: {
    ASKED: 'you asked for this change',
    ADD_ROLE: 'a new channel SKU is approved by Operations Manager or Admin',
    STEP1_ROLE: 'step 1 is for Operations Manager',
    STEP2_ROLE: 'the final approval is for Admin',
    SAME: 'you approved step 1: the final approval must be someone else',
  },
  /** Names in the 403 "Only <roles> can give <step>". */
  STEP_NAME: { ADD: 'this approval', STEP1: 'step 1', STEP2: 'the final approval' },
  REMARK_MAX: 500,
  LIST_MAX: 500,
  ROUTES: { LIST: '/margin-changes', APPROVE: '/margin-changes/:id/approve', REJECT: '/margin-changes/:id/reject' },
  ID_PATTERN: /^[1-9]\d{0,18}$/,
} as const;
