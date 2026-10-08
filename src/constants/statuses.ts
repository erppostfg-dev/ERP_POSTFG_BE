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
