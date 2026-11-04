import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Locator, Page } from 'playwright';
import { MYNTRA_STR } from '../../../constants';
import { Log } from '../../intransit/sources/http';
import { MyntraConfig, withMyntraPortal } from '../../intransit/sources/myntra-partner-portal';

/*
 * The Myntra STR robot (2026-11-03): the steps of dev-tools/myntra-str-pull-many.ts (tested 2 Nov: one login, 45 of 45
 * STRs, ~11 s each, one retry needed), run in the In-transit worker process with the in-transit robot's Myntra login
 * (one browser job at a time). Never touches the database or S3: it returns each STR's CSV text and the parent stores it
 * (str.service.ts). Each downloaded file is read and DELETED at once (user: nothing kept on disk).
 *   1. Dashboard (saved session, else email + password: withMyntraPortal) -> FBM/PPMP/MDirect + DONE when asked.
 *   2. Inventory movement page (opened directly) -> STRs And Actions -> Filter to Search STRs.
 *   3. Per STR, in the email's order: STR -> Apply -> wait for its row -> open -> STR Details -> Download CSV.
 * An STR that fails (or is "not found": a slow list) is tried once more in the same run; still failing -> reported
 * (the next run tries again).
 */

export interface FetchedStr {
  str: string;
  csv: string | null;
  /** Not on the portal (yet), or why the download failed. */
  error?: string;
}

const between = (a: number, b: number) => a + Math.random() * (b - a);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const P = MYNTRA_STR.PORTAL;

const humanClick = async (page: Page, el: Locator) => {
  await el.waitFor({ state: 'visible', timeout: 30_000 });
  const box = await el.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * between(0.3, 0.7), box.y + box.height * between(0.3, 0.7), { steps: Math.round(between(12, 25)) });
  await page.waitForTimeout(between(150, 400));
  await el.click();
  await page.waitForTimeout(between(1200, 2000));
};

/** The relationship chooser shows on every visit (2 Nov, saved session too): FBM/PPMP/MDirect + DONE. */
const chooseTeam = async (page: Page) => {
  const card = page.getByText(P.TEAM_CARD, { exact: true }).first();
  if (await card.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)) {
    await humanClick(page, card);
    const done = page.getByRole('button', { name: 'DONE' });
    if (await done.isVisible().catch(() => false)) await humanClick(page, done);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
};

/** STRs And Actions with its filter, from anywhere in the portal (also closes an open STR panel). */
const openStrTab = async (page: Page) => {
  await page.goto(P.STR_PAGE);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await humanClick(page, page.getByText(P.TAB).locator('visible=true').first());
  await page.getByText(P.FILTER).locator('visible=true').first().waitFor({ state: 'visible', timeout: 30_000 });
};

const pullOne = async (page: Page, str: string, tmp: string): Promise<FetchedStr> => {
  const field = page.getByPlaceholder(/STR/i).locator('visible=true').first();
  const input = (await field.count()) ? field : page.getByRole('textbox').locator('visible=true').first();
  await input.click();
  await input.fill('');
  await input.pressSequentially(str, { delay: between(50, 100) });
  const apply = page.getByRole('button', { name: /^apply$/i }).first();
  const row = page.getByText(new RegExp(`^\\s*${esc(str)}\\s*$`)).locator('visible=true').first();
  // the list loads slowly at times (3 Nov: one STR "not found" that was there): wait for the page to settle and long
  // enough, then Apply once more before calling it not found
  const shows = async (ms: number) => {
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    return row.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
  };
  await humanClick(page, apply);
  if (!(await shows(MYNTRA_STR.ROW_WAIT_MS))) {
    await humanClick(page, apply);
    if (!(await shows(MYNTRA_STR.ROW_WAIT_AGAIN_MS))) return { str, csv: null, error: MYNTRA_STR.NOT_FOUND };
  }
  await page.waitForTimeout(between(600, 1200));
  await humanClick(page, row);
  await page.getByText(P.DETAILS).locator('visible=true').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(between(1200, 2000));
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    humanClick(page, page.getByText(P.DOWNLOAD).locator('visible=true').last()),
  ]);
  const file = path.join(tmp, `${str}.csv`);
  await dl.saveAs(file);
  try {
    return { str, csv: await fs.readFile(file, 'utf8') };
  } finally {
    await fs.rm(file, { force: true }); // never kept
  }
};

/** Downloads every STR of the list, in order, in ONE login; returns one result per STR. */
export const fetchMyntraStrs = (cfg: MyntraConfig, cacheDir: string, strs: string[], log: Log): Promise<FetchedStr[]> =>
  withMyntraPortal(cfg, cacheDir, log, async (page) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'myntra-str-'));
    const out: FetchedStr[] = [];
    try {
      await chooseTeam(page);
      await openStrTab(page);
      for (const [i, str] of strs.entries()) {
        let r: FetchedStr = { str, csv: null, error: 'not tried' };
        for (let t = 1; t <= MYNTRA_STR.TRIES_PER_RUN; t++) {
          const started = Date.now();
          try {
            r = await pullOne(page, str, tmp);
          } catch (err) {
            r = { str, csv: null, error: (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200) };
          }
          log(`  ${i + 1}/${strs.length} ${str}: ${r.csv !== null ? 'downloaded' : r.error} (${Math.round((Date.now() - started) / 1000)} s${t > 1 ? `, try ${t}` : ''})`);
          // a fresh tab for the next try / STR (closes the details panel)
          await openStrTab(page).catch(() => undefined);
          // "not found" is tried again too: the list was slow once (3 Nov, STNCPWEBW271026-04: found on the next look)
          if (r.csv !== null) break;
          await page.waitForTimeout(between(3_000, 6_000)); // a short pause before the next try
        }
        out.push(r);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    return out;
  });
