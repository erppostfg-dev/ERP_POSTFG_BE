/*
 * Feedback (2026-10-29, user: "anyone can add issues or improvements, with 2-4 images; everyone sees the list; only the
 * developer, the person who added it or the people added to the item change it"). Page /feedback is open to every
 * signed-in person (OPEN_PAGES in auth.ts). Emails about new items / changes: later (backlog). Nothing is deleted: an
 * item is closed by its status, an image is hidden (removed_at), the S3 file stays.
 */

export const FEEDBACK_TYPE = { PROBLEM: 'problem', IMPROVEMENT: 'improvement', QUESTION: 'question' } as const;
export type FeedbackType = (typeof FEEDBACK_TYPE)[keyof typeof FEEDBACK_TYPE];

/** How bad a problem is for the person's work (problems only; null for improvements / questions). */
export const FEEDBACK_SEVERITY = { BLOCKING: 'blocking', ANNOYING: 'annoying', SMALL: 'small' } as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITY)[keyof typeof FEEDBACK_SEVERITY];

export const FEEDBACK_STATUS = {
  NEW: 'new',
  IN_PROGRESS: 'in_progress',
  PLANNED: 'planned',
  FIXED: 'fixed',
  WONT_DO: 'wont_do',
  /** Same as another item: duplicate_of_id says which. */
  DUPLICATE: 'duplicate',
} as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUS)[keyof typeof FEEDBACK_STATUS];

/** A comment someone wrote, or a line the app writes for a change (status, members, images...): one timeline. */
export const FEEDBACK_COMMENT_KIND = { COMMENT: 'comment', CHANGE: 'change' } as const;
export type FeedbackCommentKind = (typeof FEEDBACK_COMMENT_KIND)[keyof typeof FEEDBACK_COMMENT_KIND];

/** Image types accepted, detected from the file's first bytes (never the name or the browser's type). No SVG. */
export const FEEDBACK_IMAGE_TYPES = {
  png: { contentType: 'image/png', ext: '.png' },
  jpeg: { contentType: 'image/jpeg', ext: '.jpg' },
  webp: { contentType: 'image/webp', ext: '.webp' },
  gif: { contentType: 'image/gif', ext: '.gif' },
} as const;
export type FeedbackImageKind = keyof typeof FEEDBACK_IMAGE_TYPES;

export const FEEDBACK = {
  BASE: '/feedback',
  ROUTES: {
    LIST: '/',
    PEOPLE: '/people',
    ONE: '/:id',
    COMMENTS: '/:id/comments',
    MEMBERS: '/:id/members',
    MEMBER: '/:id/members/:userId',
    IMAGES: '/:id/images',
    IMAGE: '/:id/images/:imageId',
    IMAGE_REMOVE: '/:id/images/:imageId/remove',
  },
  /** Multipart field of the images (create and add images). */
  FIELD_IMAGES: 'images',
  /** Body field (create, PATCH) of the one person the item is assigned to; null / '' = nobody. */
  FIELD_ASSIGNEE: 'assignedToId',
  /** At most this many images per item (user: "2, 3, max 4"), counting the ones already there. */
  MAX_IMAGES: 4,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  TITLE_MAX: 200,
  TEXT_MAX: 5000,
  COMMENT_MAX: 2000,
  PAGE_MAX: 500,
  /** What the app captures with a report (page, browser, last error...), as JSON. */
  CONTEXT_MAX_BYTES: 4000,
  /** The list answers at most this many items (newest first). */
  LIST_MAX: 500,
  /** S3: s3://<bucket>/feedback/<yyyy>/<mm>/<uuid>.<ext> */
  S3_FOLDER: 'feedback',
  QUERY: { STATUS: 'status', TYPE: 'type', Q: 'q', MINE: 'mine' },
} as const;
