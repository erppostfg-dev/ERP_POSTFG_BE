import fs from 'fs/promises';
import path from 'path';
import type { Browser, BrowserContext, Download, Page } from 'playwright';
import { waitForOtp } from '../../email-intake/otp-mail';
import { Log, sleep } from './http';
import { downloadEach, RobotFile } from './robot-files';

/*
 * Flipkart Seller Hub robot (port of intransit-service/intransit/sources/flipkart_rpa.py; user, 2026-10-28): a
 * headless browser clicks through Seller Hub the way a person does, because GRNs have no Flipkart API and the Seller
 * API is blocked on our partner id.
 *   FK_SOH.csv  Inventory > Report > Current Inventory > (Download Ready) download
 *   FK_GRN.csv  Inventory > Consignment > Bulk Consignment File
 * Login: the session's cookies are kept in cacheDir and reused while Flipkart accepts them. When they have expired
 * the robot logs in with FLIPKART_SELLER_USER / FLIPKART_SELLER_PASSWORD and reads the OTP from the intake mailbox
 * (Seller Hub mails it to support@, which lands there). The session file is as good as a logged-in browser.
 */

const HOME = 'https://seller.flipkart.com/';
/** The saved login (cookies); kept between jobs with the other caches (s3/caches.ts) where the S3 store is on. */
export const SELLER_HUB_SESSION_FILE = 'flipkart-seller-hub-session.json';
const SESSION_FILE = SELLER_HUB_SESSION_FILE;
/** Seller Hub's OTP mail: "Flipkart Account - 123456 is your verification code for secure access". */
const OTP_QUERY = 'from:noreply@rmo.flipkart.com';
export const OTP_PATTERN = /\b(\d{6})\b[^\n]*verification code/i;

/** Seller Hub's left rail: the Inventory menu, and the links inside it (shown once the menu opens). */
const MENU_INVENTORY = 'trigger-menu-nav-menu-Inventory';
const NAV_INVENTORY = 'option-item-Sales & Inventory-nav-menu-Inventory';
const NAV_CONSIGNMENT = 'option-item-Consignment-nav-menu-Inventory';

/** Popup buttons that only dismiss (closePopups): never Yes / Confirm / Delete. */
const POPUP_DISMISS = /^\s*(close|ok|okay|got it|cancel|skip|dismiss|not now|later|remind me later|no thanks|×|x)\s*$/i;

/** In-page: close every open popup with no text (a <dialog> by close(), else removed); returns the start of each one's HTML. */
const CLOSE_EMPTY_POPUPS = `[...document.querySelectorAll('dialog[open], [role="alertdialog"]')]
  .filter((d) => !d.innerText.trim())
  .map((d) => { const html = d.outerHTML.slice(0, 200); if (typeof d.close === 'function') d.close(); else d.remove(); return html; })`;

const STEP_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const DASHBOARD_TIMEOUT_MS = 60_000;
// Current Inventory is prepared after it is requested (about a minute on 28-Oct): look every 30 s, up to 10 min.
const SOH_POLL_MS = 30_000;
const SOH_POLLS = 20;

export interface SellerHubConfig {
  user?: string;
  password?: string;
  /** false shows the browser (debugging on a laptop). */
  headless?: boolean;
}

export const SELLER_HUB_KEYS = ['FLIPKART_SELLER_USER', 'FLIPKART_SELLER_PASSWORD'];
export type SellerHubFile = 'soh' | 'grn';

const requireLogin = (cfg: SellerHubConfig): { user: string; password: string } => {
  if (!cfg.user || !cfg.password) throw new Error(`fill in ${SELLER_HUB_KEYS.join(', ')} in .env`);
  return { user: cfg.user, password: cfg.password };
};

/**
 * Chromium with its automation flags hidden and a normal Chrome user agent: Seller Hub never finishes preparing the
 * Current Inventory file for a browser that announces it is automated (28-Oct), and headless Chrome says so in its
 * user agent.
 */
const openBrowser = async (cfg: SellerHubConfig, sessionFile: string): Promise<{ browser: Browser; context: BrowserContext }> => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: cfg.headless ?? true,
    ignoreDefaultArgs: ['--enable-automation'],
    // --disable-dev-shm-usage: Docker's 64 MB /dev/shm is too small for Chromium (it crashes on big pages)
    // --disable-gpu: headless has no GPU to use anyway, and Seller Hub has no bot check that looks at it
    // not LIGHT_ARGS (30-Oct): Current Inventory stopped being prepared with them (see withSellerHub)
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  const major = browser.version().split('.')[0];
  const saved = await fs.access(sessionFile).then(() => true, () => false);
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1500, height: 900 },
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    storageState: saved ? sessionFile : undefined,
  });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  return { browser, context };
};

/** Logged in = the dashboard is open (.../index.html#dashboard/...). */
const onDashboard = (page: Page, timeoutMs: number): Promise<boolean> =>
  // in-page code as a string: the server's tsconfig has no DOM types
  page.waitForFunction("location.hash.startsWith('#dashboard')", undefined, { timeout: timeoutMs }).then(() => true, () => false);

/** Open Seller Hub; when the saved session has expired, log in with the password and the mailed OTP. */
const ensureLogin = async (page: Page, context: BrowserContext, cfg: SellerHubConfig, sessionFile: string, log: Log): Promise<void> => {
  await page.goto(HOME);
  if (await onDashboard(page, 15_000)) {
    log('Seller Hub: logged in (saved session)');
  } else {
    const { user, password } = requireLogin(cfg);
    log('Seller Hub: logging in');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.getByRole('textbox', { name: /Username or phone number/ }).fill(user);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('textbox', { name: 'Enter password' }).fill(password);
    const sentAfterMs = Date.now();
    await page.getByTestId('button').nth(1).click();
    log('  waiting for the OTP mail ...');
    const otp = await waitForOtp({ query: OTP_QUERY, pattern: OTP_PATTERN, sentAfterMs });
    await page.getByRole('textbox', { name: 'Please enter verification' }).fill(otp[0]);
    for (let i = 1; i < otp.length; i++) await page.getByRole('textbox', { name: `Digit ${i + 1}` }).fill(otp[i]);
    if (!(await onDashboard(page, DASHBOARD_TIMEOUT_MS))) throw new Error('Seller Hub did not open the dashboard after the OTP');
    log('Seller Hub: logged in');
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await context.storageState({ path: sessionFile });
};

/** Click a left-rail link, opening the Inventory menu it sits in first when it is not on screen. */
const openMenu = async (page: Page, testId: string): Promise<void> => {
  const link = page.getByTestId(testId);
  if (!(await link.isVisible())) {
    const menu = page.getByTestId(MENU_INVENTORY);
    await menu.hover();
    await link.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => menu.click());
  }
  await link.click({ timeout: 15_000 }).catch(async (err: unknown) => {
    const ids = await page.evaluate<string[]>("[...document.querySelectorAll('[data-testid*=\"nav-menu\"]')].map((e) => e.dataset.testid)");
    throw new Error(`Seller Hub menu link "${testId}" not found (menu: ${ids.join(', ')}): ${err instanceof Error ? err.message : err}`);
  });
};

const downloadBy = async (page: Page, click: () => Promise<void>, log: Log): Promise<Uint8Array> => {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }), click()]) as [Download, void];
  log(`  downloaded ${download.suggestedFilename()}`);
  return new Uint8Array(await fs.readFile(await download.path()));
};

/** Inventory > Report > Current Inventory, then wait for it under Download Ready (asking again restarts it). */
const downloadSoh = async (page: Page, log: Log): Promise<Uint8Array> => {
  await openMenu(page, NAV_INVENTORY);
  // the button's name starts with icon-font characters, so match only its end
  await page.getByRole('button', { name: /Report\s*$/ }).first().click();
  await page.getByText('Current Inventory').first().click();
  const items = page.getByTestId('custom-select-child-');
  const link = items.getByText('download').first();
  // what the Download Ready list shows (30-Oct: logged so a file that never gets ready can be told from a list that
  // never opens or a request that never started)
  const listed = async (): Promise<string> => {
    const texts = (await items.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return texts.length ? texts.slice(0, 6).join(' | ') : '(empty, or the list did not open)';
  };
  let last = '';
  for (let i = 1; i <= SOH_POLLS; i++) {
    await sleep(SOH_POLL_MS);
    await page.locator('[class*="CaretIcon"]').first().click(); // open the Download Ready list
    if (await link.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) return downloadBy(page, () => link.click(), log);
    last = await listed();
    log(`  Current Inventory still being prepared (${(i * SOH_POLL_MS) / 1000} s)${i === 1 || i % 5 === 0 ? ` - Download Ready list: ${last}` : ''}`);
    await page.keyboard.press('Escape');
  }
  throw new Error(`Current Inventory not ready after ${(SOH_POLLS * SOH_POLL_MS) / 60_000} min (Download Ready list: ${last}) - Seller Hub may be slow; fetch again`);
};

/** Inventory > Consignment > Bulk Consignment File (also read by the Flipkart consignments robot, channel-api/flipkart). */
export const downloadGrn = async (page: Page, log: Log): Promise<Uint8Array> => {
  await openMenu(page, NAV_CONSIGNMENT);
  return downloadBy(page, () => page.getByRole('button', { name: /Bulk Consignment File/ }).click(), log);
};

const FILES: Record<SellerHubFile, RobotFile> = {
  soh: { name: 'FK_SOH.csv', download: downloadSoh },
  grn: { name: 'FK_GRN.csv', download: downloadGrn },
};

/** Where the browser was and what it showed (for a failed step's log: on a server nobody sees the window). */
const pageState = async (page: Page): Promise<string> => {
  const title = await page.title().catch(() => '');
  const text = ((await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  return `${page.url()} "${title}" - ${text.slice(0, 300) || '(no text)'}`;
};

/**
 * A Seller Hub popup (role=alertdialog) over the page blocks every click (2026-10-29: FK_GRN timed out behind one).
 * Whenever one is in the way, log its text and close it with a dismiss-type button (never one that confirms), else
 * Escape; Playwright then retries the click.
 */
const closePopups = async (page: Page, log: Log): Promise<void> => {
  const popup = page.locator('[role="alertdialog"]:visible, dialog[open]:visible').first();
  await page.addLocatorHandler(popup, async () => {
    // never throws: the page can close under it (the run ending) and a failed close only means the click retries
    try {
      const text = ((await popup.innerText({ timeout: 2_000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!text) {
        // an empty modal <dialog> (its content never loaded) still blocks the whole page, and Escape does not close it
        const closed = await page.evaluate<string[]>(CLOSE_EMPTY_POPUPS);
        log(`  Seller Hub empty popup closed: ${closed.join(' | ')}`);
        return;
      }
      log(`  Seller Hub popup in the way: "${text.slice(0, 160)}"`);
      const dismiss = popup.getByRole('button', { name: POPUP_DISMISS })
        .or(popup.locator('[aria-label*="close" i], [data-testid*="close" i]')).first();
      if (await dismiss.isVisible().catch(() => false)) await dismiss.click({ timeout: 5_000 });
      else await page.keyboard.press('Escape');
    } catch {
      // the click is retried (and the handler run again) while the popup stays
    }
  }, { noWaitAfter: true });
};

/**
 * Seller Hub with its saved login (renewed with the mailed OTP when expired) and popups handled; work gets the page.
 * Also used by the Flipkart consignments robot (channel-api/flipkart, 2026-10-30): one login for both robots.
 */
export const withSellerHub = async <T>(cfg: SellerHubConfig, cacheDir: string, log: Log, work: (page: Page) => Promise<T>): Promise<T> => {
  const sessionFile = path.join(cacheDir, SESSION_FILE);
  const { browser, context } = await openBrowser(cfg, sessionFile);
  const page = await context.newPage();
  try {
    await ensureLogin(page, context, cfg, sessionFile, log);
    await closePopups(page, log); // after login: the OTP step must never be dismissed
    // No skipHeavyContent here (30-Oct): with pictures / fonts blocked and the lighter browser, Seller Hub never
    // finished preparing Current Inventory (10 min x 2 on dev); it was ready in about a minute without them (28-Oct).
    return await work(page);
  } catch (err) {
    log(`  Seller Hub page when it failed: ${await pageState(page)}`);
    throw err;
  } finally {
    await browser.close();
  }
};

/**
 * Writes FK_SOH.csv and FK_GRN.csv (or the ones in `only`) into outDir; returns the file names written. A file that
 * fails is logged and left out, so one slow report does not lose the other; it throws only when none was written.
 */
export const fetchSellerHub = async (cfg: SellerHubConfig, dirs: { outDir: string; cacheDir: string }, log: Log, only?: string[]): Promise<string[]> => {
  // GRN first: it takes seconds, Current Inventory minutes (and GRN failed behind a popup when it came second, 29-Oct)
  const wanted = (['grn', 'soh'] as SellerHubFile[]).filter((k) => !only?.length || only.includes(k));
  const { written, failed } = await withSellerHub(cfg, dirs.cacheDir, log, (page) => downloadEach(page, wanted.map((k) => FILES[k]), {
    outDir: dirs.outDir,
    portal: 'Seller Hub',
    log,
    restart: async (p) => {
      await p.goto(HOME);
      await onDashboard(p, DASHBOARD_TIMEOUT_MS);
    },
    describe: pageState,
  }));
  if (!written.length) throw new Error(`Seller Hub: nothing downloaded (${failed.join(', ')} failed)`);
  return written;
};

/** Login check only (reuses or renews the saved session). */
export const checkSellerHub = (cfg: SellerHubConfig, cacheDir: string, log: Log): Promise<void> =>
  withSellerHub(cfg, cacheDir, log, async () => log('Flipkart Seller Hub login: OK'));
