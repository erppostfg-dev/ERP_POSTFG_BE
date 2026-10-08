/*
 * Gmail labels, endpoints, storage folders and email providers.
 */

/** Gmail labels the server watches (see modules/email-intake/label-routes.ts). */
export const LABELS = {
  PO_INTAKE: 'Po-Intake',
} as const;

/** API endpoint paths (joined to INTAKE_BASE_URL / the /api/v1 prefix). */
export const ENDPOINTS = {
  PO_INTAKE_EMAIL: '/po-intake/email',
} as const;

export const FOLDERS = {
  /** Emails of a label that are not POs go to <label>-not-po/. */
  NOT_PO_SUFFIX: '-not-po',
  /** Emails posted to the intake endpoint without a label. */
  MANUAL: 'manual',
  /** One email with several POs (Purplle): <email folder>/POs/<PO number>/processed.json. */
  POS: 'POs',
  /** The POs/ sub-folder of a PO whose number could not be read. */
  NO_PO_NUMBER: 'no-po-number',
} as const;

/** Where an email came from (metadata.json "provider"). */
export const PROVIDERS = {
  GMAIL_PUBSUB: 'gmail-pubsub',
  MANUAL: 'manual',
} as const;
export type Provider = (typeof PROVIDERS)[keyof typeof PROVIDERS];
