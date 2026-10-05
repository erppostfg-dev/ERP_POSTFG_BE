import { gmail_v1 } from 'googleapis';
import { env } from '../../config/env';
import { getGmail } from './gmail.client';
import { downloadAttachments, originalSender, readParts, toHeaderMap } from './gmail-message';
import { readState, ResolvedRoute, writeState } from './gmail-watch.service';

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
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded', 'labelAdded'],
      pageToken,
    });
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
    const res = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [labelId],
      q: after ? `after:${Math.floor(after.getTime() / 1000)}` : undefined,
      maxResults: 100,
      pageToken,
    });
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids.reverse();
};

const endpointUrl = (endpoint: string): string =>
  /^https?:\/\//.test(endpoint) ? endpoint : `${env.intake.baseUrl.replace(/\/$/, '')}${endpoint}`;

/**
 * Downloads one labelled email with all its attachments and POSTs it to the label's endpoint (multipart).
 * Returns false when the email no longer carries a routed label.
 */
export const forwardMessage = async (gmail: gmail_v1.Gmail, gmailId: string, routes: ResolvedRoute[]): Promise<boolean> => {
  const full = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
  const route = routes.find((r) => full.data.labelIds?.includes(r.labelId));
  if (!route) return false; // label removed again before we got to it

  const headers = toHeaderMap(full.data.payload?.headers ?? []);
  const subject = headers['subject'] ?? '';
  const { attachments, body } = readParts(full.data.payload);
  const files = await downloadAttachments(gmail, gmailId, attachments, ALL_FILES);
  const from = originalSender(headers);

  const form = new FormData();
  for (const f of files) form.append('files', new Blob([new Uint8Array(f.content)], { type: f.mimeType }), f.filename);
  form.append('label', route.label);
  form.append('messageId', headers['message-id'] ?? `gmail-${gmailId}`);
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) form.append('from', from);
  form.append('subject', subject);
  form.append('provider', 'gmail-pubsub');
  form.append('gmailId', gmailId);
  if (full.data.internalDate) form.append('receivedAt', new Date(Number(full.data.internalDate)).toISOString());
  if (body.text) form.append('bodyText', body.text);
  if (body.html) form.append('bodyHtml', body.html);

  const url = endpointUrl(route.endpoint);
  const res = await fetch(url, {
    method: 'POST',
    headers: env.intake.webhookSecret ? { 'X-Webhook-Secret': env.intake.webhookSecret } : {},
    body: form,
  });
  const text = await res.text();
  // 5xx: throw so the email is retried. 4xx will not get better on a retry: log it and move on.
  if (res.status >= 500) throw new Error(`POST ${url} -> ${res.status}: ${text}`);
  if (!res.ok) {
    console.error(`[route] "${subject}" rejected by ${url}: ${res.status} ${text}`);
    return true;
  }
  console.log(`[route] "${subject}" (${route.label}, ${files.length} file(s)) -> ${url}: ${res.status}`);
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
const forwardNew = async (gmail: gmail_v1.Gmail, ids: string[], routes: ResolvedRoute[]): Promise<number> => {
  const done = new Set((await readState()).forwardedIds ?? []);
  let sent = 0;

  for (const id of ids) {
    if (done.has(id)) continue;
    if (await forwardMessage(gmail, id, routes)) sent++;
    done.add(id);
    await rememberForwarded(id);
  }
  return sent;
};

/** Sends every email in the route's label (or only those after `after`) that was not sent before. */
const backfillLabel = async (gmail: gmail_v1.Gmail, route: ResolvedRoute, after?: Date): Promise<void> => {
  const ids = await labelMessageIds(gmail, route.labelId, after);
  const sent = await forwardNew(gmail, ids, [route]);
  console.log(
    `[backfill] ${route.label}: ${ids.length} email(s) in label${after ? ` since ${after.toISOString()}` : ''}, ${sent} newly sent`,
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
    console.warn(`[gmail] history ${startHistoryId} expired; searching labels for emails since ${since.toISOString()}`);
    const profile = await gmail.users.getProfile({ userId: 'me' });
    for (const route of routes) await backfillLabel(gmail, route, since);
    await writeState({ historyId: profile.data.historyId ?? notifiedHistoryId, lastSyncAt: new Date().toISOString() });
    return;
  }

  await forwardNew(gmail, changes.ids, routes);
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
    backfilled.add(route.label);
    await writeState({ backfilledLabels: [...backfilled], lastSyncAt: new Date().toISOString() });
  }

  await processGmailChanges(routes);

  if (lastSyncAt) {
    const since = new Date(new Date(lastSyncAt).getTime() - RESYNC_MARGIN_MS);
    for (const route of routes.filter((r) => !fresh.includes(r))) await backfillLabel(gmail, route, since);
  }
};
