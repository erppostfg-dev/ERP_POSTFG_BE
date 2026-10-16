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
  /** po:validate reports, next to the email storage: storage/validation/. */
  VALIDATION: 'validation',
  /** POs pulled from channel APIs (Amazon SP-API ...): storage/emails/channel-api/<date>_<external id>/ and the same
   *  name as the first S3 folder (channel-api/FY.../<month>/<channel>/<PO number>/). */
  CHANNEL_API: 'channel-api',
} as const;

/** Where an email came from (metadata.json "provider"). */
export const PROVIDERS = {
  GMAIL_PUBSUB: 'gmail-pubsub',
  MANUAL: 'manual',
  /** A PO pulled from a channel's API by a connector (modules/channel-api). */
  CHANNEL_API: 'channel-api',
} as const;
export type Provider = (typeof PROVIDERS)[keyof typeof PROVIDERS];
