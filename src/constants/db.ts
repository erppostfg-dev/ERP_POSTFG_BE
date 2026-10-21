/*
 * Database: which databases the app may use, the table names, and the fixed value lists (MySQL ENUMs) of the tables.
 * The first tables came from Final_Schema/final_schema.sql (Baseline migration); since 2026-10-09 every schema change is a
 * TypeORM migration in src/migrations, generated from the entities (src/entities/) and run by the user.
 */

/**
 * Databases the app may connect to. A temporary safety net: the current DB login can also reach other schemas
 * (prod, inv ...), so the connection is refused for any database not listed here.
 * When dedicated logins exist: add 'mcaff_postfg_prod' for production, or remove this check.
 */
export const ALLOWED_DATABASES: readonly string[] = ['mcaff_postfg_dev'];

/**
 * PEPIMS's database: masters:load --pepims READS its master tables (inside START TRANSACTION READ ONLY, separate
 * connection). The app never writes to it and never connects to it otherwise.
 */
export const PEPIMS_DATABASE = 'mcaff_inv';

/** PEPIMS's master tables (mcaff_inv), as its Sequelize models name them. */
export const PEPIMS_TABLES = {
  FACILITY: 'facility_masters',
  COURIER_PARTNER: 'courier_partner_masters',
  COURIER_RATES: 'courier_rate_masters',
  STATUS: 'status_masters',
  APPOINTMENT_REMARKS: 'appointment_remark_masters',
  CHANNEL_LOCATION: 'channel_location_masters',
} as const;

/** Table names, exactly as in final_schema.sql. Never schema-qualified: queries always go to the connected database. */
export const TABLES = {
  CHANNEL_API_SYNC: 'channel_api_sync',
  MASTER_CHANNELS: 'master_channels',
  MASTER_SKUS: 'master_skus',
  MASTER_CHANNEL_SKUS: 'master_channel_skus',
  DETAILS_CHANNELS: 'details_channels',
  MASTER_PURCHASE_ORDERS: 'master_purchase_orders',
  DETAILS_PURCHASE_ORDERS: 'details_purchase_orders',
  SALE_ORDER_CODE_COUNTER: 'sale_order_code_counter',
  PO_UPLOADS: 'po_uploads',
  PO_ISSUES: 'po_issues',
  PO_ISSUE_ACTIONS: 'po_issue_actions',
  PO_REVIEW_SUBMISSIONS: 'po_review_submissions',
  // Login and page access (2026-10-09, prefg's shape; created by our migration).
  USERS: 'users',
  USER_ROLES: 'user_roles',
  ROLES: 'roles',
  PAGE_PERMISSIONS: 'page_permissions',
  USER_PAGE_PERMISSIONS: 'user_page_permissions',
  SESSIONS: 'sessions',
  SESSION_HISTORY: 'session_history',
  ACTIVITY_LOG: 'activity_log',
  // PO Overview masters + links (2026-10-14, PEPIMS's master sheets in our shape; created by our migration).
  MASTER_FACILITIES: 'master_facilities',
  MASTER_COURIER_PARTNERS: 'master_courier_partners',
  MASTER_COURIER_RATES: 'master_courier_rates',
  MASTER_SHIPMENT_STATUSES: 'master_shipment_statuses',
  MASTER_FINAL_STATUS_MAP: 'master_final_status_map',
  MASTER_APPOINTMENT_REMARKS: 'master_appointment_remarks',
  SHIPMENT_LOGS: 'shipment_logs',
  // PO Overview team access (2026-10-14): what each team may do per column group, and each person's facilities.
  TEAM_COLUMN_ACCESS: 'team_column_access',
  USER_FACILITIES: 'user_facilities',
  // Inbound plan + shipment tracking (2026-10-19, constants/inbound.ts).
  INBOUND_PLANS: 'inbound_plans',
  INBOUND_SHIPMENTS: 'inbound_shipments',
  INBOUND_SHIPMENT_LINES: 'inbound_shipment_lines',
  INBOUND_SHIPMENT_EVENTS: 'inbound_shipment_events',
  INBOUND_STATUS_LIMITS: 'inbound_status_limits',
} as const;

/** TypeORM's own record of which migrations have run. */
export const MIGRATIONS_TABLE = 'migrations';

/** users.status */
export const USER_STATUS = { ACTIVE: 'active', INACTIVE: 'inactive' } as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

/** page_permissions / user_page_permissions.access_level (most to least: editor > viewer > none). */
export const ACCESS_LEVEL = { NONE: 'none', VIEWER: 'viewer', EDITOR: 'editor' } as const;
export type AccessLevel = (typeof ACCESS_LEVEL)[keyof typeof ACCESS_LEVEL];

/** sessions.device_type */
export const DEVICE_TYPE = { WEB: 'web', MOBILE: 'mobile', TABLET: 'tablet', API: 'api' } as const;
export type DeviceType = (typeof DEVICE_TYPE)[keyof typeof DEVICE_TYPE];

/** session_history.event */
export const SESSION_EVENT = {
  LOGIN: 'login',
  LOGOUT: 'logout',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  TOKEN_REFRESHED: 'token_refreshed',
} as const;
export type SessionEvent = (typeof SESSION_EVENT)[keyof typeof SESSION_EVENT];

/** po_uploads.source: by email, uploaded by a person on the frontend, or sent by another system through the API. */
export const UPLOAD_SOURCE = { EMAIL: 'email', MANUAL: 'manual', API: 'api' } as const;
export type UploadSource = (typeof UPLOAD_SOURCE)[keyof typeof UPLOAD_SOURCE];

/** po_uploads.ocr_status */
export const UPLOAD_OCR_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  ISSUE: 'issue',
  ERROR: 'error',
} as const;
export type UploadOcrStatus = (typeof UPLOAD_OCR_STATUS)[keyof typeof UPLOAD_OCR_STATUS];

/** po_uploads.status */
export const UPLOAD_STATUS = {
  QUEUED: 'queued',
  EXTRACTING: 'extracting',
  NEEDS_REVIEW: 'needs_review',
  /** The reviewer fixed every issue and submitted it; waits for an admin on the Approvals page (2026-10-15). */
  PENDING_APPROVAL: 'pending_approval',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  FAILED: 'failed',
} as const;
export type UploadStatus = (typeof UPLOAD_STATUS)[keyof typeof UPLOAD_STATUS];

/** po_issues.issue_type */
export const ISSUE_TYPE = {
  OCR_ISSUE: 'OCR_ISSUE',
  DUPLICATE_PO: 'DUPLICATE_PO',
  LOCATION_NOT_MAPPED: 'LOCATION_NOT_MAPPED',
  SKU_NOT_MAPPED: 'SKU_NOT_MAPPED',
  PRICE_MISMATCH: 'PRICE_MISMATCH',
  MRP_MISMATCH: 'MRP_MISMATCH',
  QTY_MISMATCH: 'QTY_MISMATCH',
  TOTAL_MISMATCH: 'TOTAL_MISMATCH',
  PO_EXPIRED: 'PO_EXPIRED',
  OTHER: 'OTHER',
} as const;
export type IssueType = (typeof ISSUE_TYPE)[keyof typeof ISSUE_TYPE];

/** po_issues.status */
export const ISSUE_STATUS = { OPEN: 'open', APPROVED: 'approved', REJECTED: 'rejected' } as const;
export type IssueStatus = (typeof ISSUE_STATUS)[keyof typeof ISSUE_STATUS];

/** po_issue_actions.action_by / po_issues.resolved_by for what the app does by itself (raise, auto-close). */
export const SYSTEM_ACTOR = 'system';

/** po_review_submissions.type: a reviewer's fixes waiting for an approver, or a reviewer's direct reject (kept so who
 *  rejected which PO and why can be listed later; user, 2026-10-15). */
export const REVIEW_SUBMISSION_TYPE = { APPROVAL: 'approval', REVIEWER_REJECT: 'reviewer_reject' } as const;
export type ReviewSubmissionType = (typeof REVIEW_SUBMISSION_TYPE)[keyof typeof REVIEW_SUBMISSION_TYPE];

/** po_review_submissions.status. returned = the PO no longer passed the checks when approved (e.g. a master changed):
 *  it went back to In Review by itself with the reason (self-healing), no approver action needed. */
export const REVIEW_SUBMISSION_STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', RETURNED: 'returned' } as const;
export type ReviewSubmissionStatus = (typeof REVIEW_SUBMISSION_STATUS)[keyof typeof REVIEW_SUBMISSION_STATUS];

/** po_issue_actions.action */
export const ISSUE_ACTION = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  COMMENTED: 'commented',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REOPENED: 'reopened',
} as const;
export type IssueAction = (typeof ISSUE_ACTION)[keyof typeof ISSUE_ACTION];

/*
 * PO Overview masters (2026-10-14). ENUM only for the lists the app itself defines; business lists (status values,
 * transporters, remarks, facilities) are rows of master tables, so ops can change them without a migration.
 */

/** master_shipment_statuses.stage: the three status columns of master_purchase_orders. */
export const STATUS_STAGE = { PLANNING: 'planning', WAREHOUSE: 'warehouse', LOGISTICS: 'logistics' } as const;
export type StatusStage = (typeof STATUS_STAGE)[keyof typeof STATUS_STAGE];

/** <master>.source: where a master row came from (PEPIMS's tables, a Uniware export, or typed in). */
export const MASTER_SOURCE = { PEPIMS: 'pepims', UNIWARE: 'uniware', MANUAL: 'manual' } as const;
export type MasterSource = (typeof MASTER_SOURCE)[keyof typeof MASTER_SOURCE];

/** master_appointment_remarks.list: which dropdown the remark belongs to (PEPIMS's three remark lists). */
export const REMARK_LIST = { APPOINTMENT_CHANGE: 'appointment_change', RTO: 'rto', REJECTION: 'rejection' } as const;
export type RemarkList = (typeof REMARK_LIST)[keyof typeof REMARK_LIST];

/** master_purchase_orders.statusActive ("Status (Active/Inactive)" in PEPIMS). */
export const PO_ACTIVE_STATUS = { ACTIVE: 'Active', INACTIVE: 'Inactive' } as const;
export type PoActiveStatus = (typeof PO_ACTIVE_STATUS)[keyof typeof PO_ACTIVE_STATUS];

/** shipment_logs.action: what was done to the shipment (one row per changed field, or one row for the action). */
export const SHIPMENT_LOG_ACTION = {
  CREATED: 'created',
  FIELD_CHANGED: 'field_changed',
  BULK_UPDATE: 'bulk_update',
  LINE_QTY_REQUESTED: 'line_qty_requested',
  LINE_QTY_APPROVED: 'line_qty_approved',
  LINE_QTY_REJECTED: 'line_qty_rejected',
  /** The sale order CSV was uploaded into Uniware (marked by a person; 2026-10-19), or that mark was removed. */
  UNIWARE_UPLOADED: 'uniware_uploaded',
  UNIWARE_UPLOAD_UNDONE: 'uniware_upload_undone',
} as const;
export type ShipmentLogAction = (typeof SHIPMENT_LOG_ACTION)[keyof typeof SHIPMENT_LOG_ACTION];

/** shipment_logs.source: where the action came from. */
export const SHIPMENT_LOG_SOURCE = {
  SCREEN: 'screen',
  BULK_CSV: 'bulk_csv',
  PIPELINE: 'pipeline',
  REVIEW: 'review',
  SCRIPT: 'script',
} as const;
export type ShipmentLogSource = (typeof SHIPMENT_LOG_SOURCE)[keyof typeof SHIPMENT_LOG_SOURCE];
