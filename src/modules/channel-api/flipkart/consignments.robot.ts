import fs from 'fs/promises';
import type { Locator, Page } from 'playwright';
import { FLIPKART } from '../../../constants';
import { downloadGrn, SellerHubConfig, withSellerHub } from '../../intransit/sources/flipkart-seller-hub';
import { Log } from '../../intransit/sources/http';

/*
 * The Flipkart consignments robot (2026-10-30, port of Kunal's rpa-channel-codes/flipkart_rpa/fetch_csv_otp.py). Runs in
 * the In-transit worker process (one browser job at a time, the shared Seller Hub login); never touches the database:
 * it returns what it read and the parent stores it (consignments.service.ts).
 *   1. Seller Hub > Consignments > Scheduled, every page of the table (PAGE_SIZE rows a page).
 *   2. Each row's id (and text); a consignment not in `known` -> its 3-dots menu > Download CSV.
 *   3. Every row read exactly once (the table's own count), else the run fails (a page did not load / Flipkart changed it).
 *   4. The Bulk Consignment File (warehouse, creation date, status of every consignment) in the same session.
 * One consignment that fails to download is reported and retried at the next run; a page change fails the whole run.
 */

export interface FetchedConsignment {
  id: string;
  /** The table row's text, as shown. */
  row: string;
  /** The consignment CSV; null when it failed (error says why) or Seller Hub offers none (e.g. 0 products). */
  csv: string | null;
  error?: string;
}

export interface ConsignmentsRobotResult {
  /** What the table footer says it lists. */
  total: number;
  pages: number;
  /** Every id read (all pages). */
  seen: string[];
  /** The consignments not in `known`, with their CSV. */
  fetched: FetchedConsignment[];
  /** The Bulk Consignment File's text; null when it failed (bulkError). */
  bulkCsv: string | null;
  bulkError?: string;
}

const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

/** The table fills a few seconds after the page loads; an empty table is told apart by the count check. */
const waitForRows = async (page: Page): Promise<void> => {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.locator(FLIPKART.ROWS).filter({ hasText: FLIPKART.ROW_ID }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
};

/** (items, pages) from the footer, e.g. "1-16 of 16 items 1 of 1 pages". */
const pager = async (page: Page): Promise<{ total: number; pages: number }> => {
  const body = await page.locator('body').innerText();
  const items = FLIPKART.PAGER_ITEMS.exec(body);
  const pages = FLIPKART.PAGER_PAGES.exec(body);
  return { total: items ? Number(items[1]) : 0, pages: pages ? Number(pages[1]) : 1 };
};

const goToPage = async (page: Page, n: number): Promise<void> => {
  const first = page.locator(FLIPKART.ROWS).filter({ hasText: FLIPKART.ROW_ID }).first();
  const before = await first.innerText();
  const box = page.getByRole('spinbutton').first(); // the page-number box in the table footer
  await box.fill(String(n));
  await box.press('Enter');
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    if ((await first.count()) > 0 && (await first.innerText()) !== before) return waitForRows(page);
  }
  throw new Error(`Seller Hub: page ${n} of the Scheduled consignments did not load`);
};

/** 3-dots > Download CSV; null when the menu has no such option. */
const downloadCsv = async (page: Page, row: Locator): Promise<string | null> => {
  await row.getByRole('button', { name: FLIPKART.MENU_BUTTON, exact: true }).click();
  await page.locator(FLIPKART.MENU_OPTIONS).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
  const item = page.getByTestId(FLIPKART.MENU_ITEM).filter({ visible: true });
  if ((await item.count()) === 0) {
    await page.keyboard.press('Escape');
    return null;
  }
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), item.first().click({ timeout: 15_000 })]);
  const file = await download.path();
  await page.keyboard.press('Escape');
  return file ? (await fs.readFile(file, 'utf8')) : null;
};

export const fetchScheduledConsignments = (cfg: SellerHubConfig, cacheDir: string, known: string[], log: Log): Promise<ConsignmentsRobotResult> =>
  withSellerHub(cfg, cacheDir, log, async (page) => {
    const skip = new Set(known);
    log('Seller Hub: opening Consignments > Scheduled');
    await page.goto(FLIPKART.SCHEDULED_URL);
    await waitForRows(page);
    const size = page.locator('select').filter({ has: page.locator('option', { hasText: FLIPKART.PAGE_SIZE }) });
    if ((await size.count()) > 0) {
      await size.first().selectOption(FLIPKART.PAGE_SIZE);
      await waitForRows(page);
    }
    const { total, pages } = await pager(page);
    log(`  the list has ${total} consignment(s) on ${pages} page(s)`);

    const seen: string[] = [];
    const fetched: FetchedConsignment[] = [];
    for (let n = 1; n <= pages; n++) {
      if (n > 1) await goToPage(page, n);
      const rows = page.locator(FLIPKART.ROWS);
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim();
        const m = FLIPKART.ROW_ID.exec(rowText);
        if (!m) continue;
        const id = m[1];
        seen.push(id);
        if (skip.has(id)) continue;
        try {
          const csv = await downloadCsv(page, row);
          fetched.push({ id, row: rowText, csv, ...(csv === null ? { error: 'no Download CSV option (e.g. 0 products)' } : {}) });
          log(`  ${id}: ${csv === null ? 'no CSV offered, tried again next run' : 'CSV downloaded'}`);
        } catch (err) {
          await page.keyboard.press('Escape').catch(() => undefined);
          fetched.push({ id, row: rowText, csv: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
          log(`  ${id}: FAILED, tried again next run`);
        }
      }
    }
    // every row exactly once, across all pages (Kunal's check): else a page did not load or Flipkart changed it
    const distinct = new Set(seen).size;
    if (distinct !== total) throw new Error(`Seller Hub: read ${distinct} different consignment(s) but the list shows ${total}`);

    let bulkCsv: string | null = null;
    let bulkError: string | undefined;
    try {
      bulkCsv = text(await downloadGrn(page, log));
    } catch (err) {
      bulkError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      log(`  Bulk Consignment File not downloaded: ${bulkError}`);
    }
    return { total, pages, seen, fetched, bulkCsv, ...(bulkError ? { bulkError } : {}) };
  });
