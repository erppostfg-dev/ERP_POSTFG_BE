import { PoWarning, poWarning, WARNING_CODES } from '../../../constants';
import { Num } from './processed-po';

/*
 * Turns raw OCR text into clean values. A value that can't be read becomes "" and a warning is added,
 * so one bad cell never stops the whole PO.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export const text = (value: string | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();

/** "1,678,798.25" -> 1678798.25; "" -> "". */
export const toNumber = (value: string | undefined, label: string, warnings: PoWarning[]): Num => {
  const raw = text(value);
  if (!raw) return '';
  const n = Number(raw.replace(/[,\s₹]/g, '').replace(/^INR/i, ''));
  if (Number.isFinite(n)) return n;
  warnings.push(poWarning(WARNING_CODES.NOT_A_NUMBER, label, raw));
  return '';
};

const two = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): string | undefined =>
  y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${two(m)}-${two(d)}` : undefined;

/**
 * Any date the channels print -> "YYYY-MM-DD" (the time, if any, is dropped):
 * "Sept. 21, 2026, 11:39 a.m." / "Oct 5, 2026" (Blinkit, Scootsy), "05/Oct/2026" / "05-Oct-2026" (BigBasket),
 * "2026-10-05", "25.09.2026" / "25/09/2026" / "25-09-2026" (day first).
 */
export const toDate = (value: string | undefined, label: string, warnings: PoWarning[]): string => {
  const raw = text(value);
  if (!raw) return '';
  let m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    const out = month ? iso(Number(m[3]), month, Number(m[2])) : undefined;
    if (out) return out;
  }
  m = /^(\d{1,2})[/ -]([A-Za-z]{3,9})\.?[/ -]+(\d{4})/.exec(raw);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    const out = month ? iso(Number(m[3]), month, Number(m[1])) : undefined;
    if (out) return out;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (m) {
    const out = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (out) return out;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(raw);
  if (m) {
    const out = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (out) return out;
  }
  warnings.push(poWarning(WARNING_CODES.NOT_A_DATE, label, raw));
  return '';
};

/** The last 6-digit Indian pincode in an address, or "". */
export const pincodeFrom = (address: string): string => {
  const all = text(address).match(/\b\d{6}\b/g);
  return all ? all[all.length - 1] : '';
};
