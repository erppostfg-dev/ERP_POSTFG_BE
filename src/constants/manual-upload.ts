import { CHANNELS, ChannelName } from './channels';

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
  /** "true" = the person saw the copies already in POST_FG and chose Process again (2026-11-05). */
  FIELD_REPLACE: 'replace',
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
  /** Myntra STRs (2026-11-03): an STR's CSV from the Myntra partner portal, one file = one STR = one PO (no OCR). */
  MYNTRA_NEEDS: 'Myntra STR CSV (<STR>-summary.csv from the partner portal, e.g. STNCPWEBP271026-01-summary.csv)',
  MYNTRA_NOTE: (destination: string, location: string | null) => `Myntra STR: ${destination || '?'} -> ${location ?? 'location to pick in review'}`,
  /** The queue list: newest first, at most this many. */
  LIST_LIMIT: 200,
  /** messageId of a manual upload's folder (links it to its po_uploads rows). */
  MESSAGE_ID: (id: string) => `manual-upload:${id}`,
  /** The note of an upload that replaces copies already in POST_FG (Process again). */
  REPLACES_NOTE: (ids: string[]) => `Replaces upload ${ids.map((i) => `#${i}`).join(', ')} (uploaded again: Process again)`,
  /** The remark on the old copy when the new one is processed: rejected (in review) or dismissed (failed). */
  REPLACED_REMARK: (manualId: string) => `replaced by manual upload #${manualId} (the same PO uploaded again, "Process again")`,
} as const;

/**
 * Copies of a PO already in POST_FG, checked when files are uploaded (user 2026-11-05: ask "it is present, process
 * again?" instead of making a second copy): the same file (sha1), or the PO number in the file name (per channel
 * below; exact = the number itself, prefix = the PO number starts with it: First Club "PO-210392.pdf" ->
 * PO-210392-FRHHYDMDL01). Channels with their own check (Amazon, Flipkart, Myntra) are not in here.
 */
export const FILE_NAME_PO: Partial<Record<ChannelName, { re: RegExp; prefix?: (n: string) => string; po?: (m: RegExpExecArray) => string }>> = {
  [CHANNELS.FIRSTCRY]: { re: /(pin\w{10,})/i },
  [CHANNELS.FLIPKART_QCOM]: { re: /purchase_order_([A-Z0-9]{8,})/i },
  [CHANNELS.FIRST_CLUB]: { re: /PO[-_](\d{5,})/i, prefix: (n) => `PO-${n}-` },
  // the file name writes the slashes as dashes: OG-00381-2026-27.pdf = PO OG/00381/2026-27
  [CHANNELS.OCTAVOS]: { re: /\b(OESPL|OG|OK|RET)-(\d+)-(\d{2,4}-\d{2})\b/i, po: (m) => `${m[1].toUpperCase()}/${m[2]}/${m[3]}` },
};

/** What can be done with a copy already in POST_FG when the same PO is uploaded again. */
export const COPY_ACTION = {
  /** In review / failed: Process again replaces it (rejected / dismissed when the new upload is processed). */
  REPLACE: 'replace',
  /** Not possible: a sale order exists, it waits for approval, or it is still being read. */
  BLOCKED: 'blocked',
} as const;
export type CopyAction = (typeof COPY_ACTION)[keyof typeof COPY_ACTION];

export const COPY_WHY = {
  COMPLETED: (so: string | null) => `it is already a sale order${so ? ` (${so})` : ''}: use Re-punch to change it`,
  PENDING_APPROVAL: 'it waits for approval: decide it in Approvals first',
  RUNNING: 'it is being read right now: wait for it to finish',
  NOT_PROCESSED: 'it is uploaded but not processed yet: process or cancel that upload',
} as const;
