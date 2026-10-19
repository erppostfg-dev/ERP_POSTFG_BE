import { Message, PubSub, Subscription } from '@google-cloud/pubsub';
import { google } from 'googleapis';
import { env } from '../../config/env';
import { ERROR_CODES } from '../../constants';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { logError } from '../../utils/classify-error';
import { runJob } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { getAuthClient } from './gmail.client';
import { keepWatching, resolveRoutes } from './gmail-watch.service';
import { groupDirFor, NOT_PO_SUFFIX } from './email-storage.service';
import { catchUpOnStart, processGmailChanges } from './label-router.service';
import { mirrorLater, syncLabelToS3 } from './s3-mirror.service';
import { queueOcrBacklog } from '../ocr/extract-po.service';

const pubsubClient = (): PubSub => {
  const { projectId, keyFile } = env.pubsub;
  if (keyFile) return new PubSub({ projectId, keyFilename: keyFile });
  // Reuse the mailbox login (its refresh token must include the Pub/Sub scope).
  return new PubSub({ projectId, auth: new google.auth.GoogleAuth({ authClient: getAuthClient() }) });
};

/**
 * Starts the Gmail watch, catches up on emails that arrived while the server was off (and backfills
 * a label the first time it is watched), then pulls new-email notifications from the Pub/Sub
 * subscription. Everything runs one at a time on one queue: each notification only says "the mailbox changed".
 */
export const startEmailListener = async (): Promise<{ stop: () => Promise<void> }> => {
  const { subscription: subscriptionId } = env.pubsub;
  if (!subscriptionId) throw appError(ERROR_CODES.PUBSUB_SUBSCRIPTION_MISSING);

  const routes = await resolveRoutes();
  const renewTimer = await keepWatching(routes);

  const subscription: Subscription = pubsubClient().subscription(subscriptionId, {
    flowControl: { maxMessages: 1, allowExcessMessages: false },
  });

  // Startup catch-up first; notifications that arrive meanwhile wait behind it.
  let queue: Promise<void> = runJob('gmail-catch-up', () => catchUpOnStart(routes)).catch((err) => {
    logError(LOG_SOURCE.GMAIL, 'startup catch-up failed; the next notification retries it', err);
  });
  // Then: OCR for stored POs that never had it (OCR_ENABLED + OCR_BACKLOG; only <label>/, never <label>-not-po/).
  void queue.then(async () => {
    if (!env.ocr.enabled || !env.ocr.backlog) return;
    const b = await queueOcrBacklog(routes.map((r) => groupDirFor(r.label)));
    const waitingNote = b.found > b.queued ? `; ${b.found - b.queued} wait for the next start (OCR_RUN_LIMIT ${env.ocr.runLimit})` : '';
    log.info(LOG_SOURCE.OCR, `backlog: ${b.found} stored email(s) without OCR, ${b.queued} queued${waitingNote}`);
  }).catch((err) => logError(LOG_SOURCE.OCR, 'OCR backlog failed (the next start tries again)', err));

  // And upload to S3 whatever is stored locally but not in S3 yet (e.g. while S3 or the server was down).
  void queue.then(() => {
    for (const route of routes) {
      for (const dir of [groupDirFor(route.label), `${groupDirFor(route.label)}${NOT_PO_SUFFIX}`]) {
        mirrorLater(`startup sync ${dir}`, async () => {
          const r = await syncLabelToS3(dir);
          log.info(LOG_SOURCE.S3, `${dir}: ${r.emails} email(s), ${r.uploaded} file(s) uploaded, ${r.same} already in S3`);
        });
      }
    }
  });
  subscription.on('message', (message: Message) => {
    queue = queue.then(async () => {
      try {
        const data = JSON.parse(message.data.toString('utf8')) as { emailAddress?: string; historyId?: number | string };
        log.info(LOG_SOURCE.PUBSUB, `${data.emailAddress} changed (historyId ${data.historyId})`, { messageId: message.id });
        // One job per notification: every Gmail / S3 / DB / OCR line of it carries the same jobId.
        await runJob('pubsub-change', () => processGmailChanges(routes, data.historyId !== undefined ? String(data.historyId) : undefined), { historyId: data.historyId });
        message.ack();
      } catch (err) {
        logError(LOG_SOURCE.PUBSUB, 'handling a notification failed: not acknowledged, Pub/Sub sends it again', err, { messageId: message.id });
        message.nack();
      }
    });
  });
  // The client reconnects by itself; missed changes are caught up from Gmail history on the next notification / start.
  subscription.on('error', (err) => logError(LOG_SOURCE.PUBSUB, 'subscription error (the client reconnects by itself)', err, { subscription: subscriptionId }));

  log.info(LOG_SOURCE.PUBSUB, `listening on ${subscriptionId}`);
  return {
    stop: async () => {
      clearInterval(renewTimer);
      await subscription.close();
    },
  };
};
