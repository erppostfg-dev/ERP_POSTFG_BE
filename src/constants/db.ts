/*
 * Database: which databases the app may use, the table names, and the fixed value lists (MySQL ENUMs) of the tables.
 * The tables are created and migrated by others (Final_Schema/final_schema.sql); the app only maps them with TypeORM
 * entities (src/entities/) and never changes the schema (synchronize off, no migrations here).
 */

/**
 * Databases the app may connect to. A temporary safety net: the current DB login can also reach other schemas
 * (prod, inv ...), so the connection is refused for any database not listed here.
 * When dedicated logins exist: add 'mcaff_postfg_prod' for production, or remove this check.
 */
export const ALLOWED_DATABASES: readonly string[] = ['mcaff_postfg_dev'];

/** Table names, exactly as in final_schema.sql. Never schema-qualified: queries always go to the connected database. */
export const TABLES = {
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
  // Login and page access (2026-10-09, prefg's shape; created by our migration).
  USERS: 'users',
  USER_ROLES: 'user_roles',
  PAGE_PERMISSIONS: 'page_permissions',
  USER_PAGE_PERMISSIONS: 'user_page_permissions',
  SESSIONS: 'sessions',
  SESSION_HISTORY: 'session_history',
  ACTIVITY_LOG: 'activity_log',
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
