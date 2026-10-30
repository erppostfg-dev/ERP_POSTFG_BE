/*
 * Local disk = a short-term working area only (user, 2026-10-23: "when we deploy to prod it keeps growing"). Every
 * email / API / manual PO is remembered in the DB (intake_emails) and kept in S3; the local folder of a FINISHED one is
 * removed by the cleanup (modules/email-intake/local-cleanup.service.ts) once every file is confirmed in S3.
 */
export const LOCAL_CLEANUP = {
  /** Finished POs keep their local folder this long (safety buffer: a bad S3 upload or a crash mid-way). */
  MIN_AGE_HOURS: 24,
  /** How often the server runs it (when LOCAL_CLEANUP_ENABLED=true), and the first run after start. */
  EVERY_HOURS: 24,
  FIRST_DELAY_MS: 5 * 60_000,
} as const;

/** intake_emails.kind */
export const INTAKE_EMAIL_KIND = {
  PO: 'po',
  NOT_PO: 'not_po',
} as const;
export type IntakeEmailKind = (typeof INTAKE_EMAIL_KIND)[keyof typeof INTAKE_EMAIL_KIND];

/** app_state keys (small values the server must keep across deploys). */
export const APP_STATE_KEY = {
  /** Gmail sync point (was storage/gmail-state.json until 2026-10-23). */
  GMAIL: 'gmail',
  /** The Flipkart consignments robot's last run and schedule (Channel Pulls, 2026-10-30). */
  FLIPKART_ROBOT: 'channel-pull:flipkart',
  /** Its schedule: { everyHours, updatedBy, updatedAt } (Channel Pulls). */
  FLIPKART_ROBOT_SCHEDULE: 'channel-pull:flipkart:schedule',
  /** The last Bulk Consignment File the robot read: { savedAt, headers by consignment id } (Manual Upload's warehouse). */
  FLIPKART_BULK: 'channel-pull:flipkart:bulk',
} as const;
