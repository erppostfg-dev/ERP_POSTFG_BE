import fs from 'fs/promises';
import path from 'path';
import type { Browser, BrowserContext, Download, Page } from 'playwright';
import { waitForOtp } from '../../email-intake/otp-mail';
import { fileKind, frameToCsv, readReport, writeAtomic } from './files';
import { Log, sleep } from './http';

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
const SESSION_FILE = 'flipkart-seller-hub-session.json';
/** Seller Hub's OTP mail: "Flipkart Account - 123456 is your verification code for secure access". */
const OTP_QUERY = 'from:noreply@rmo.flipkart.com';
export const OTP_PATTERN = /\b(\d{6})\b[^\n]*verification code/i;

/** Seller Hub's left rail: the Inventory menu, and the links inside it (shown once the menu opens). */
const MENU_INVENTORY = 'trigger-menu-nav-menu-Inventory';
const NAV_INVENTORY = 'option-item-Sales & Inventory-nav-menu-Inventory';
const NAV_CONSIGNMENT = 'option-item-Consignment-nav-menu-Inventory';

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
    args: ['--disable-blink-features=AutomationControlled'],
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
  const link = page.getByTestId('custom-select-child-').getByText('download').first();
  for (let i = 1; i <= SOH_POLLS; i++) {
    await sleep(SOH_POLL_MS);
    await page.locator('[class*="CaretIcon"]').first().click(); // open the Download Ready list
    if (await link.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) return downloadBy(page, () => link.click(), log);
    log(`  Current Inventory still being prepared (${(i * SOH_POLL_MS) / 1000} s)`);
    await page.keyboard.press('Escape');
  }
  throw new Error(`Current Inventory not ready after ${(SOH_POLLS * SOH_POLL_MS) / 60_000} min - Seller Hub may be slow; fetch again`);
};

/** Inventory > Consignment > Bulk Consignment File. */
const downloadGrn = async (page: Page, log: Log): Promise<Uint8Array> => {
  await openMenu(page, NAV_CONSIGNMENT);
  return downloadBy(page, () => page.getByRole('button', { name: /Bulk Consignment File/ }).click(), log);
};

const FILES: Record<SellerHubFile, { name: string; download: (page: Page, log: Log) => Promise<Uint8Array> }> = {
  soh: { name: 'FK_SOH.csv', download: downloadSoh },
  grn: { name: 'FK_GRN.csv', download: downloadGrn },
};

const withSellerHub = async <T>(cfg: SellerHubConfig, cacheDir: string, log: Log, work: (page: Page) => Promise<T>): Promise<T> => {
  const sessionFile = path.join(cacheDir, SESSION_FILE);
  const { browser, context } = await openBrowser(cfg, sessionFile);
  try {
    const page = await context.newPage();
    await ensureLogin(page, context, cfg, sessionFile, log);
    return await work(page);
  } finally {
    await browser.close();
  }
};

/**
 * Writes FK_SOH.csv and FK_GRN.csv (or the ones in `only`) into outDir; returns the file names written. A file that
 * fails is logged and left out, so one slow report does not lose the other; it throws only when none was written.
 */
export const fetchSellerHub = async (cfg: SellerHubConfig, dirs: { outDir: string; cacheDir: string }, log: Log, only?: string[]): Promise<string[]> => {
  const wanted = (Object.keys(FILES) as SellerHubFile[]).filter((k) => !only?.length || only.includes(k));
  const written: string[] = [];
  const failed: string[] = [];
  await withSellerHub(cfg, dirs.cacheDir, log, async (page) => {
    for (const key of wanted) {
      const { name, download } = FILES[key];
      log(`${name}: downloading from Seller Hub ...`);
      try {
        const raw = await download(page, log);
        // the download as it came, next to the CSV the pipeline reads
        await writeAtomic(path.join(dirs.outDir, `${path.parse(name).name}.download.${fileKind(raw)}`), raw);
        const df = readReport(raw);
        await writeAtomic(path.join(dirs.outDir, name), frameToCsv(df));
        log(`${name}: ${df.length.toLocaleString('en-US')} rows`);
        written.push(name);
      } catch (err) {
        failed.push(name);
        log(`${name}: FAILED - ${err instanceof Error ? err.message : err}`);
      }
    }
  });
  if (!written.length) throw new Error(`Seller Hub: nothing downloaded (${failed.join(', ')} failed)`);
  return written;
};

/** Login check only (reuses or renews the saved session). */
export const checkSellerHub = (cfg: SellerHubConfig, cacheDir: string, log: Log): Promise<void> =>
  withSellerHub(cfg, cacheDir, log, async () => log('Flipkart Seller Hub login: OK'));
