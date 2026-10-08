import { keysOf } from './keys';

/*
 * Every processed.json warning: a code (to filter or count them later, e.g. in the review queue) and its message.
 * A warning never stops a PO: the value it is about is left as the channel sent it, or "".
 * Usage: warnings.push(poWarning(WARNING_CODES.NOT_A_NUMBER, 'line 3 qty', 'abc')).
 */

const MESSAGES = {
  /** A field the channel's mapping expects is not in the raw OCR output. */
  RAW_FIELD_MISSING: (where: string, rawNames: string, common: string) =>
    `${where}: raw field ${rawNames} (for ${common}) is not in the OCR output`,
  NOT_A_NUMBER: (label: string, raw: string) => `${label}: "${raw}" is not a number`,
  NOT_A_DATE: (label: string, raw: string) => `${label}: "${raw}" is not a date this layer can read`,
  GST_COLUMNS_MISSING: (where: string, columns: string) => `${where}: GST columns ${columns} are not in the OCR output`,

  /** A raw value differs from the email body or subject (the raw value is kept). */
  CROSS_CHECK_MISMATCH: (field: string, raw: string, against: string, value: string) =>
    `${field}: raw "${raw}" differs from the ${against} "${value}"`,
  /** Scootsy: the facility in the raw Shipping Name differs from the subject's. */
  FACILITY_MISMATCH: (rawFacility: string, subjectFacility: string) =>
    `delivery_facility_code: raw Shipping Name "${rawFacility}" differs from the subject "${subjectFacility}"`,
  /** BigBasket: a PO number prefix that is not IRA (AUTO-PO) or IRM (MANUAL-PO). */
  PO_TYPE_UNKNOWN: (prefix: string, channel: string) => `po_type: PO number prefix "${prefix}" is not a known ${channel} type`,

  /** Purplle: the PO details (number, date, plant ...) are not the same on every line of one PO. */
  HEADER_DIFFERS_BETWEEN_LINES: (column: string, values: string) =>
    `header: "${column}" differs between the lines of this PO (${values})`,
  /** Purplle: a PO of the summary file is not listed in the email body's PO Summary. */
  PO_NOT_IN_BODY_SUMMARY: (poNumber: string) => `PO ${poNumber} is not in the email body's PO Summary`,
  /** Reliance: a line's value that repeats a header value (Delivery Date, Site) differs from it. */
  LINE_DIFFERS_FROM_HEADER: (where: string, column: string, value: string, header: string) =>
    `${where}: ${column} "${value}" differs from the header's "${header}"`,

  /** Totals that don't add up: "<field>: <one source> <value> differs from <other source> <value>". */
  TOTAL_QTY_MISMATCH: (source: string, value: number, other: string, otherValue: number) =>
    `total_qty: ${source} ${value} differs from ${other} ${otherValue}`,
  PO_VALUE_MISMATCH: (source: string, value: number, other: string, otherValue: number, tolerance?: number) =>
    `po_value: ${source} ${value} differs from ${other} ${otherValue}${tolerance !== undefined ? ` by more than ${tolerance}` : ''}`,
  BASE_VALUE_MISMATCH: (source: string, value: number, other: string, otherValue: number) =>
    `${source} ${value} differs from ${other} ${otherValue}`,
};

export type WarningCode = keyof typeof MESSAGES;
export type WarningArgs<C extends WarningCode> = Parameters<(typeof MESSAGES)[C]>;

/** WARNING_CODES.NOT_A_NUMBER === 'NOT_A_NUMBER', and so on for every warning. */
export const WARNING_CODES = keysOf(MESSAGES);

/** One warning in processed.json. */
export interface PoWarning {
  code: WarningCode;
  message: string;
}

export const poWarning = <C extends WarningCode>(code: C, ...args: WarningArgs<C>): PoWarning => ({
  code,
  message: (MESSAGES[code] as (...a: WarningArgs<C>) => string)(...args),
});
