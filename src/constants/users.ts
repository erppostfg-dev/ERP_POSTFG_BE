import { ROLES, RoleKey } from './auth';
import { ACCESS_LEVEL, AccessLevel } from './db';

/*
 * Users & Roles admin (2026-10-15, user): admins / developers add people, give them a role (the role decides which
 * routes they may open, view or edit), a PO Overview team and facilities, and the person gets a welcome email.
 * Roles are rows of the `roles` table; their page grants are page_permissions rows.
 * FIXED LIST (user, 2026-10-16: "only a list of roles I can add; in future I can add if wanted"): roles come from
 * ROLE_CATALOG below, loaded by migrations. Nobody creates or renames a role on the screen; admins may change a
 * non-built-in role's page access (option b). A new role = a new ROLE_CATALOG entry + a migration that inserts it.
 */

/** Only these roles may add / change users and roles (user: "admin and dev can add the users"). */
export const USER_ADMIN_ROLES: readonly RoleKey[] = [ROLES.ADMIN, ROLES.DEVELOPER];

/** Built-in roles: full access, cannot be edited from the screen (so nobody locks everyone out). */
export const SYSTEM_ROLES: readonly RoleKey[] = [ROLES.DEVELOPER, ROLES.ADMIN];

/** Pages a custom role can NOT be given from the screen (managing users stays with admin / developer). */
export const ROLE_EXCLUDED_PAGES: readonly string[] = ['/admin'];

export const USER_NAME_MAX = 100;

const V = ACCESS_LEVEL.VIEWER;
const E = ACCESS_LEVEL.EDITOR;
const MASTERS = ['/masters', '/masters/pep-skus', '/masters/channel-skus', '/masters/channel-customers', '/masters/channel-locations', '/masters/warehouses'];
const OPERATIONS = ['/operations', '/operations/po-overview', '/operations/po-review', '/operations/po-working', '/operations/skus-short', '/operations/analytics'];
const PLANNING = ['/planning', '/planning/inventory', '/planning/drr-aging', '/planning/analytics'];
const all = (pages: string[], level: AccessLevel) => Object.fromEntries(pages.map((p) => [p, level]));

export interface RoleDef {
  key: string;
  label: string;
  description: string;
  /** Built-in: full access everywhere (DEFAULT_ROLE_GRANTS), not editable on the screen. */
  isSystem: boolean;
  /** Starting page access (pages not listed = hidden). Admins may change it later on the Roles tab. */
  grants: Record<string, AccessLevel>;
}

/** The roles people can be given (user, 2026-10-16). Pages not listed are hidden for that role. */
export const ROLE_CATALOG: readonly RoleDef[] = [
  { key: ROLES.ADMIN, label: 'Admin', description: 'Full access, incl. Users & Roles and approving PO reviews', isSystem: true, grants: {} },
  { key: ROLES.DEVELOPER, label: 'Developer', description: 'Full access, incl. Users & Roles and approving PO reviews', isSystem: true, grants: {} },
  {
    key: 'operations-manager', label: 'Operations Manager', description: 'Edits all of Operations; sees Masters, Planning and Approvals', isSystem: false,
    grants: { ...all(OPERATIONS, E), ...all(MASTERS, V), ...all(PLANNING, V), '/approvals': V },
  },
  {
    key: 'operations-executive', label: 'Operations Executive', description: 'Works on PO Overview, PO Review and PO Working; sees Masters', isSystem: false,
    grants: {
      '/operations': V, '/operations/po-overview': E, '/operations/po-review': E, '/operations/po-working': E,
      '/operations/skus-short': V, '/operations/analytics': V, ...all(MASTERS, V),
    },
  },
  {
    key: 'demand-planner', label: 'Demand Planner', description: 'Edits Demand Planning; sees Operations and Masters', isSystem: false,
    grants: { ...all(PLANNING, E), ...all(OPERATIONS, V), ...all(MASTERS, V) },
  },
  {
    key: 'viewer', label: 'Viewer', description: 'Sees every page except Users & Roles; changes nothing', isSystem: false,
    grants: { ...all(MASTERS, V), ...all(OPERATIONS, V), ...all(PLANNING, V), '/approvals': V },
  },
];

/** users.id / roles.key in a URL. */
export const USER_ID_PATTERN = /^\d{1,10}$/;

/** Welcome email: tries in this process after a person is added (then the Resend button). */
export const WELCOME_EMAIL = {
  /** Waits before the 2nd and 3rd try (ms). */
  RETRY_DELAYS_MS: [30_000, 120_000],
  ERROR_MAX: 500,
  SUBJECT: 'You have been added to POST FG',
} as const;

/** Request body field names (also the `field` of a VALIDATION_FAILED detail). */
export const USER_BODY = {
  EMAIL: 'email',
  NAME: 'name',
  ROLES: 'roles',
  TEAM: 'team',
  FACILITIES: 'facilities',
  STATUS: 'status',
  SEND_EMAIL: 'sendEmail',
  LABEL: 'label',
  DESCRIPTION: 'description',
  GRANTS: 'grants',
} as const;
