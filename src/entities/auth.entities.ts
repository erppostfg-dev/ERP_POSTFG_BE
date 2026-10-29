import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import {
  ACCESS_LEVEL,
  AccessLevel,
  DEVICE_TYPE,
  DeviceType,
  SESSION_EVENT,
  SessionEvent,
  TABLES,
  USER_STATUS,
  UserStatus,
} from '../constants/db';
import { USER_TEAM, UserTeam } from '../constants/po-overview-columns';

/*
 * Login and page access, in prefg's exact shape (mcaff_prefg_dev, SHOW CREATE TABLE read 2026-10-09), created in
 * mcaff_postfg_dev by our migration. A user logs in with Google when their users row exists and is not inactive;
 * what they may see is page_permissions (per role) and user_page_permissions (per user, wins over roles).
 */

/** users: who may log in. */
@Entity({ name: TABLES.USERS })
@Index('email', ['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name: string;

  @Column({ name: 'email', type: 'varchar', length: 100 })
  email: string;

  /** NULL counts as active, as in prefg. */
  @Column({ name: 'status', type: 'enum', enum: Object.values(USER_STATUS), nullable: true, default: USER_STATUS.ACTIVE })
  status: UserStatus | null;

  @Column({ name: 'created_at', type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date | null;

  @Column({ name: 'welcome_sent_at', type: 'datetime', nullable: true })
  welcomeSentAt: Date | null;

  /** Google's account id (sub), set at the first login. */
  @Column({ name: 'google_id', type: 'varchar', length: 255, nullable: true })
  googleId: string | null;

  /**
   * The PO Overview team (2026-10-14): ONE per person (planning, warehouse, logistics, accounts, viewer); what it may
   * do = team_column_access. Null = no team: sees the PO Overview by page access only (admin / developer edit all).
   */
  @Column({ name: 'po_team', type: 'enum', enum: Object.values(USER_TEAM), nullable: true })
  poTeam: UserTeam | null;

  /** Who added the person from the Users page (users.id); null for people added by a script or the seed. */
  @Column({ name: 'added_by', type: 'int', nullable: true })
  addedBy: number | null;

  /** Why the last welcome email failed (null = sent, or never tried); welcome_sent_at is set when it goes out. */
  @Column({ name: 'welcome_error', type: 'varchar', length: 500, nullable: true })
  welcomeError: string | null;

  /** fk_users_added_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'added_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_users_added_by' })
  adder: User | null;
}

/**
 * roles (2026-10-15): the roles a person can be given. A role's only power is its page grants (page_permissions):
 * which routes it may open and whether it may view or edit them. developer / admin are built-in (is_system) and keep
 * full access; others are made on the Users page.
 */
@Entity({ name: TABLES.ROLES })
export class Role {
  /** What user_roles.role and page_permissions.role store. */
  @PrimaryColumn({ name: 'role_key', type: 'varchar', length: 100 })
  key: string;

  @Column({ name: 'label', type: 'varchar', length: 100 })
  label: string;

  @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem: boolean;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy: number | null;

  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', update: false })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP', update: false })
  updatedAt: Date;

  /** fk_roles_created_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_roles_created_by' })
  creator: User | null;
}

/** user_roles: a user's roles (keys from constants/auth ROLES). */
@Entity({ name: TABLES.USER_ROLES })
export class UserRole {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId: number;

  @PrimaryColumn({ name: 'role', type: 'varchar', length: 100 })
  role: string;
}

/** page_permissions: what a role may do on a page. */
@Entity({ name: TABLES.PAGE_PERMISSIONS })
@Index('role_page_slug', ['role', 'pageSlug'], { unique: true })
@Index('role', ['role'])
export class PagePermission {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'role', type: 'varchar', length: 100 })
  role: string;

  @Column({ name: 'page_slug', type: 'varchar', length: 100 })
  pageSlug: string;

  @Column({ name: 'access_level', type: 'enum', enum: Object.values(ACCESS_LEVEL), default: ACCESS_LEVEL.NONE })
  accessLevel: AccessLevel;

  @Column({ name: 'created_at', type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date | null;
}

/** user_page_permissions: a per-user override; wins over every role grant on that page. */
@Entity({ name: TABLES.USER_PAGE_PERMISSIONS })
@Index('user_id_page_slug', ['userId', 'pageSlug'], { unique: true })
@Index('user_id', ['userId'])
export class UserPagePermission {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'page_slug', type: 'varchar', length: 100 })
  pageSlug: string;

  @Column({ name: 'access_level', type: 'enum', enum: Object.values(ACCESS_LEVEL) })
  accessLevel: AccessLevel;

  @Column({ name: 'created_at', type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date | null;
}

/** sessions: one row per login; is_active = 0 after logout or revoke (checked on every request). */
@Entity({ name: TABLES.SESSIONS })
@Index('session_id', ['sessionId'], { unique: true })
@Index('user_id', ['userId'])
export class Session {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'session_id', type: 'varchar', length: 36 })
  sessionId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  /** What issued it (prefg writes "google-oauth-jwt"). */
  @Column({ name: 'token', type: 'text' })
  token: string;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ name: 'device_type', type: 'enum', enum: Object.values(DEVICE_TYPE), nullable: true, default: DEVICE_TYPE.WEB })
  deviceType: DeviceType | null;

  @Column({ name: 'created_at', type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date | null;

  @Column({ name: 'last_active', type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  lastActive: Date | null;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  /** tinyint(1) as boolean, like the other entities (a numeric default makes TypeORM report a false difference). */
  @Column({ name: 'is_active', type: 'boolean', nullable: true, default: true })
  isActive: boolean | null;

  /** sessions_ibfk_1: user_id -> users.id */
  @ManyToOne(() => User, { createForeignKeyConstraints: true })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'sessions_ibfk_1' })
  user: User;
}

/** session_history: login / logout / expired / revoked events. */
@Entity({ name: TABLES.SESSION_HISTORY })
@Index('user_id', ['userId'])
export class SessionHistory {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'session_id', type: 'varchar', length: 36 })
  sessionId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'event', type: 'enum', enum: Object.values(SESSION_EVENT) })
  event: SessionEvent;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ name: 'event_at', type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
  eventAt: Date | null;

  @Column({ name: 'remarks', type: 'varchar', length: 200, nullable: true })
  remarks: string | null;

  /** session_history_ibfk_1: user_id -> users.id */
  @ManyToOne(() => User, { createForeignKeyConstraints: true })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'session_history_ibfk_1' })
  user: User;
}

/** activity_log: one row per request that changes something (who, what, result, time), as prefg. */
@Entity({ name: TABLES.ACTIVITY_LOG })
@Index('idx_activity_user', ['userId', 'id'])
@Index('idx_activity_created', ['createdOn'])
export class ActivityLog {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'user_id', type: 'int', nullable: true, comment: 'NULL when the request failed auth' })
  userId: number | null;

  @Column({ name: 'method', type: 'varchar', length: 10 })
  method: string;

  @Column({ name: 'path', type: 'varchar', length: 255, comment: 'API route path, e.g. /api/v1/po-review' })
  path: string;

  @Column({ name: 'status', type: 'smallint', comment: 'HTTP status the request returned' })
  status: number;

  @Column({ name: 'duration_ms', type: 'int' })
  durationMs: number;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true, comment: 'First hop of x-forwarded-for' })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ name: 'request_id', type: 'char', length: 36, nullable: true, comment: 'Ties the row to its log lines' })
  requestId: string | null;

  @Column({ name: 'created_on', type: 'datetime', comment: 'IST' })
  createdOn: Date;
}
