import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { APP_STATE_KEY, ERROR_CODES, GMAIL_UNITS } from '../../constants';
import { AppState } from '../../entities';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { gmailCall } from './gmail-pace';
import { logError } from '../../utils/classify-error';
import { log } from '../../utils/logger';
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

const readFileState = async (): Promise<GmailState> => {
  try {
    return JSON.parse(await fs.readFile(statePath(), 'utf8')) as GmailState;
  } catch {
    return {};
  }
};

const writeFileState = async (next: GmailState): Promise<void> => {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  // Write a temp file and rename it, so a stop mid-write never leaves a broken state file.
  const tmp = `${statePath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, statePath());
};

/**
 * The Gmail sync point lives in the DB (app_state "gmail", 2026-10-23), so a deploy or a new server continues where
 * the old one stopped. The first time, the old storage/gmail-state.json is copied in (the file is then not used).
 * Without a DB, or before the LocalStorageDb migration, the file is used as before.
 */
const stateRepo = () => AppDataSource.getRepository(AppState);
const dbState = async (): Promise<AppState | null | 'no-db'> => {
  if (!AppDataSource.isInitialized) return 'no-db';
  return stateRepo().findOneBy({ key: APP_STATE_KEY.GMAIL }).catch((err: { code?: string }) => {
    if (err.code === 'ER_NO_SUCH_TABLE') return 'no-db' as const;
    throw err;
  });
};

export const readState = async (): Promise<GmailState> => {
  const row = await dbState();
  if (row === 'no-db') return readFileState();
  if (row) return row.value as GmailState;
  const fromFile = await readFileState();
  await stateRepo().save({ key: APP_STATE_KEY.GMAIL, value: fromFile as Record<string, unknown>, updatedAt: new Date() });
  return fromFile;
};

export const writeState = async (patch: GmailState): Promise<void> => {
  const next = { ...(await readState()), ...patch };
  if ((await dbState()) === 'no-db') return writeFileState(next);
  await stateRepo().save({ key: APP_STATE_KEY.GMAIL, value: next as Record<string, unknown>, updatedAt: new Date() });
};

/** Looks up the Gmail label id for every route. Fails if a label does not exist in the mailbox. */
export const resolveRoutes = async (): Promise<ResolvedRoute[]> => {
  const res = await gmailCall('labels.list', GMAIL_UNITS.LABELS_LIST, () => getGmail().users.labels.list({ userId: 'me' }));
  const byName = new Map((res.data.labels ?? []).map((l) => [(l.name ?? '').toLowerCase(), l.id ?? '']));

  return labelRoutes.map((route) => {
    const labelId = byName.get(route.label.toLowerCase());
    if (!labelId) {
      throw appError(ERROR_CODES.GMAIL_LABEL_NOT_FOUND, route.label, env.gmail.mailbox);
    }
    return { ...route, labelId };
  });
};

/** Tells Gmail to publish changes to these labels to the Pub/Sub topic. */
export const startWatch = async (routes: ResolvedRoute[]): Promise<void> => {
  const { projectId, topic } = env.pubsub;
  if (!projectId || !topic) throw appError(ERROR_CODES.GMAIL_WATCH_CONFIG_MISSING);

  const res = await gmailCall('watch', GMAIL_UNITS.WATCH, () => getGmail().users.watch({
    userId: 'me',
    requestBody: {
      topicName: `projects/${projectId}/topics/${topic}`,
      labelIds: [...new Set(routes.map((r) => r.labelId))],
      labelFilterBehavior: 'INCLUDE',
    },
  }), { fields: { topic } });

  const expiration = res.data.expiration ? new Date(Number(res.data.expiration)).toISOString() : undefined;
  const state = await readState();
  // First run: start from now. Later runs keep the stored id so emails that came in while we were down are caught up.
  await writeState({ historyId: state.historyId ?? res.data.historyId ?? undefined, watchExpiration: expiration });

  log.info(LOG_SOURCE.GMAIL,
    `watching ${env.gmail.mailbox} labels [${routes.map((r) => r.label).join(', ')}] -> ${topic} (until ${expiration})`,
  );
};

/** Starts the watch now and renews it every 24 hours. */
export const keepWatching = async (routes: ResolvedRoute[]): Promise<NodeJS.Timeout> => {
  await startWatch(routes);
  const timer = setInterval(() => {
    startWatch(routes).catch((err) => logError(LOG_SOURCE.GMAIL, 'watch renewal failed (retried in 24 h; the watch lasts 7 days)', err));
  }, RENEW_EVERY_MS);
  timer.unref();
  return timer;
};
