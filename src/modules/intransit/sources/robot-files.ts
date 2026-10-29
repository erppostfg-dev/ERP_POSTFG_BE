import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { fileKind, frameToCsv, readReport, writeAtomic } from './files';
import { Log, sleep } from './http';

/*
 * The portal robots' downloads, one file after another (Seller Hub, Myntra Partner Portal). Asked back to back, the
 * portals failed the second file with errors and network failures (user, 2026-10-29), so the files are spaced out:
 * a pause and a fresh start page before each next file, and one more try of a failed file after a longer pause.
 */

/**
 * Chromium switches that only save CPU and memory (2026-10-29, small EC2): no extensions, sync, translate, sound or
 * background updates. None changes what a portal's bot check sees (GPU switches stay per robot: see each openBrowser).
 */
export const LIGHT_ARGS = [
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
];

const HEAVY_CONTENT = new Set(['image', 'media', 'font']);

/**
 * Pictures, video and fonts are not loaded: the robots only click and download, and these are most of a portal page's
 * weight. Set after the login (the login page stays as a person sees it, for the bot checks).
 */
export const skipHeavyContent = async (context: BrowserContext): Promise<void> => {
  // INTRANSIT_ROBOT_LIGHT=false loads everything again (for a portal that misbehaves without its pictures)
  if (process.env.INTRANSIT_ROBOT_LIGHT === 'false') return;
  await context.route('**/*', (route) => (HEAVY_CONTENT.has(route.request().resourceType()) ? route.abort() : route.continue()));
};

/** Pause before the next file of the same portal. */
export const FILE_GAP_MS = 20_000;
/** Pause before a failed file is tried again (once). */
export const RETRY_PAUSE_MS = 60_000;
const TRIES = 2;

export interface RobotFile {
  name: string;
  download: (page: Page, log: Log) => Promise<Uint8Array>;
}

/** Playwright's messages go on with their whole call log: the first line says what failed. */
export const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/**
 * Download each file, write it (the download as it came, and the CSV the pipeline reads) into outDir. `restart` puts
 * the page back on the portal's start page; `describe` says where the page is (logged when a file fails, as nobody
 * sees the window on a server). A file that fails twice is logged and left out, so one bad report does not lose the
 * others.
 */
export const downloadEach = async (page: Page, files: RobotFile[], opts: {
  outDir: string; portal: string; log: Log; restart: (page: Page) => Promise<void>; describe: (page: Page) => Promise<string>;
}): Promise<{ written: string[]; failed: string[] }> => {
  const { outDir, portal, log, restart, describe } = opts;
  const written: string[] = [];
  const failed: string[] = [];
  for (const [i, { name, download }] of files.entries()) {
    if (i > 0) {
      log(`  waiting ${FILE_GAP_MS / 1000} s before the next file (${portal} fails files asked back to back)`);
      await sleep(FILE_GAP_MS);
      await restart(page).catch((err: unknown) => log(`  ${portal}: start page did not open (${firstLine(err)})`));
    }
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      log(`${name}: downloading from ${portal}${attempt > 1 ? ` (try ${attempt})` : ''} ...`);
      try {
        const raw = await download(page, log);
        await writeAtomic(path.join(outDir, `${path.parse(name).name}.download.${fileKind(raw)}`), raw);
        const df = readReport(raw);
        await writeAtomic(path.join(outDir, name), frameToCsv(df));
        log(`${name}: ${df.length.toLocaleString('en-US')} rows`);
        written.push(name);
        break;
      } catch (err) {
        log(`${name}: FAILED - ${firstLine(err)}`);
        log(`  ${portal} page when it failed: ${await describe(page)}`);
        if (attempt === TRIES) {
          failed.push(name);
          break;
        }
        log(`  trying ${name} again in ${RETRY_PAUSE_MS / 1000} s`);
        await sleep(RETRY_PAUSE_MS);
        await restart(page).catch((e: unknown) => log(`  ${portal}: start page did not open (${firstLine(e)})`));
      }
    }
  }
  return { written, failed };
};
