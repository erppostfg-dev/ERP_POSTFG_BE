import { gmail_v1 } from 'googleapis';
import { env } from '../../config/env';
import { ERROR_CODES, PROVIDERS } from '../../constants';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { logCall } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { getGmail } from './gmail.client';
import { admitToOcr, pipelineFull } from '../po-pipeline/pipeline.service';
import { queueExtractPo } from '../ocr/extract-po.service';
import { downloadAttachments, originalSender, readParts, toHeaderMap } from './gmail-message';
import { readState, resolveRoutes, ResolvedRoute, writeState } from './gmail-watch.service';
import { detectChannel } from '../ocr/channel-detector';
import { intakeGate } from '../po-intake-control/intake-settings.service';
import { alreadyStored } from './email-storage.service';

const ALL_FILES = /./;
const MAX_FORWARDED_IDS = 5000;
/** Extra margin when searching by date after the history expired. */
const RESYNC_MARGIN_MS = 24 * 60 * 60 * 1000;

/** New message ids (since the stored historyId) that carry one of the routed labels. */
const newLabelledMessages = async (
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
  labelIds: Set<string>,
): Promise<{ ids: string[]; latestHistoryId: string }> => {
  const ids = new Set<string>();
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  do {
    const page = pageToken;
    // NOT_FOUND = the history id is too old: expected, the caller then searches the labels instead.
    const res = await logCall(LOG_SOURCE.GMAIL, 'history.list', () => gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded', 'labelAdded'],
      pageToken: page,
    }), { fields: { startHistoryId }, expected: ['NOT_FOUND'] });
    for (const h of res.data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id && m.message.labelIds?.some((l) => labelIds.has(l))) ids.add(m.message.id);
      }
      for (const m of h.labelsAdded ?? []) {
        if (m.message?.id && m.labelIds?.some((l) => labelIds.has(l))) ids.add(m.message.id);
      }
    }
    latestHistoryId = res.data.historyId ?? latestHistoryId;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { ids: [...ids], latestHistoryId };
};

/** Every email id in a label, oldest first; `after` limits it to emails received after that time. */
const labelMessageIds = async (gmail: gmail_v1.Gmail, labelId: string, after?: Date): Promise<string[]> => {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = pageToken;
    const res = await logCall(LOG_SOURCE.GMAIL, 'messages.list', () => gmail.users.messages.list({
      userId: 'me',
      labelIds: [labelId],
      q: after ? `after:${Math.floor(after.getTime() / 1000)}` : undefined,
      maxResults: 100,
      pageToken: page,
    }), { fields: { labelId } });
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids.reverse();
};

const endpointUrl = (endpoint: string): string =>
  /^https?:\/\//.test(endpoint) ? endpoint : `${env.intake.baseUrl.replace(/\/$/, '')}${endpoint}`;

/**
 * Downloads one labelled email with all its attachments and POSTs it to the label's endpoint (multipart).
 * Returns false when the email no longer carries a routed label, and "later" when its channel is OFF or it came before
 * the channel's start (PO intake, 2026-10-23): it stays in Gmail, not downloaded and not marked done, so switching the
 * channel on (or an earlier start) takes it then. `only` = a one-channel catch-up: other channels' emails are left
 * for their own. An email already stored is not downloaded again (true).
 */
export const forwardMessage = async (gmail: gmail_v1.Gmail, gmailId: string, routes: ResolvedRoute[], only?: string): Promise<boolean | 'later'> => {
  const full = await logCall(LOG_SOURCE.GMAIL, 'messages.get', () => gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' }), { key: gmailId, fields: { gmailId } });
  const route = routes.find((r) => full.data.labelIds?.includes(r.labelId));
  if (!route) return false; // label removed again before we got to it

  const headers = toHeaderMap(full.data.payload?.headers ?? []);
  const subject = headers['subject'] ?? '';
  const receivedAt = full.data.internalDate ? new Date(Number(full.data.internalDate)) : null;
  const detected = detectChannel({ from: originalSender(headers), subject });
  const channel = 'config' in detected ? detected.config.channel : null;
  if (only && channel !== only) return 'later';
  if (channel) {
    const gate = await intakeGate(channel, receivedAt);
    if (gate !== 'take') {
      log.info(LOG_SOURCE.APP, `[route] "${subject}": ${channel} ${gate === 'off' ? 'is OFF' : 'start is later'}: left in Gmail`, { gmailId });
      return 'later';
    }
  }
  // Already in POST_FG: on the disk, or remembered in the DB after its local copy was removed (2026-10-23).
  const stored = await alreadyStored(route.label, headers['message-id'] ?? `gmail-${gmailId}`);
  if (stored) {
    // On the disk from an earlier run but never in the chain: in now (start / duplicate / switch / limit checks).
    if (stored.folder && (await admitToOcr(stored.folder)) && env.ocr.enabled) queueExtractPo(stored.folder);
    return true;
  }
  const { attachments, body } = readParts(full.data.payload);
  const files = await downloadAttachments(gmail, gmailId, attachments, ALL_FILES);
  const from = originalSender(headers);

  const form = new FormData();
  for (const f of files) form.append('files', new Blob([new Uint8Array(f.content)], { type: f.mimeType }), f.filename);
  form.append('label', route.label);
  form.append('messageId', headers['message-id'] ?? `gmail-${gmailId}`);
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) form.append('from', from);
  form.append('subject', subject);
  form.append('provider', PROVIDERS.GMAIL_PUBSUB);
  form.append('gmailId', gmailId);
  if (full.data.internalDate) form.append('receivedAt', new Date(Number(full.data.internalDate)).toISOString());
  if (body.text) form.append('bodyText', body.text);
  if (body.html) form.append('bodyHtml', body.html);

  const url = endpointUrl(route.endpoint);
  // Our own intake endpoint (HTTP_*): a failure here is on our side (see its API_SERVER_ERROR line).
  const res = await logCall(LOG_SOURCE.HTTP, 'intake POST', () => fetch(url, {
    method: 'POST',
    headers: env.intake.webhookSecret ? { 'X-Webhook-Secret': env.intake.webhookSecret } : {},
    body: form,
  }), { fields: { url, gmailId }, failedStatus: (r) => ((r as Response).ok ? undefined : (r as Response).status) });
  const text = await res.text();
  // 5xx: throw so the email is retried. 4xx will not get better on a retry: log it and move on.
  if (res.status >= 500) throw appError(ERROR_CODES.ROUTE_FORWARD_FAILED, url, res.status, text);
  if (!res.ok) {
    log.error(LOG_SOURCE.APP, `[route] "${subject}" rejected by the intake (not retried)`, { url, status: res.status, answer: text, gmailId });
    return true;
  }
  log.info(LOG_SOURCE.APP, `[route] "${subject}" (${route.label}, ${files.length} file(s)) -> ${url}: ${res.status}`, { gmailId });
  return true;
};

/** Adds one id to the stored list, re-reading the state so ids saved by a parallel run are kept. */
const rememberForwarded = async (id: string): Promise<void> => {
  const forwarded = (await readState()).forwardedIds ?? [];
  if (!forwarded.includes(id)) await writeState({ forwardedIds: [...forwarded, id].slice(-MAX_FORWARDED_IDS) });
};

/**
 * Sends each id not sent before, and saves it right after it is sent, so a stop in the middle loses nothing.
 * Stops at the first error (the rest is retried later).
 */
const forwardNew = async (gmail: gmail_v1.Gmail, ids: string[], routes: ResolvedRoute[], only?: string): Promise<number> => {
  const done = new Set((await readState()).forwardedIds ?? []);
  let sent = 0;

  for (const id of ids) {
    if (done.has(id)) continue;
    // PIPELINE_LIMIT reached: stop here, nothing more is downloaded or stored; the rest stay unsent for the next start.
    if (pipelineFull()) {
      log.warn(LOG_SOURCE.APP, `[route] PIPELINE_LIMIT ${env.pipeline.limit} reached: intake stopped, ${ids.filter((i) => !done.has(i)).length} email(s) left in Gmail for the next start`);
      break;
    }
    const r = await forwardMessage(gmail, id, routes, only);
    if (r === 'later') continue; // channel OFF / before its start: not marked done, switching on takes it
    if (r) sent++;
    done.add(id);
    await rememberForwarded(id);
  }
  return sent;
};

/**
 * One-time catch-up for ONE channel (PO intake, 2026-10-23): switched on, or its start moved earlier -> its labelled
 * emails from `after` until now that POST_FG does not have yet. Other channels are not touched. Runs one after
 * another (a second channel switched on meanwhile waits its turn, never dropped).
 */
let backfillQueue: Promise<void> = Promise.resolve();
export const backfillSince = (after: Date, channel: string): Promise<void> => {
  const run = backfillQueue.then(async () => {
    const gmail = getGmail();
    for (const route of await resolveRoutes()) await backfillLabel(gmail, route, after, channel);
  });
  backfillQueue = run.catch(() => undefined);
  return run;
};

/** Sends every email in the route's label (or only those after `after`; only one channel's) that was not sent before. */
const backfillLabel = async (gmail: gmail_v1.Gmail, route: ResolvedRoute, after?: Date, only?: string): Promise<void> => {
  const ids = await labelMessageIds(gmail, route.labelId, after);
  const sent = await forwardNew(gmail, ids, [route], only);
  log.info(LOG_SOURCE.GMAIL,
    `[backfill] ${route.label}${only ? ` (${only})` : ''}: ${ids.length} email(s) in label${after ? ` since ${after.toISOString()}` : ''}, ${sent} newly sent`,
  );
};

/**
 * Reads Gmail history since the stored id and sends every newly labelled email to its route,
 * then stores the new history id. Used for each Pub/Sub notification and at startup.
 * If the stored id is too old (Gmail keeps about a week), it falls back to a label search since
 * the last sync, so nothing is skipped.
 */
export const processGmailChanges = async (routes: ResolvedRoute[], notifiedHistoryId?: string): Promise<void> => {
  const gmail = getGmail();
  const state = await readState();
  const startHistoryId = state.historyId ?? notifiedHistoryId;
  if (!startHistoryId) return;

  let changes: { ids: string[]; latestHistoryId: string };
  try {
    changes = await newLabelledMessages(gmail, startHistoryId, new Set(routes.map((r) => r.labelId)));
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;

    const since = new Date(new Date(state.lastSyncAt ?? 0).getTime() - RESYNC_MARGIN_MS);
    log.warn(LOG_SOURCE.GMAIL, `history ${startHistoryId} expired; searching labels for emails since ${since.toISOString()}`);
    const profile = await logCall(LOG_SOURCE.GMAIL, 'getProfile', () => gmail.users.getProfile({ userId: 'me' }));
    for (const route of routes) await backfillLabel(gmail, route, since);
    if (pipelineFull()) return; // intake stopped: keep the old sync point (see below)
    await writeState({ historyId: profile.data.historyId ?? notifiedHistoryId, lastSyncAt: new Date().toISOString() });
    return;
  }

  await forwardNew(gmail, changes.ids, routes);
  // Intake stopped at PIPELINE_LIMIT: keep the old sync point, so the next start still finds the unsent emails.
  if (pipelineFull()) return;
  await writeState({ historyId: changes.latestHistoryId, lastSyncAt: new Date().toISOString() });
};

/**
 * Runs once when the listener starts:
 *  1. a label seen for the first time: send every email already in it (one-time backfill);
 *  2. catch up through Gmail history on everything that changed while the server was off;
 *  3. safety net: also list each label's emails since the last sync and send any not sent yet
 *     (ids only; already-sent emails are skipped before download), in case the history was incomplete.
 */
export const catchUpOnStart = async (routes: ResolvedRoute[]): Promise<void> => {
  const gmail = getGmail();
  const state = await readState();
  const lastSyncAt = state.lastSyncAt;
  const backfilled = new Set(state.backfilledLabels ?? []);
  const fresh = routes.filter((r) => !backfilled.has(r.label));

  for (const route of fresh) {
    await backfillLabel(gmail, route);
    if (pipelineFull()) return; // intake stopped mid-backfill: the label is backfilled again on the next start
    backfilled.add(route.label);
    await writeState({ backfilledLabels: [...backfilled], lastSyncAt: new Date().toISOString() });
  }

  await processGmailChanges(routes);

  if (lastSyncAt) {
    const since = new Date(new Date(lastSyncAt).getTime() - RESYNC_MARGIN_MS);
    for (const route of routes.filter((r) => !fresh.includes(r))) await backfillLabel(gmail, route, since);
  }
};
