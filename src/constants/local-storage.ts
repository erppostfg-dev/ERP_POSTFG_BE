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
  /**
   * Disk (2026-11-04, user): a PO that is failed (or dismissed), in review or waiting for approval this many days loses its
   * LOCAL copy too (S3 keeps everything; review / approval read S3, Try again copies it back): the disk never fills with
   * POs that never finish.
   */
  STALE_DAYS: 7,
  STALE_STATUSES: ['failed', 'needs_review', 'pending_approval'] as readonly string[],
} as const;

/** The server disk check (2026-11-04): every hour; a warning / an error in the log at these % used. */
export const DISK_CHECK = {
  EVERY_MS: 60 * 60_000,
  WARN_PCT: 80,
  ERROR_PCT: 90,
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
  /** The local cleanup's last run and the last disk check (Admin > Server, 2026-11-04). */
  LOCAL_CLEANUP_LAST: 'server:local-cleanup',
  DISK_LAST: 'server:disk',
  /** The Myntra STR robot's last run (2026-11-03). */
  MYNTRA_STR_ROBOT: 'channel-pull:myntra-str',
  /** Its schedule: { everyHours, updatedBy, updatedAt } (Channel Pulls). */
  FLIPKART_ROBOT_SCHEDULE: 'channel-pull:flipkart:schedule',
  /** The last Bulk Consignment File the robot read: { savedAt, headers by consignment id } (Manual Upload's warehouse). */
  FLIPKART_BULK: 'channel-pull:flipkart:bulk',
} as const;
