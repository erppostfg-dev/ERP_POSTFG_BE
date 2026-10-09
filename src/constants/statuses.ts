/*
 * Status values written into results, files and API responses.
 */

/** An OCR run (ocr-result.json) or a processing run (po:process). */
export const RESULT_STATUS = {
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;
export type ResultStatus = (typeof RESULT_STATUS)[keyof typeof RESULT_STATUS];

/** po_uploads.error_details.step: where the chain stopped. */
export const PIPELINE_STEP = {
  OCR: 'ocr',
  PROCESSING: 'processing',
  SAVE_PO: 'save_po',
  UNIWARE_CSV: 'uniware_csv',
} as const;

/**
 * What resume does with an unfinished po_uploads row after a restart (decided 2026-10-08): the row's status is the
 * to-do list. failed rows are never resumed automatically (po:resume --retry-failed, up to MAX_OCR_ATTEMPTS).
 */
export const RESUME_ACTION = {
  /** queued, or extracting with no OCR output: run the OCR (again). */
  OCR: 'ocr',
  /** extracting with OCR output, or processing without PO rows: processed.json -> validation -> save. */
  PROCESS: 'process',
  /** processing with PO rows saved: only upload the Uniware CSV written in the save transaction and complete. */
  CSV_ONLY: 'csv_only',
  /** Cannot be resumed (email folder not found, CSV missing, too many attempts): needs a person. */
  SKIP: 'skip',
} as const;
export type ResumeAction = (typeof RESUME_ACTION)[keyof typeof RESUME_ACTION];

/** OCR runs allowed per email before resume stops retrying it. */
export const MAX_OCR_ATTEMPTS = 3;

/** POST /po-intake/email response: what happened to the email. */
export const INTAKE_STATUS = {
  STORED: 'stored',
  DUPLICATE: 'duplicate',
  NOT_PO: 'not_po',
} as const;

/** GET /health response values. */
export const HEALTH_STATUS = {
  OK: 'ok',
  UP: 'up',
  DOWN: 'down',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
} as const;
