import { ROLES } from './auth';

/*
 * Two-layer approval of margin changes (2026-11-06, user: "add a 2 layer approval mechanism of margin updates";
 * layer 1 = Operations Manager, layer 2 = Admin; edits AND new channel SKU rows). A change to a channel SKU's margin %
 * or rate after margin (Masters Edit, the price check's "update master") and a new channel SKU row (Masters Add) are
 * saved as a REQUEST; nothing changes in master_channel_skus until both layers approve. POs keep the old rate until then.
 *   pending_l1 --L1 approves--> pending_l2 --L2 approves--> applied (the master row changed / added + its History rows)
 *        \--------------------------\--- either rejects (reason) --> rejected
 * The requester never approves their own request; layer 1 and layer 2 are two different people.
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
  /** The Masters edit form keys that need the approvals (master_channel_skus margin / rate_after_margin). */
  FIELDS: ['marginPercent', 'rateAfterMargin'] as readonly string[],
  REMARK_MAX: 500,
  LIST_MAX: 500,
  ROUTES: { LIST: '/margin-changes', APPROVE: '/margin-changes/:id/approve', REJECT: '/margin-changes/:id/reject' },
  ID_PATTERN: /^[1-9]\d{0,18}$/,
} as const;
