import { env } from '../../../config/env';
import { AMAZON, ERROR_CODES } from '../../../constants';
import { appError } from '../../../utils/AppError';
import { LOG_SOURCE } from '../../../constants/logging';
import { logCall } from '../../../utils/log-call';

/*
 * Amazon SP-API client (GET only; 2026-10-16). Login with Amazon (LWA): the refresh token is swapped for an access
 * token, kept until a minute before it expires, then renewed by itself. Every call waits CALL_GAP_MS after the last,
 * retries on 429 (throttled) and 5xx with a growing wait, and never prints a token.
 */

let access: { token: string; until: number } | undefined;
let lastCall = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const spapiConfigured = (): boolean => {
  const c = env.channelApi.amazon;
  return !!(c.clientId && c.clientSecret && c.refreshToken && AMAZON.HOSTS[c.region]);
};

const token = async (): Promise<string> => {
  if (access && Date.now() < access.until) return access.token;
  const c = env.channelApi.amazon;
  const res = await logCall(LOG_SOURCE.AMAZON, 'LWA token', () => fetch(AMAZON.LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken ?? '', client_id: c.clientId ?? '', client_secret: c.clientSecret ?? '' }),
  }), { failedStatus: (r) => ((r as Response).ok ? undefined : (r as Response).status) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!body.access_token) throw appError(ERROR_CODES.SPAPI_LOGIN_FAILED, `${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
  access = { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  return access.token;
};

/** GET <host><path>; JSON back. Throws SPAPI_CALL_FAILED with Amazon's message (never the token). */
export const spapiGet = async <T>(path: string): Promise<T> => {
  const host = AMAZON.HOSTS[env.channelApi.amazon.region];
  for (let attempt = 1; attempt <= AMAZON.RETRIES; attempt++) {
    const gap = lastCall + AMAZON.CALL_GAP_MS - Date.now();
    if (gap > 0) await wait(gap);
    lastCall = Date.now();
    const accessToken = await token();
    // Every attempt is one line: AMAZON_RATE_LIMITED (429) / AMAZON_UNAVAILABLE (5xx) are retried below.
    const res = await logCall(LOG_SOURCE.AMAZON, `GET ${path.split('?')[0]}`, () => fetch(host + path, { headers: { 'x-amz-access-token': accessToken, accept: 'application/json' } }),
      { fields: { attempt }, failedStatus: (r) => ((r as Response).ok ? undefined : (r as Response).status) });
    if (res.status === 429 || res.status >= 500) {
      await wait(AMAZON.RETRY_BASE_MS * attempt);
      continue;
    }
    if (res.status === 401 || res.status === 403) access = undefined; // a stale token: the next call logs in again
    const body = (await res.json().catch(() => ({}))) as T & { errors?: { message?: string }[] };
    if (!res.ok) throw appError(ERROR_CODES.SPAPI_CALL_FAILED, res.status, path.split('?')[0], body.errors?.[0]?.message ?? '');
    return body;
  }
  throw appError(ERROR_CODES.SPAPI_CALL_FAILED, 429, path.split('?')[0], `still throttled after ${AMAZON.RETRIES} tries`);
};
