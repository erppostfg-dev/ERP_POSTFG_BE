/** Month folder names in S3 (po-intake/FY.../<month>/), January first. */
export const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

export type MonthName = (typeof MONTHS)[number];

/** Folder dates are taken in Indian time (UTC+5:30), so an email at 01:00 IST on the 1st is in the new month. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Year folder for a date: the calendar year in IST, written FY<yy><yy+1>.
 * Any month of 2026 -> FY2627, 2027 -> FY2728 (by the user's rule, not the April-March financial year).
 */
export const yearFolder = (date: Date): string => {
  const yy = new Date(date.getTime() + IST_OFFSET_MS).getUTCFullYear() % 100;
  const two = (n: number): string => String(n % 100).padStart(2, '0');
  return `FY${two(yy)}${two(yy + 1)}`;
};

/** Month folder for a date, in IST. */
export const monthFolder = (date: Date): MonthName => MONTHS[new Date(date.getTime() + IST_OFFSET_MS).getUTCMonth()];
