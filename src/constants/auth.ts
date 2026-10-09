import { ACCESS_LEVEL, AccessLevel } from './db';

/*
 * Login and page access (2026-10-09), the same model as prefg (ERP-Prefg-Tool lib/roles.ts, lib/pages.ts,
 * lib/permissions.ts): a role's only power is its page grants; nothing in the code branches on a role name.
 */

/** Roles for now (user: only developer and admin; more later as data). Keys are what user_roles.role stores. */
export const ROLES = {
  DEVELOPER: 'developer',
  ADMIN: 'admin',
} as const;
export type RoleKey = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_LABELS: Record<RoleKey, string> = {
  [ROLES.DEVELOPER]: 'Developer',
  [ROLES.ADMIN]: 'Admin',
};

export const ROLE_KEYS = Object.values(ROLES) as RoleKey[];

export interface PageEntry {
  /** Stored in page_permissions.page_slug; a page without its own grant inherits its parent's. */
  slug: string;
  label: string;
  section: string;
}

/** Every permission page = one sidebar item (the UI of 2026-10-09), its section the parent. */
export const PAGES: readonly PageEntry[] = [
  { slug: '/masters', label: 'Masters', section: 'Masters' },
  { slug: '/masters/pep-skus', label: 'PEP SKU master', section: 'Masters' },
  { slug: '/masters/channel-skus', label: 'Channel SKU master', section: 'Masters' },
  { slug: '/masters/channel-customers', label: 'Channel / Customer master', section: 'Masters' },
  { slug: '/masters/warehouses', label: 'Warehouses', section: 'Masters' },
  { slug: '/operations', label: 'B2B/B2C Operations', section: 'B2B/B2C Operations' },
  { slug: '/operations/po-overview', label: 'PO Overview', section: 'B2B/B2C Operations' },
  { slug: '/operations/po-review', label: 'PO Processing & Review', section: 'B2B/B2C Operations' },
  { slug: '/operations/po-working', label: 'PO Working', section: 'B2B/B2C Operations' },
  { slug: '/operations/skus-short', label: 'SKUs Short', section: 'B2B/B2C Operations' },
  { slug: '/operations/analytics', label: 'Analytics', section: 'B2B/B2C Operations' },
  { slug: '/planning', label: 'Demand Planning', section: 'Demand Planning' },
  { slug: '/planning/inventory', label: 'Inventory Calculation', section: 'Demand Planning' },
  { slug: '/planning/drr-aging', label: 'DRR & Aging', section: 'Demand Planning' },
  { slug: '/planning/analytics', label: 'Analytics', section: 'Demand Planning' },
  { slug: '/approvals', label: 'Approvals', section: 'General' },
  { slug: '/admin', label: 'Admin', section: 'General' },
];

/** Page keys the API guards name (so routes never type a slug). */
export const PAGE = {
  MASTERS: '/masters',
  CHANNEL_SKUS: '/masters/channel-skus',
  OPERATIONS: '/operations',
  PO_REVIEW: '/operations/po-review',
  PLANNING: '/planning',
  APPROVALS: '/approvals',
  ADMIN: '/admin',
} as const;

/** Grants the seed writes: both roles editor on every top-level page (children inherit). */
export const DEFAULT_ROLE_GRANTS: Record<RoleKey, { pageSlug: string; access: AccessLevel }[]> = {
  [ROLES.DEVELOPER]: [PAGE.MASTERS, PAGE.OPERATIONS, PAGE.PLANNING, PAGE.APPROVALS, PAGE.ADMIN].map((pageSlug) => ({ pageSlug, access: ACCESS_LEVEL.EDITOR })),
  [ROLES.ADMIN]: [PAGE.MASTERS, PAGE.OPERATIONS, PAGE.PLANNING, PAGE.APPROVALS, PAGE.ADMIN].map((pageSlug) => ({ pageSlug, access: ACCESS_LEVEL.EDITOR })),
};

/** Login settings that are not secrets. */
export const AUTH = {
  /** The session cookie (httpOnly) and the short-lived cookie holding the OAuth state during sign-in. */
  SESSION_COOKIE: 'postfg_session',
  STATE_COOKIE: 'postfg_oauth_state',
  STATE_COOKIE_MINUTES: 10,
  /** sessions.token: what issued the session (prefg writes the same). */
  SESSION_ISSUER: 'google-oauth-jwt',
  JWT_ISSUER: 'post-fg',
  /** Google scopes for sign-in only. */
  GOOGLE_SCOPES: ['openid', 'email', 'profile'],
} as const;
