import { env } from '../../config/env';
import { GMAIL_PACE } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { classifyError } from '../../utils/classify-error';
import { CallOptions, logCall } from '../../utils/log-call';
import { log } from '../../utils/logger';

/*
 * One pace for every Gmail call of the intake (2026-10-29, constants/gmail-intake.ts): catch-ups, Pub/Sub changes, the
 * start-up catch-up and attachment downloads share env.gmail.unitsPerMinute (Gmail counts units per user per minute;
 * the mailbox has 6,000). A token bucket: at most BURST_SECONDS worth at once, then refilled evenly. A call refused for
 * the rate limit (429 / rateLimitExceeded) or Gmail being briefly down (5xx) waits (Gmail's Retry-After, else 1 s, 2 s,
 * 4 s ... up to a minute) and is tried again, up to MAX_TRIES; meanwhile every other caller waits too.
 */

const RETRY_KINDS = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];

const perMs = () => env.gmail.unitsPerMinute / 60_000;
const capacity = () => (env.gmail.unitsPerMinute * GMAIL_PACE.BURST_SECONDS) / 60;

let tokens = capacity();
let refilledAt = Date.now();
let pausedUntil = 0;
let line: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `units` may be spent now; callers go one after another, in order. */
const take = (units: number): Promise<void> => {
  const turn = line.then(async () => {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(capacity(), tokens + (now - refilledAt) * perMs());
      refilledAt = now;
      const paused = pausedUntil - now;
      if (paused <= 0 && tokens >= units) {
        tokens -= units;
        return;
      }
      await sleep(Math.max(paused, Math.ceil((units - tokens) / perMs()), 1));
    }
  });
  line = turn.catch(() => undefined);
  return turn;
};

/** Gmail's Retry-After (seconds or a date) in ms, if it sent one. */
const retryAfterMs = (err: unknown): number | undefined => {
  const h = (err as { response?: { headers?: Record<string, string | undefined> } }).response?.headers?.['retry-after'];
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

/** A Gmail call of the intake: paced by its unit cost, retried on a rate limit / short outage. */
export const gmailCall = async <T>(op: string, units: number, fn: () => Promise<T>, opts: CallOptions = {}): Promise<T> => {
  for (let tryNo = 1; ; tryNo++) {
    await take(units);
    try {
      return await logCall(LOG_SOURCE.GMAIL, op, fn, { ...opts, expected: [...(opts.expected ?? []), ...(tryNo < GMAIL_PACE.MAX_TRIES ? RETRY_KINDS : [])] });
    } catch (err) {
      const kind = classifyError(LOG_SOURCE.GMAIL, err).kind;
      if (!RETRY_KINDS.includes(kind) || tryNo >= GMAIL_PACE.MAX_TRIES) throw err;
      const wait = Math.min(GMAIL_PACE.MAX_WAIT_MS, retryAfterMs(err) ?? env.gmail.retryFirstWaitMs * 2 ** (tryNo - 1));
      // everyone waits: the limit is the mailbox's, not this call's
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      log.warn(LOG_SOURCE.GMAIL, `[gmail] ${op}: ${kind}, waiting ${Math.round(wait / 100) / 10} s, then try ${tryNo + 1} of ${GMAIL_PACE.MAX_TRIES}`, opts.fields);
    }
  }
};
