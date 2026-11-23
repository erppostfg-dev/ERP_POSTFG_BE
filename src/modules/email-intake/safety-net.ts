import { env } from '../../config/env';
import { GMAIL_SAFETY } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { runJob } from '../../utils/log-call';
import { writeLog } from '../../utils/logger';
import type { ResolvedRoute } from './gmail-watch.service';
import { labelSafetyPass, processGmailChanges } from './label-router.service';

/*
 * Safety net for missed Pub/Sub notifications (2026-11-23; why + timings: constants GMAIL_SAFETY).
 *   - quiet check: after `quietMs` with no Gmail read (each notification does one), ONE history read. A tick only
 *     compares two times (no Gmail / DB call), so while notifications keep coming it costs nothing.
 *   - label check every `labelMs`: the labels' recent emails listed, only an email no one has taken is downloaded.
 * Both are handed to `enqueue` = the listener's one-at-a-time queue, so they never run next to a notification.
 * An email found by either = GMAIL_MISSED_NOTIFICATION (warn) with the count; its own [route] lines carry the jobId.
 */
export interface SafetyNet {
  /** A Gmail read just happened (a notification was handled): the quiet clock starts again. */
  markRead: () => void;
  stop: () => void;
}

export const startSafetyNet = (
  routes: ResolvedRoute[],
  enqueue: (job: () => Promise<void>) => void,
  opts: { quietMs?: number; labelMs?: number } = {},
): SafetyNet => {
  const quietMs = opts.quietMs ?? env.gmail.quietCheckMinutes * 60_000;
  const labelMs = opts.labelMs ?? env.gmail.labelCheckHours * 3_600_000;
  let lastReadAt = Date.now();
  const missed = (check: string, sent: number) => {
    if (sent > 0) writeLog('warn', LOG_SOURCE.GMAIL, GMAIL_SAFETY.MISSED_LOG, `${check}: ${sent} email(s) taken that no notification brought`, { check, sent });
  };

  const quietTimer = quietMs > 0 ? setInterval(() => {
    if (Date.now() - lastReadAt < quietMs) return;
    lastReadAt = Date.now();
    enqueue(async () => missed('quiet check', await runJob('gmail-quiet-check', () => processGmailChanges(routes))));
  }, Math.min(GMAIL_SAFETY.TICK_MS, quietMs)) : undefined;

  const labelTimer = labelMs > 0 ? setInterval(() => {
    enqueue(async () => missed('label check', await runJob('gmail-label-check', () => labelSafetyPass(routes, GMAIL_SAFETY.LABEL_LOOKBACK_HOURS * 3_600_000))));
  }, labelMs) : undefined;

  return {
    markRead: () => { lastReadAt = Date.now(); },
    stop: () => {
      if (quietTimer) clearInterval(quietTimer);
      if (labelTimer) clearInterval(labelTimer);
    },
  };
};
