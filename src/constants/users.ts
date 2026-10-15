import { ROLES, RoleKey } from './auth';

/*
 * Users & Roles admin (2026-10-15, user): admins / developers add people, give them a role (the role decides which
 * routes they may open, view or edit), a PO Overview team and facilities, and the person gets a welcome email.
 * Roles are rows of the `roles` table; their page grants are page_permissions rows.
 */

/** Only these roles may add / change users and roles (user: "admin and dev can add the users"). */
export const USER_ADMIN_ROLES: readonly RoleKey[] = [ROLES.ADMIN, ROLES.DEVELOPER];

/** Built-in roles: full access, cannot be edited from the screen (so nobody locks everyone out). */
export const SYSTEM_ROLES: readonly RoleKey[] = [ROLES.DEVELOPER, ROLES.ADMIN];

/** Pages a custom role can NOT be given from the screen (managing users stays with admin / developer). */
export const ROLE_EXCLUDED_PAGES: readonly string[] = ['/admin'];

/** A new role's key: lower-case words joined by "-", from its label ("Warehouse Ops" -> "warehouse-ops"). */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
export const ROLE_LABEL_MAX = 100;
export const ROLE_DESCRIPTION_MAX = 255;
export const USER_NAME_MAX = 100;

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
