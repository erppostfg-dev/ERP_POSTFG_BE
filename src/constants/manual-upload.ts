/*
 * Manual upload of PO files (user, 2026-10-22): Processed & Review -> Manual Upload. A person picks the channel and
 * drops PO files; each PO becomes a folder like an email's (storage/emails/manual-upload/<date>_<id>/ + metadata
 * provider "manual" + channel) copied to S3 at once, and waits as "uploaded". Only the Process button queues it; the
 * queue runs ONE at a time (OCR is slow / costs money): the same chain as email (po_uploads -> OCR -> processed.json ->
 * validation -> Processed or In Review). Queued / processing rows continue by themselves after a restart; "uploaded"
 * rows never run without a Process click.
 */

export const MANUAL_UPLOAD_STATUS = {
  /** Stored + in S3, waiting for someone to click Process. */
  UPLOADED: 'uploaded',
  /** Process clicked: waits for its turn. */
  QUEUED: 'queued',
  /** OCR + chain running now. */
  PROCESSING: 'processing',
  /** The chain finished (each PO is completed or needs_review: see its po_uploads rows). */
  DONE: 'done',
  FAILED: 'failed',
  /** Cancelled before processing (kept, nothing deleted). */
  CANCELLED: 'cancelled',
} as const;
export type ManualUploadStatus = (typeof MANUAL_UPLOAD_STATUS)[keyof typeof MANUAL_UPLOAD_STATUS];

export const MANUAL_UPLOAD = {
  BASE: '/manual-uploads',
  ROUTES: { LIST: '/', CHANNELS: '/channels', UPLOAD: '/', PROCESS: '/process', CANCEL: '/:id/cancel', RETRY: '/:id/retry' },
  /** Storage group folder: storage/emails/manual-upload/ (and the first S3 folder). */
  FOLDER: 'manual-upload',
  FIELD_FILES: 'files',
  FIELD_CHANNEL: 'channel',
  BODY_IDS: 'ids',
  MAX_FILES: 20,
  MAX_FILE_BYTES: 20 * 1024 * 1024,
  /** PO files the readers take: PDF, Excel, CSV. */
  ALLOWED_EXT: /\.(pdf|xlsx|xls|csv)$/i,
  /** Amazon: Seller Central's shipment file (FBA15….tsv), one file = one shipment = one PO (user, 2026-10-22). */
  AMAZON_EXT: /\.tsv$/i,
  AMAZON_NEEDS: 'Amazon shipment file (.tsv)',
  /** A person may add a shipment in any status but these (user, 2026-10-22, option a). */
  AMAZON_REFUSED_STATUSES: ['CANCELLED', 'DELETED', 'CLOSED'],
  /** Shown when the status could not be read from Amazon (no keys / Amazon down): the upload is still allowed. */
  AMAZON_STATUS_UNKNOWN: 'UNKNOWN',
  /** Flipkart (2026-10-30): a consignment's CSV from Seller Hub, one file = one consignment = one PO (no OCR). */
  FLIPKART_NEEDS: 'Flipkart consignment CSV (Consignment_Details_<id>_<date>.csv)',
  /** Its note when the robot's last Bulk Consignment File did not list it: the reviewer picks the location. */
  FLIPKART_NO_HEADER: 'not in the last Bulk Consignment File: warehouse to pick in review',
  /** The queue list: newest first, at most this many. */
  LIST_LIMIT: 200,
  /** messageId of a manual upload's folder (links it to its po_uploads rows). */
  MESSAGE_ID: (id: string) => `manual-upload:${id}`,
} as const;
