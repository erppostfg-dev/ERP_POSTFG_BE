import fsp from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { ERROR_CODES, INTRANSIT_FOLDERS, INTRANSIT_SOURCE } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { appError } from '../../utils/AppError';
import { log as appLog } from '../../utils/logger';
import { Requester, RunView, startConnector } from './runs.service';
import { putCache } from './s3/caches';
import { storageOn, writeScope } from './s3/scope';
import { MYNTRA_SESSION_FILE } from './sources/myntra-partner-portal';

/*
 * A robot's login from a person's own browser (user, 2026-11-02: "tell the user to login to Myntra himself"). Myntra's
 * bot check refuses the server's own logins, so the person logs in to the portal in Chrome and the ERP Robot Login
 * extension (ERP_POSTFG_FE/extensions/erp-robot-login) hands its cookies to the In-transit page, which posts them here:
 *   POST /intransit/robots/:source/login   { cookies: chrome.cookies.Cookie[], localStorage?: [{ name, value }] }
 * Only the portal's own cookies are kept (another site's are dropped, never stored). They become the robot's saved
 * login (a Playwright storage state, as the robot writes it itself), stored where this server's robot reads it: app_state
 * with the S3 store on, else the cache folder. A GRN fetch (seconds) is started at once to prove the login.
 */

interface Portal {
  label: string;
  file: string;
  /** Cookies of these sites (and their subdomains) are kept. */
  domains: string[];
  /** The portal's own login: without one of these cookies on loginHost the robot lands on the login page. */
  loginHost: string;
  loginCookies: string[];
  /** The page whose localStorage goes with the cookies. */
  storageOrigin: string;
  how: string;
  /** What the check fetch asks for (the quick file). */
  checkOnly: string[];
}

const PORTALS: Partial<Record<string, Portal>> = {
  [INTRANSIT_SOURCE.MYNTRA]: {
    label: 'Myntra Partner Portal',
    file: MYNTRA_SESSION_FILE,
    domains: ['myntra.com', 'myntrainfo.com'],
    loginHost: 'partnersapi.myntrainfo.com',
    loginCookies: ['session', 'erp.at'],
    storageOrigin: 'https://partners.myntrainfo.com',
    how: 'log in at partners.myntrainfo.com in this browser (team FBM/PPMP/MDirect), then connect again',
    checkOnly: ['grn'],
  },
};

const MAX_COOKIES = 300;
const MAX_VALUE = 8_192;
const MAX_STORAGE_ITEMS = 200;
const MAX_STORAGE_VALUE = 100_000;

export interface StorageState {
  cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

// chrome.cookies sameSite: no_restriction | lax | strict | unspecified (the browser's default, Lax)
const SAME_SITE: Record<string, 'Strict' | 'Lax' | 'None'> = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const hostOf = (domain: string): string => domain.replace(/^\./, '').toLowerCase();

/** The posted cookies (and localStorage) as the robot's saved login; throws when they hold no portal login. */
export const storageStateOf = (portal: Portal, body: { cookies?: unknown; localStorage?: unknown }, now = Date.now()): StorageState => {
  if (!Array.isArray(body.cookies) || body.cookies.length > MAX_COOKIES) {
    throw appError(ERROR_CODES.INTRANSIT_LOGIN_INVALID, `cookies must be a list of at most ${MAX_COOKIES}`);
  }
  const cookies: StorageState['cookies'] = [];
  for (const raw of body.cookies as Record<string, unknown>[]) {
    const [name, value, domain] = [str(raw?.name), str(raw?.value), str(raw?.domain)];
    if (!name || value === null || !domain || value.length > MAX_VALUE) throw appError(ERROR_CODES.INTRANSIT_LOGIN_INVALID, 'a cookie without a name, value or domain');
    const host = hostOf(domain);
    if (!portal.domains.some((d) => host === d || host.endsWith(`.${d}`))) continue; // another site's: never stored
    const expires = typeof raw.expirationDate === 'number' && raw.expirationDate > 0 ? Math.floor(raw.expirationDate) : -1;
    if (expires !== -1 && expires * 1000 <= now) continue;
    const sameSite = SAME_SITE[String(raw.sameSite ?? '').toLowerCase()] ?? 'Lax';
    cookies.push({
      name, value, domain, path: str(raw.path) || '/', expires, httpOnly: raw.httpOnly === true, secure: raw.secure === true || sameSite === 'None', sameSite,
    });
  }
  if (!cookies.some((c) => hostOf(c.domain) === portal.loginHost && portal.loginCookies.includes(c.name))) {
    throw appError(ERROR_CODES.INTRANSIT_LOGIN_MISSING, portal.label, portal.how);
  }
  const items = Array.isArray(body.localStorage) ? (body.localStorage as Record<string, unknown>[]).slice(0, MAX_STORAGE_ITEMS) : [];
  const localStorage = items
    .map((i) => ({ name: str(i?.name), value: str(i?.value) }))
    .filter((i): i is { name: string; value: string } => !!i.name && i.value !== null && i.value.length <= MAX_STORAGE_VALUE);
  return { cookies, origins: localStorage.length ? [{ origin: portal.storageOrigin, localStorage }] : [] };
};

export interface SavedLogin {
  portal: string;
  cookies: number;
  /** The fetch started to prove the login (null when it could not start: checkError says why). */
  check: RunView | null;
  checkError: string | null;
}

/** Store a robot's login sent from a person's browser, then start a quick fetch with it. */
export const saveRobotLogin = async (source: string, body: { cookies?: unknown; localStorage?: unknown }, who: Requester): Promise<SavedLogin> => {
  const portal = PORTALS[source];
  if (!portal) throw appError(ERROR_CODES.INTRANSIT_SOURCE_UNKNOWN, source, Object.keys(PORTALS).join(', '));
  const state = storageStateOf(portal, body);
  const text = JSON.stringify(state, null, 2);
  if (storageOn()) {
    await putCache(portal.file, text, writeScope());
  } else {
    const dir = path.join(path.resolve(env.intransit.dir), INTRANSIT_FOLDERS.CACHE);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, portal.file), text, 'utf8');
  }
  // counts only: a saved login is as good as the password
  appLog.info(LOG_SOURCE.APP, `[intransit] ${portal.label} login saved from ${who.name ?? `user ${who.id}`}'s browser (${state.cookies.length} cookies)`);
  try {
    return { portal: portal.label, cookies: state.cookies.length, check: await startConnector(source, who, { only: portal.checkOnly }), checkError: null };
  } catch (err) {
    return { portal: portal.label, cookies: state.cookies.length, check: null, checkError: err instanceof Error ? err.message : String(err) };
  }
};
