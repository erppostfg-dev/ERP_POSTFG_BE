import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { daysFromNow, dmy } from '../helpers/dates';

/*
 * No time bombs in test data (2026-11-23). The PO checks compare the expiry date with TODAY, so a FIXED future expiry
 * date in a test passes until that day and then turns the PO "expired" (In Review): tests fail and CI blocks every
 * deploy (First Club data expiring 2026-11-22 blocked the prod deploy on 23 Nov). Rule: an expiry date in test data
 * is either in the past on purpose (an expired PO, same result on every day) or comes from test/helpers/dates.ts
 * (FUTURE_EXPIRY / daysFromNow, always ahead). This test finds every fixed date on an expiry line and refuses the
 * future ones (up to 10 years ahead; 2099-style dates are fine), naming the file and line.
 */

const TEST_DIR = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.tmp', 'node_modules']);
const EXPIRY_LINE = /expir|valid.?(till|upto|until)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const testFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : testFiles(path.join(dir, e.name));
  return e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [];
});

/** Every fixed date written in quotes on a line, as YYYY-MM-DD (2026-12-31, 31.12.2026 / 31-12-2026 / 31/12/2026, 31-Dec-2026 / 31 Dec 2026). */
const quotedDates = (line: string): string[] => {
  const out: string[] = [];
  const iso = (y: string, m: string | number, d: string) => `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
  for (const [, y, m, d] of line.matchAll(/['"`](\d{4})-(\d{2})-(\d{2})/g)) out.push(iso(y, m, d));
  for (const [, d, m, y] of line.matchAll(/['"`](\d{1,2})[./-](\d{1,2})[./-](\d{4})/g)) out.push(iso(y, m, d));
  for (const [, d, mon, y] of line.matchAll(/['"`](\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-](\d{4})/g)) {
    const m = MONTHS.indexOf(mon.toLowerCase()) + 1;
    if (m) out.push(iso(y, m, d));
  }
  return out;
};

describe('test data has no fixed future expiry dates (test/helpers/dates.ts)', () => {
  it('reads every date format the channels print', () => {
    expect(quotedDates(`expiry_date: '2026-12-31', x: "31.12.2026", y: '31-12-2026', z: '31/12/2026'`)).toEqual(['2026-12-31', '2026-12-31', '2026-12-31', '2026-12-31']);
    expect(quotedDates(`'Expiry Date': '15-Aug-2026', 'Valid till': '15 Jun 2026'`)).toEqual(['2026-08-15', '2026-06-15']);
    expect(dmy('2026-12-06')).toBe('06.12.2026');
  });

  it('every expiry date written in a test is in the past (or comes from FUTURE_EXPIRY / daysFromNow)', () => {
    const today = daysFromNow(0);
    // far-future dates (2099-01-31 in d2c-transfers) never expire in practice: only those within 10 years are bombs
    const soon = daysFromNow(3650);
    const self = path.resolve(__filename);
    const bombs = testFiles(TEST_DIR).filter((f) => path.resolve(f) !== self).flatMap((file) =>
      fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, i) => (EXPIRY_LINE.test(line)
        ? quotedDates(line).filter((d) => d >= today && d < soon).map((d) => `${path.relative(TEST_DIR, file)}:${i + 1} expiry ${d}`)
        : [])));
    // A failure here: replace the fixed date with FUTURE_EXPIRY / daysFromNow(n) (dmy() for DD.MM.YYYY) from test/helpers/dates.ts.
    expect(bombs).toEqual([]);
  });
});
