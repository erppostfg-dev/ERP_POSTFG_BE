import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { Browser, BrowserContext, Download, Locator, Page, Response } from 'playwright';
import { Log, sleep } from './http';
import { downloadEach, LIGHT_ARGS, RobotFile, skipHeavyContent } from './robot-files';

/*
 * Myntra Partner Portal robot (user, 2026-10-28; steps watched in a person's session the same day): a headless browser
 * does what a person does on partners.myntrainfo.com, which has no API for these files.
 *   Myntra_SOH.csv  Operational Reports > store MYNTRA, type PPMP > Seller_Inventory_Report > GENERATE REPORT; the job
 *                   is prepared by Myntra (~3 min) and downloaded from the link the jobs list gives
 *   Myntra_GRN.csv  Stock Movement Report > Lot View > DOWNLOAD (LotDetails-<day>.xlsx: the lots received in the last year)
 * Login: email + password on accounts.myntra.com (no OTP), then the team chooser (PARTNER_SELLER). The session's
 * cookies are kept in cacheDir and reused while Myntra accepts them. The login page sits behind Akamai's bot check,
 * which refuses automated and headless browsers ("Network Error"): see openBrowser and the person-paced login.
 */

const HOME = 'https://partners.myntrainfo.com/';
const DASHBOARD = 'https://partners.myntrainfo.com/Dashboard';
const STOCK_MOVEMENT = 'https://partners.myntrainfo.com/StockMovement/order';
const OPS_REPORTS = 'https://partners.myntrainfo.com/Reports/ops-reports';
/** The saved login (cookies); kept between jobs with the other caches (s3/caches.ts) where the S3 store is on. */
export const MYNTRA_SESSION_FILE = 'myntra-partner-portal-session.json';
const SESSION_FILE = MYNTRA_SESSION_FILE;
/** A top-menu entry the portal shows only to a logged-in partner. */
const PORTAL_MENU = 'Buying & Inventory';
/** The team chosen after login (as the team does by hand): the card, and the option it selects. */
const TEAM_CARD = 'FBM/PPMP/MDirect';
const TEAM = 'PARTNER_SELLER';
/** The SOH report as the form names it, and as the jobs list identifies it (report 16, store 2297 = MYNTRA). */
const REPORT = { store: 'MYNTRA', partnerType: 'PPMP', name: 'Seller_Inventory_Report', id: 16, storeId: '2297' };

const STEP_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
// Seller_Inventory_Report took ~3 min on 28-Oct: look every 30 s, up to 20 min.
const JOB_POLL_MS = 30_000;
const JOB_TIMEOUT_MS = 20 * 60_000;
/** When Myntra will not queue a new report, a completed one younger than this is used instead. */
const REUSE_MAX_AGE_MS = 2 * 3_600_000;

export interface MyntraConfig {
  user?: string;
  password?: string;
  /** false shows the browser (debugging on a laptop). */
  headless?: boolean;
}

export const MYNTRA_KEYS = ['MYNTRA_PARTNER_USER', 'MYNTRA_PARTNER_PASSWORD'];
export type MyntraFile = 'soh' | 'grn';

const requireLogin = (cfg: MyntraConfig): { user: string; password: string } => {
  if (!cfg.user || !cfg.password) throw new Error(`fill in ${MYNTRA_KEYS.join(', ')} in .env`);
  return { user: cfg.user, password: cfg.password };
};

/** A private X display for the browser on a server without a screen (Xvfb, installed in the Docker image). */
const startXvfb = async (): Promise<{ display: string; stop: () => void }> => {
  const display = `:${100 + Math.floor(Math.random() * 400)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  const failed = await new Promise<Error | null>((resolve) => {
    xvfb.once('error', resolve);
    xvfb.once('exit', (code) => resolve(new Error(`Xvfb exited (${code})`)));
    setTimeout(() => resolve(null), 1000);
  });
  if (failed) throw new Error(`no screen for the Myntra browser: Xvfb could not start (${failed.message}); install xvfb or set DISPLAY`);
  return { display, stop: () => xvfb.kill() };
};

/**
 * A real (headed) Chromium window, kept out of sight: Akamai refuses the headless modes outright (the headless shell
 * cannot even open the login page; new headless gets "Network Error" at LOG IN; a headed window logs in - 28-Oct).
 * "Headless" here = nobody sees it: a private Xvfb display on Linux without one, an off-screen window elsewhere.
 * Automation flags hidden and a normal Chrome user agent, as for Seller Hub.
 */
const openBrowser = async (cfg: MyntraConfig, sessionFile: string): Promise<{ browser: Browser; context: BrowserContext }> => {
  const { chromium } = await import('playwright');
  const hidden = cfg.headless ?? true;
  // --disable-dev-shm-usage: Docker's 64 MB /dev/shm is too small for Chromium (it crashes on big pages)
  // no --disable-gpu here: Akamai reads the graphics (WebGL) a browser reports, and a missing one looks like a robot
  const args = ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', ...LIGHT_ARGS];
  let screen: { display: string; stop: () => void } | null = null;
  if (hidden && process.platform === 'linux' && !process.env.DISPLAY) screen = await startXvfb();
  else if (hidden) args.push('--window-position=-32000,-32000');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chromium',
    ignoreDefaultArgs: ['--enable-automation'],
    args,
    env: screen ? { ...process.env, DISPLAY: screen.display } : undefined,
  }).catch((err: unknown) => {
    screen?.stop();
    throw err;
  });
  if (screen) browser.on('disconnected', screen.stop);
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

const between = (a: number, b: number): number => a + Math.random() * (b - a);

/** Move the mouse onto an element in small steps, pause, click, pause. */
const humanClick = async (page: Page, el: Locator): Promise<void> => {
  await el.waitFor({ state: 'visible' });
  const box = await el.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * between(0.3, 0.7), box.y + box.height * between(0.3, 0.7), { steps: Math.round(between(12, 25)) });
  await page.waitForTimeout(between(150, 400));
  await el.click();
  await page.waitForTimeout(between(1500, 2500));
};

/** Click into a field and type key by key. */
const humanType = async (page: Page, el: Locator, text: string): Promise<void> => {
  await el.waitFor({ state: 'visible' });
  const box = await el.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * between(0.2, 0.6), box.y + box.height / 2, { steps: Math.round(between(10, 20)) });
  await el.click();
  await el.pressSequentially(text, { delay: between(70, 140) });
  await page.waitForTimeout(between(400, 900));
};

/** Logged in = a portal page other than the landing page is open (Dashboard, ...). */
const inPortal = (page: Page, timeoutMs: number): Promise<boolean> =>
  page.waitForURL(/partners\.myntrainfo\.com\/(?!$|\?)/, { timeout: timeoutMs }).then(() => true, () => false);

/**
 * The team chooser pops up on the Dashboard right after a login (watched 28-Oct): click the "FBM/PPMP/MDirect" card,
 * which selects PARTNER_SELLER (its radio is hidden inside the card), then DONE. Without it the session stays on the
 * account's default team, whose Lot View names the STR column "PO Code" instead of "STR Code".
 */
const chooseTeam = async (page: Page, log: Log, required = true): Promise<void> => {
  const card = page.getByText(TEAM_CARD, { exact: true }).first();
  if (!(await card.waitFor({ state: 'visible', timeout: required ? 20_000 : 10_000 }).then(() => true, () => false))) {
    if (!required) {
      log('Myntra: no team chooser (the team chosen at the last login stays; the GRN column check catches a wrong one)');
      return;
    }
    throw new Error(`the team chooser ("${TEAM_CARD}") did not show after login`);
  }
  await humanClick(page, card);
  // the portal tags elements with data-test-id (hyphenated), not Playwright's default data-testid
  const option = page.locator(`[data-test-id="${TEAM}"]`);
  // the card click selects it; the radio is only a fallback (the chooser opened from GO TO DASHBOARD has none, 29-Oct)
  if ((await option.count()) && !(await option.isChecked().catch(() => false))) await option.check({ force: true, timeout: 5_000 }).catch(() => undefined);
  // caught here: when DONE is not found the wait must not end the process as an unhandled rejection
  const switched = page.waitForResponse((r) => r.url().includes('/team/switch'), { timeout: required ? STEP_TIMEOUT_MS : 15_000 })
    .then((r) => r, () => null);
  const done = page.getByRole('button', { name: 'DONE' });
  if (!required && !(await done.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false))) {
    log('Myntra: team unchanged (the chooser has no DONE; the GRN column check catches a wrong team)');
    return;
  }
  await humanClick(page, done);
  const res = await switched;
  if (!res) {
    // after GO TO DASHBOARD the team is usually still the one chosen at the last login: DONE switches nothing (29-Oct)
    if (!required) {
      log('Myntra: team unchanged (no switch was needed; the GRN column check catches a wrong team)');
      return;
    }
    throw new Error('Myntra did not switch the team after DONE');
  }
  if (!res.ok()) throw new Error(`Myntra team switch answered ${res.status()}`);
  log(`Myntra: team ${TEAM}`);
};

/**
 * From the landing page to the email login form (at a person's pace: the bot check scores the mouse moves). The page
 * shows LOGIN, or - while Myntra's account login is still alive but the portal's session ended (another login of the
 * account ends it, 29-Oct) - GO TO DASHBOARD, which may open the portal without a password ('portal').
 */
const openLoginForm = async (page: Page): Promise<'form' | 'portal' | null> => {
  await page.goto(HOME);
  const login = page.getByRole('button', { name: /^login$/i });
  const toDashboard = page.getByText(/^\s*go to dashboard\s*$/i).first();
  const useEmail = page.getByRole('button', { name: /Use Email/i });
  await login.or(toDashboard).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
  if (await toDashboard.isVisible()) {
    await humanClick(page, toDashboard);
  } else if (await login.isVisible()) {
    await humanClick(page, login);
  } else return null;
  // in the portal = off the landing page (its menu shows only once the team is chosen: the chooser may be up first)
  const opened = await Promise.race([
    page.waitForURL(/partners\.myntrainfo\.com\/(?!$|\?)/, { timeout: 30_000 }).then(() => 'portal' as const),
    useEmail.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'form' as const),
  ]).catch(() => null);
  if (opened === 'form') await humanClick(page, useEmail);
  return opened;
};

/** Open the portal; when the saved session has expired, log in with the email and password. */
const ensureLogin = async (page: Page, context: BrowserContext, cfg: MyntraConfig, sessionFile: string, log: Log): Promise<void> => {
  // a portal page opens straight away with a valid session (the landing page does not show the portal then)
  await page.goto(DASHBOARD);
  const loggedIn = await page.getByText(PORTAL_MENU, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
  if (loggedIn) {
    log('Myntra: logged in (saved session)');
  } else {
    const { user, password } = requireLogin(cfg);
    log('Myntra: logging in');
    // the login form sometimes does not open (2026-10-29, dev server: no "Use Email"): try once more after a pause
    let opened = await openLoginForm(page);
    if (!opened) {
      log(`Myntra: the login form did not open (${await pageState(page)}); trying once more`);
      await page.waitForTimeout(between(8_000, 15_000));
      opened = await openLoginForm(page);
      if (!opened) {
        throw new Error(`the Myntra login form did not open - ${await pageState(page)}. Myntra's bot check may be blocking this server: `
          + 'log in on a laptop and hand the session over (npm run intransit:session -- --source myntra --scope test|prod)');
      }
    }
    if (opened === 'portal') {
      log('Myntra: logged in (account still logged in: GO TO DASHBOARD)');
      // best effort here: the session usually keeps its team, and a wrong one fails the GRN column check visibly
      await chooseTeam(page, log, false).catch((err: unknown) => log(`Myntra: team not chosen (${err instanceof Error ? err.message.split('\n')[0] : err})`));
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await context.storageState({ path: sessionFile });
      return;
    }
    await humanType(page, page.getByRole('textbox', { name: 'Email' }), user);
    await humanType(page, page.getByRole('textbox', { name: 'Password' }), password);
    await page.mouse.move(between(300, 1200), between(200, 700), { steps: 20 });
    await page.waitForTimeout(between(2500, 4000));
    await humanClick(page, page.getByRole('button', { name: 'LOG IN' }));
    if (!(await inPortal(page, STEP_TIMEOUT_MS))) {
      const said = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').match(/[^.]*(error|invalid|incorrect|try again)[^.]*/i)?.[0];
      throw new Error(`Myntra login did not open the portal${said ? `: "${said.trim().slice(0, 120)}"` : ''}`);
    }
    log('Myntra: logged in');
    // the chooser shows only after a login; a saved session keeps the team chosen then
    await chooseTeam(page, log);
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await context.storageState({ path: sessionFile });
};

const bytesOfDownload = async (download: Download, log: Log): Promise<Uint8Array> => {
  log(`  downloaded ${download.suggestedFilename()}`);
  return new Uint8Array(await fs.readFile(await download.path()));
};

/** Stock Movement Report > Lot View > DOWNLOAD (the portal builds the xlsx in the page from the last year's lots). */
const downloadGrn = async (page: Page, log: Log): Promise<Uint8Array> => {
  await page.goto(STOCK_MOVEMENT);
  await page.getByText('Lot View', { exact: true }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
    page.getByRole('button', { name: 'DOWNLOAD' }).click(),
  ]) as [Download, void];
  return bytesOfDownload(download, log);
};

/** A row of the portal's report jobs list (/api/partners/report/jobs/search, newest first). */
export interface ReportJob {
  id: number;
  reportId: number;
  status: string;
  createdOn: number;
  queryParams?: string | Record<string, unknown>;
}
const jsonOf = (res: Response): Promise<{ status?: { statusType?: string; statusMessage?: string }; data?: unknown } | null> => res.json().catch(() => null);
const isDone = (j: ReportJob): boolean => j.status.toUpperCase() === 'COMPLETED';

/**
 * Pick `option` in the form's dropdown labelled `label`. The page holds other dropdowns of the same kind (page size)
 * and every option list at once, so the field is found by its label and the option inside the list it controls.
 */
const pick = async (page: Page, label: string, option: string): Promise<void> => {
  const field = page.locator('.u-field-container').filter({ has: page.locator('label', { hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }) }).first();
  const listId = await field.getByRole('combobox').getAttribute('aria-controls');
  await field.locator('.u-input-select-button').click();
  const choice = (listId ? page.locator(`[id="${listId}"]`) : page).getByRole('option', { name: option, exact: true }).first();
  await choice.click();
  await page.waitForTimeout(800);
};

/** Reload Operational Reports and read the jobs list its own call returns (newest first, as the table shows them). */
const listJobs = async (page: Page): Promise<ReportJob[]> => {
  const listed = page.waitForResponse((r) => r.url().includes('/report/jobs/search'), { timeout: STEP_TIMEOUT_MS });
  await page.reload();
  const data = (await jsonOf(await listed))?.data;
  return Array.isArray(data) ? (data as ReportJob[]) : [];
};

/** Click the DOWNLOAD of a completed job: the job's own file link answers 404, DOWNLOAD signs one (28-Oct). */
const downloadJob = async (page: Page, jobs: ReportJob[], job: ReportJob, log: Log): Promise<Uint8Array> => {
  // only completed rows carry a DOWNLOAD, in the list's order
  const nth = jobs.slice(0, jobs.indexOf(job)).filter(isDone).length;
  const link = page.locator('table').last().getByText('DOWNLOAD', { exact: true }).nth(nth);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }), link.click()]) as [Download, void];
  return bytesOfDownload(download, log);
};

/** The newest completed Seller_Inventory_Report of the MYNTRA store younger than REUSE_MAX_AGE_MS, if any. */
export const recentReport = (jobs: ReportJob[], now = Date.now()): ReportJob | undefined =>
  jobs.find((j) => isOurReport(j) && isDone(j) && now - j.createdOn < REUSE_MAX_AGE_MS);

/** Our report: Seller_Inventory_Report for the MYNTRA store. */
const isOurReport = (j: ReportJob): boolean => {
  // queryParams comes as an object or as JSON text, storeId as a number or a string
  const params = typeof j.queryParams === 'string' ? j.queryParams : JSON.stringify(j.queryParams ?? {});
  return j.reportId === REPORT.id && new RegExp(`"storeId":"?${REPORT.storeId}"?`).test(params);
};

/**
 * Operational Reports > MYNTRA / PPMP / Seller_Inventory_Report > GENERATE REPORT, then wait for the job (the page is
 * reloaded and its jobs list read) and click its DOWNLOAD. Myntra refuses a new job a few minutes after the last one
 * ("Internal server error while scheduling report job", 28-Oct); then the newest completed one is used if it is recent.
 */
const downloadSoh = async (page: Page, log: Log): Promise<Uint8Array> => {
  await page.goto(OPS_REPORTS);
  await page.getByRole('button', { name: 'GENERATE REPORT' }).waitFor();
  await pick(page, 'Store', REPORT.store);
  await pick(page, 'Partner Type', REPORT.partnerType);
  await pick(page, 'Report', REPORT.name);
  const scheduled = page.waitForResponse((r) => r.url().includes('/report/jobs/schedule'), { timeout: STEP_TIMEOUT_MS });
  await page.getByRole('button', { name: 'GENERATE REPORT' }).click();
  const answer = await jsonOf(await scheduled);
  const queued = Array.isArray(answer?.data) ? (answer?.data[0] as Partial<ReportJob> | undefined) : (answer?.data as Partial<ReportJob> | undefined);
  const jobId = answer?.status?.statusType === 'ERROR' ? undefined : queued?.id;

  if (jobId === undefined) {
    const jobs = await listJobs(page);
    const recent = recentReport(jobs);
    if (!recent) throw new Error(`${REPORT.name} was not queued (Myntra: ${answer?.status?.statusMessage ?? 'no answer'}) and none completed in the last ${REUSE_MAX_AGE_MS / 3_600_000} h`);
    log(`  Myntra did not queue a new ${REPORT.name} (${answer?.status?.statusMessage ?? 'no answer'}); using job ${recent.id} of ${new Date(recent.createdOn).toISOString()}`);
    return downloadJob(page, jobs, recent, log);
  }
  log(`  ${REPORT.name}: job ${jobId} queued`);

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (let waited = JOB_POLL_MS; Date.now() < deadline; waited += JOB_POLL_MS) {
    await sleep(JOB_POLL_MS);
    const jobs = await listJobs(page);
    const mine = jobs.find((j) => j.id === jobId);
    if (!mine) throw new Error(`${REPORT.name} job ${jobId} is not in the jobs list`);
    if (isDone(mine)) return downloadJob(page, jobs, mine, log);
    if (/FAIL|ERROR|CANCEL/i.test(mine.status)) throw new Error(`${REPORT.name} job ${jobId} ended as ${mine.status}`);
    log(`  ${REPORT.name} still being prepared (${waited / 1000} s, ${mine.status})`);
  }
  throw new Error(`${REPORT.name} not ready after ${JOB_TIMEOUT_MS / 60_000} min - Myntra may be slow; fetch again`);
};

const FILES: Record<MyntraFile, RobotFile> = {
  soh: { name: 'Myntra_SOH.csv', download: downloadSoh },
  grn: { name: 'Myntra_GRN.csv', download: downloadGrn },
};

const withPortal = async <T>(cfg: MyntraConfig, cacheDir: string, log: Log, work: (page: Page) => Promise<T>): Promise<T> => {
  const sessionFile = path.join(cacheDir, SESSION_FILE);
  const { browser, context } = await openBrowser(cfg, sessionFile);
  const page = await context.newPage();
  try {
    await ensureLogin(page, context, cfg, sessionFile, log);
    await skipHeavyContent(context);
    return await work(page);
  } catch (err) {
    log(`  Myntra page when it failed: ${await pageState(page)}`);
    throw err;
  } finally {
    await browser.close();
  }
};

/** Where the browser was and what it showed (for a failed step's log: on a server nobody sees the window). */
const pageState = async (page: Page): Promise<string> => {
  const title = await page.title().catch(() => '');
  const text = ((await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  return `${page.url()} "${title}" - ${text.slice(0, 300) || '(no text)'}`;
};

/**
 * Writes Myntra_SOH.csv and Myntra_GRN.csv (or the ones in `only`) into outDir; returns the file names written. A file
 * that fails is logged and left out, so one slow report does not lose the other; it throws only when none was written.
 */
export const fetchMyntra = async (cfg: MyntraConfig, dirs: { outDir: string; cacheDir: string }, log: Log, only?: string[]): Promise<string[]> => {
  // GRN first: it takes seconds, the SOH job minutes
  const wanted = (['grn', 'soh'] as MyntraFile[]).filter((k) => !only?.length || only.includes(k));
  const { written, failed } = await withPortal(cfg, dirs.cacheDir, log, (page) => downloadEach(page, wanted.map((k) => FILES[k]), {
    outDir: dirs.outDir,
    portal: 'the Myntra Partner Portal',
    log,
    restart: async (p) => void (await p.goto(DASHBOARD)),
    describe: pageState,
  }));
  if (!written.length) throw new Error(`Myntra: nothing downloaded (${failed.join(', ')} failed)`);
  return written;
};

/** Login check only (reuses or renews the saved session). */
export const checkMyntra = (cfg: MyntraConfig, cacheDir: string, log: Log): Promise<void> =>
  withPortal(cfg, cacheDir, log, async () => log('Myntra Partner Portal login: OK'));
