import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import {
  FEEDBACK_COMMENT_KIND, FEEDBACK_SEVERITY, FEEDBACK_STATUS, FEEDBACK_TYPE,
  FeedbackCommentKind, FeedbackSeverity, FeedbackStatus, FeedbackType,
} from '../constants/feedback';
import { User } from './auth.entities';

/*
 * Feedback (2026-10-29, constants/feedback.ts): problems, improvements and questions from the team, with images, the
 * people added to each item, and one timeline of comments + changes. Nothing is ever deleted (status closes an item,
 * images are hidden with removed_at). All links RESTRICT.
 */

/** feedback_items: one problem / improvement / question. */
@Entity({ name: TABLES.FEEDBACK_ITEMS })
@Index('idx_feedback_items_status', ['status', 'id'])
@Index('idx_feedback_items_created', ['createdAt'])
@Index('idx_feedback_items_assigned', ['assignedTo'])
export class FeedbackItem {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'type', type: 'enum', enum: Object.values(FEEDBACK_TYPE) })
  type: FeedbackType;

  @Column({ name: 'title', type: 'varchar', length: 200 })
  title: string;

  @Column({ name: 'description', type: 'text' })
  description: string;

  /** Problems only: how bad it is for the person's work. */
  @Column({ name: 'severity', type: 'enum', enum: Object.values(FEEDBACK_SEVERITY), nullable: true })
  severity: FeedbackSeverity | null;

  @Column({ name: 'status', type: 'enum', enum: Object.values(FEEDBACK_STATUS), default: FEEDBACK_STATUS.NEW })
  status: FeedbackStatus;

  /** status duplicate: the item it repeats. */
  @Column({ name: 'duplicate_of_id', type: 'bigint', nullable: true })
  duplicateOfId: string | null;

  /** The app page (path + ?tab=...) the person was on. */
  @Column({ name: 'page', type: 'varchar', length: 500, nullable: true })
  page: string | null;

  /** What the app captured with the report: browser, screen, the last error on screen (code, request id)... */
  @Column({ name: 'context', type: 'json', nullable: true })
  context: Record<string, unknown> | null;

  @Column({ name: 'reporter_id', type: 'int' })
  reporterId: number;

  /** The one person who works on it (may change it like its reporter); null = nobody yet. */
  @Column({ name: 'assigned_to', type: 'int', nullable: true })
  assignedTo: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy: number | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;

  /** fk_feedback_items_assigned_to */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'assigned_to', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_items_assigned_to' })
  assignee: User | null;

  /** fk_feedback_items_duplicate_of */
  @ManyToOne(() => FeedbackItem, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'duplicate_of_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_items_duplicate_of' })
  duplicateOf: FeedbackItem | null;

  /** fk_feedback_items_reporter */
  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'reporter_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_items_reporter' })
  reporter: User;

  /** fk_feedback_items_updated_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_items_updated_by' })
  updater: User | null;
}

/** feedback_members: people added to an item; they may change it like its reporter. */
@Entity({ name: TABLES.FEEDBACK_MEMBERS })
@Index('idx_feedback_members_user', ['userId'])
export class FeedbackMember {
  @PrimaryColumn({ name: 'item_id', type: 'bigint' })
  itemId: string;

  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'added_by', type: 'int' })
  addedBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** fk_feedback_members_item */
  @ManyToOne(() => FeedbackItem, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_members_item' })
  item: FeedbackItem;

  /** fk_feedback_members_user */
  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_members_user' })
  user: User;

  /** fk_feedback_members_added_by */
  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'added_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_members_added_by' })
  adder: User;
}

/** feedback_images: screenshots in S3 (at most FEEDBACK.MAX_IMAGES shown per item). Hidden, never deleted. */
@Entity({ name: TABLES.FEEDBACK_IMAGES })
@Index('idx_feedback_images_item', ['itemId', 'id'])
export class FeedbackImage {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'item_id', type: 'bigint' })
  itemId: string;

  @Column({ name: 's3_url', type: 'varchar', length: 1000 })
  s3Url: string;

  /** The name on the person's computer (shown only). */
  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'content_type', type: 'varchar', length: 50 })
  contentType: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ name: 'uploaded_by', type: 'int' })
  uploadedBy: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  @Column({ name: 'removed_at', type: 'datetime', precision: 6, nullable: true })
  removedAt: Date | null;

  @Column({ name: 'removed_by', type: 'int', nullable: true })
  removedBy: number | null;

  /** fk_feedback_images_item */
  @ManyToOne(() => FeedbackItem, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_images_item' })
  item: FeedbackItem;

  /** fk_feedback_images_uploaded_by */
  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_images_uploaded_by' })
  uploader: User;

  /** fk_feedback_images_removed_by */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'removed_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_images_removed_by' })
  remover: User | null;
}

/** feedback_comments: the item's timeline: comments people write and the lines the app writes for changes. */
@Entity({ name: TABLES.FEEDBACK_COMMENTS })
@Index('idx_feedback_comments_item', ['itemId', 'id'])
export class FeedbackComment {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'item_id', type: 'bigint' })
  itemId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'kind', type: 'enum', enum: Object.values(FEEDBACK_COMMENT_KIND), default: FEEDBACK_COMMENT_KIND.COMMENT })
  kind: FeedbackCommentKind;

  @Column({ name: 'text', type: 'text' })
  text: string;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** fk_feedback_comments_item */
  @ManyToOne(() => FeedbackItem, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_comments_item' })
  item: FeedbackItem;

  /** fk_feedback_comments_user */
  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_feedback_comments_user' })
  user: User;
}
