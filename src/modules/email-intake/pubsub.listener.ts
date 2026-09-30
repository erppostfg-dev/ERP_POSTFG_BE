import { Message, PubSub, Subscription } from '@google-cloud/pubsub';
import { google } from 'googleapis';
import { env } from '../../config/env';
import { getAuthClient } from './gmail.client';
import { keepWatching, resolveRoutes } from './gmail-watch.service';
import { catchUpOnStart, processGmailChanges } from './label-router.service';

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
  if (!subscriptionId) throw new Error('PUBSUB_SUBSCRIPTION is required');

  const routes = await resolveRoutes();
  const renewTimer = await keepWatching(routes);

  const subscription: Subscription = pubsubClient().subscription(subscriptionId, {
    flowControl: { maxMessages: 1, allowExcessMessages: false },
  });

  // Startup catch-up first; notifications that arrive meanwhile wait behind it.
  let queue: Promise<void> = catchUpOnStart(routes).catch((err) =>
    console.error('[gmail] startup catch-up failed; the next notification retries it', err),
  );
  subscription.on('message', (message: Message) => {
    queue = queue.then(async () => {
      try {
        const data = JSON.parse(message.data.toString('utf8')) as { emailAddress?: string; historyId?: number | string };
        console.log(`[pubsub] ${data.emailAddress} changed (historyId ${data.historyId})`);
        await processGmailChanges(routes, data.historyId !== undefined ? String(data.historyId) : undefined);
        message.ack();
      } catch (err) {
        console.error('[pubsub] handling failed, will retry', err);
        message.nack();
      }
    });
  });
  subscription.on('error', (err) => console.error('[pubsub] subscription error', err));

  console.log(`[pubsub] listening on ${subscriptionId}`);
  return {
    stop: async () => {
      clearInterval(renewTimer);
      await subscription.close();
    },
  };
};
