/*
 * File names written into an email folder (local storage and its S3 folder), and in the label folders.
 */
export const FILES = {
  /** The email's details (sender, subject, dates, attachments, s3Folder). */
  METADATA: 'metadata.json',
  BODY_TEXT: 'body.txt',
  BODY_HTML: 'body.html',
  /** Not-PO email: why it is not a PO. */
  NOT_PO_REASON: 'reason.json',
  /** <label>-not-po/report.csv: one row per not-PO email. */
  NOT_PO_REPORT: 'report.csv',
  /** In a repeat folder (<PO>_2): which folder it repeats and how they differ. */
  DUPLICATE: 'duplicate.json',
  /** <label>/duplicates.csv: one row per repeat. */
  DUPLICATES_REPORT: 'duplicates.csv',
  /** Files downloaded from the email's links (FirstCry). */
  LINKS: 'links.json',
  /** Our record of one OCR run (status, reason, inputs, timing). */
  OCR_RESULT: 'ocr-result.json',
  /** The OCR's output: header fields and totals, then the line table. */
  OCR_OUTPUT_CSV: 'ocr-output.csv',
  /** The OCR's own run summary (input type, files, cost, warnings). */
  OCR_OUTPUT_RESULT: 'ocr-output_result.json',
  /** The OCR team's raw JSON, once it comes through the queue (name still to be agreed with them). */
  OCR_RAW_JSON: 'ocr-raw.json',
  /** Our common-format PO. */
  PROCESSED: 'processed.json',
  /** po:validate report (dev, read-only run): <storage>/validation/validation-<date>.csv, one row per issue. */
  VALIDATION_REPORT: (date: string) => `validation-${date}.csv`,
} as const;

/** Attachment types that can be a PO file (po_uploads.file_type); a PDF is preferred when an email has several. */
export const PO_FILE_EXTENSIONS = ['pdf', 'xlsx', 'xls', 'csv'] as const;

/** Files that describe the email or our processing, not its attachments (left out of the re-send check). */
export const OWN_FILES = new RegExp(
  `^(${[FILES.METADATA, FILES.BODY_TEXT, FILES.BODY_HTML, FILES.NOT_PO_REASON, FILES.DUPLICATE, FILES.LINKS]
    .map((f) => f.replace(/[.]/g, '\\.'))
    .join('|')}|ocr-.*)$`,
);
