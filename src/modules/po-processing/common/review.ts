import { HeaderKey, LineKey } from './apply-mapping';
import { ProcessedPo } from './processed-po';

/*
 * Manual review, Purplle only for now (user, 2026-10-07): whatever a channel doesn't send is never guessed; it stays
 * "" and is listed, so the validation step can fill it from our master data and a reviewer can fill the rest by hand.
 */

/**
 * The fields of `required` that are "" on this PO. A line field is listed once ("line_items.hsn") when any line
 * lacks it.
 */
export const missingFields = (po: ProcessedPo, required: { header: HeaderKey[]; line: LineKey[] }): string[] => [
  ...required.header.filter((k) => po[k] === ''),
  ...required.line.filter((k) => po.line_items.some((l) => l[k] === '')).map((k) => `line_items.${k}`),
];

/** Adds a review reason (once) and, when `always`, marks the PO for manual review whatever validation finds. */
export const addReviewReason = (po: ProcessedPo, reason: string, always = false): void => {
  po.review_reasons = po.review_reasons ?? [];
  if (!po.review_reasons.includes(reason)) po.review_reasons.push(reason);
  if (always) po.needs_review = true;
};
