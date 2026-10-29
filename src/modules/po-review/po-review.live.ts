import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { AppDataSource } from '../../config/data-source';
import { LIVE, REVIEW_LIVE, TABLES } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { logError } from '../../utils/classify-error';
import { inBackground } from '../../utils/log-context';
import { forgetPoIssues } from '../po-issues/po-issues.cache';

/*
 * Live PO Review + Approvals (2026-10-15, user: "on sync just like the live option on PO Overview"). The lists are small,
 * so instead of a change log the screens get a `version` of the review data: po_uploads (count + last update) and
 * po_review_submissions (count + last id + last update). When it changes, every open screen reloads its lists.
 *   - Our own actions (submit, approve, reject) call bumpReview(): the screens hear at once.
 *   - A watcher re-reads the version every REVIEW_LIVE.WATCH_MS while a screen is connected, which catches what other
 *     processes do (the email pipeline, po:resume, a second server): self-healing, nothing to restart.
 *   - The screen's fallback (SSE silent or failing) polls GET .../live-state every 60 s and compares the version.
 */

const bus = new EventEmitter();
bus.setMaxListeners(0);
let version = '';
let watcher: NodeJS.Timeout | undefined;
let checking: Promise<string> | undefined;

/** The current version of the review data (one cheap query). */
export const reviewVersion = async (): Promise<string> => {
  const [r] = (await AppDataSource.query(
    `SELECT (SELECT CONCAT(COUNT(*), '.', COALESCE(UNIX_TIMESTAMP(MAX(updated_at)), 0)) FROM ${TABLES.PO_UPLOADS}) u,
            (SELECT CONCAT(COUNT(*), '.', COALESCE(MAX(id), 0), '.', COALESCE(UNIX_TIMESTAMP(MAX(updated_at)), 0)) FROM ${TABLES.PO_REVIEW_SUBMISSIONS}) s`,
  )) as { u: string; s: string }[];
  return `${r.u}-${r.s}`;
};

/** Re-reads the version and tells the screens if it moved (one check at a time). */
const check = (): Promise<string> => {
  checking ??= reviewVersion()
    .then((v) => {
      if (version && v !== version) bus.emit('change', v);
      version = v;
      return v;
    })
    .catch((err) => {
      logError(LOG_SOURCE.DB, '[review-live] version check failed (retried on the next check)', err);
      return version;
    })
    .finally(() => { checking = undefined; });
  return checking;
};

/** After our own review actions: the screens hear at once (no-op while no screen is connected). */
export const bumpReview = (): void => {
  // a review decision / re-check / upload changed what PO issues shows: its shared answer is dropped (2026-10-29)
  forgetPoIssues();
  if (bus.listenerCount('change')) void check();
};

/** The SSE stream: `ping` every LIVE.HEARTBEAT_MS (with the version), `review` when the version changes. */
export const reviewEvents = async (req: Request, res: Response): Promise<void> => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onChange = (v: string) => send(REVIEW_LIVE.EVENT_CHANGE, { version: v });
  bus.on('change', onChange);
  // its own job name: started by the first screen's request, it must not carry that request on every tick (2026-10-27)
  watcher ??= inBackground('live-po-review', () => setInterval(() => void check(), REVIEW_LIVE.WATCH_MS));
  send(LIVE.EVENT_PING, { version: await check() });
  const beat = setInterval(() => send(LIVE.EVENT_PING, { version }), LIVE.HEARTBEAT_MS);
  req.on('close', () => {
    bus.off('change', onChange);
    clearInterval(beat);
    // No screen left: stop watching (the next screen starts it again).
    if (!bus.listenerCount('change') && watcher) { clearInterval(watcher); watcher = undefined; }
  });
};
