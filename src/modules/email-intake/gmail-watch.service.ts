import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { getGmail } from './gmail.client';
import { LabelRoute, labelRoutes } from './label-routes';

export interface ResolvedRoute extends LabelRoute {
  labelId: string;
}

export interface GmailState {
  /** Last Gmail historyId we fully processed. */
  historyId?: string;
  watchExpiration?: string;
  /** When the last sync (history or backfill) finished; the fallback start point if history is gone. */
  lastSyncAt?: string;
  /** Labels whose existing emails were already backfilled once. */
  backfilledLabels?: string[];
  /** Gmail ids already sent to an endpoint (newest last, capped), so nothing is downloaded twice. */
  forwardedIds?: string[];
}

const RENEW_EVERY_MS = 24 * 60 * 60 * 1000; // the watch lasts 7 days; renew daily

const statePath = (): string => path.resolve(env.storage.gmailStateFile);

export const readState = async (): Promise<GmailState> => {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8')) as GmailState;
  } catch {
    return {};
  }
};

export const writeState = async (patch: GmailState): Promise<void> => {
  const next = { ...(await readState()), ...patch };
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(next, null, 2), 'utf8');
};

/** Looks up the Gmail label id for every route. Fails if a label does not exist in the mailbox. */
export const resolveRoutes = async (): Promise<ResolvedRoute[]> => {
  const res = await getGmail().users.labels.list({ userId: 'me' });
  const byName = new Map((res.data.labels ?? []).map((l) => [(l.name ?? '').toLowerCase(), l.id ?? '']));

  return labelRoutes.map((route) => {
    const labelId = byName.get(route.label.toLowerCase());
    if (!labelId) {
      throw new Error(`Gmail label "${route.label}" not found in ${env.gmail.mailbox}. Create it or fix label-routes.ts.`);
    }
    return { ...route, labelId };
  });
};

/** Tells Gmail to publish changes to these labels to the Pub/Sub topic. */
export const startWatch = async (routes: ResolvedRoute[]): Promise<void> => {
  const { projectId, topic } = env.pubsub;
  if (!projectId || !topic) throw new Error('GCP_PROJECT_ID and PUBSUB_TOPIC are required for the Gmail watch');

  const res = await getGmail().users.watch({
    userId: 'me',
    requestBody: {
      topicName: `projects/${projectId}/topics/${topic}`,
      labelIds: [...new Set(routes.map((r) => r.labelId))],
      labelFilterBehavior: 'INCLUDE',
    },
  });

  const expiration = res.data.expiration ? new Date(Number(res.data.expiration)).toISOString() : undefined;
  const state = await readState();
  // First run: start from now. Later runs keep the stored id so emails that came in while we were down are caught up.
  await writeState({ historyId: state.historyId ?? res.data.historyId ?? undefined, watchExpiration: expiration });

  console.log(
    `[gmail] watching ${env.gmail.mailbox} labels [${routes.map((r) => r.label).join(', ')}] -> ${topic} (until ${expiration})`,
  );
};

/** Starts the watch now and renews it every 24 hours. */
export const keepWatching = async (routes: ResolvedRoute[]): Promise<NodeJS.Timeout> => {
  await startWatch(routes);
  const timer = setInterval(() => {
    startWatch(routes).catch((err) => console.error('[gmail] watch renewal failed', err));
  }, RENEW_EVERY_MS);
  timer.unref();
  return timer;
};
