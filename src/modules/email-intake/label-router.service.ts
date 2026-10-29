import { gmail_v1 } from 'googleapis';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { CATCHUP, ERROR_CODES, GMAIL_META_HEADERS, GMAIL_UNITS, PROVIDERS } from '../../constants';
import { GmailMessage } from '../../entities';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { logCall } from '../../utils/log-call';
import { log } from '../../utils/logger';
import { getGmail } from './gmail.client';
import { gmailCall } from './gmail-pace';
import { admitToOcr, pipelineFull } from '../po-pipeline/pipeline.service';
import { queueExtractPo } from '../ocr/extract-po.service';
import { downloadAttachments, EmailHeaders, originalSender, readParts, toHeaderMap } from './gmail-message';
import { readState, resolveRoutes, ResolvedRoute, writeState } from './gmail-watch.service';
import { detectChannel } from '../ocr/channel-detector';
import { IntakeGate, intakeGates } from '../po-intake-control/intake-settings.service';
import { alreadyStored } from './email-storage.service';

const ALL_FILES = /./;
/** Extra margin when searching by date after the history expired. */
const RESYNC_MARGIN_MS = 24 * 60 * 60 * 1000;

/*
 * Load (2026-10-29, constants/gmail-intake.ts): every Gmail call goes through gmailCall (one pace, retried on a rate
 * limit). Each email is read ONCE: what it is (channel, received, subject) goes to gmail_messages, so a catch-up picks
 * a channel's emails from there with no Gmail call; a catch-up reads only the headers of an email it may not take
 * (another channel's / OFF / before the start), Pub/Sub reads the whole email at once (it is usually taken). One DB
 * read per list of ids, one for the channel switches, one write per email only when its state changes.
 */

interface Seen {
  channel: string | null;
  receivedAt: Date | null;
  subject: string;
  messageId: string;
  done: boolean;
}

const messagesRepo = () => AppDataSource.getRepository(GmailMessage);

/** What we already know about these emails, in one query per 500 ids. */
const knownMessages = async (ids: string[]): Promise<Map<string, Seen>> => {
  const out = new Map<string, Seen>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await messagesRepo().find({ select: { gmailId: true, channel: true, receivedAt: true, subject: true, doneAt: true }, where: { gmailId: In(ids.slice(i, i + 500)) } });
    for (const r of rows) out.set(r.gmailId, { channel: r.channel, receivedAt: r.receivedAt, subject: r.subject, messageId: '', done: r.doneAt !== null });
  }
  return out;
};

const remember = (gmailId: string, s: Omit<Seen, 'done' | 'messageId'>, done: boolean) =>
  messagesRepo().upsert({ gmailId, channel: s.channel, receivedAt: s.receivedAt, subject: s.subject.slice(0, CATCHUP.SUBJECT_MAX), doneAt: done ? new Date() : null }, ['gmailId']);

/** Channel, received time, subject, Message-ID from an email's headers (metadata or full). */
const seenOf = (msg: gmail_v1.Schema$Message): Seen => {
  const headers = toHeaderMap(msg.payload?.headers ?? []);
  const subject = headers['subject'] ?? '';
  const detected = detectChannel({ from: originalSender(headers), subject });
  return {
    channel: 'config' in detected ? detected.config.channel : null,
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)) : null,
    subject,
    messageId: headers['message-id'] ?? '',
    done: false,
  };
};

const getMessage = (gmail: gmail_v1.Gmail, gmailId: string, format: 'full' | 'metadata') =>
  gmailCall('messages.get', GMAIL_UNITS.MESSAGES_GET, () => gmail.users.messages.get({
    userId: 'me', id: gmailId, format, ...(format === 'metadata' ? { metadataHeaders: [...GMAIL_META_HEADERS] } : {}),
  }), { key: `${gmailId}:${format}`, fields: { gmailId, format } });

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
    const res = await gmailCall('history.list', GMAIL_UNITS.HISTORY_LIST, () => gmail.users.history.list({
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
    const res = await gmailCall('messages.list', GMAIL_UNITS.MESSAGES_LIST, () => gmail.users.messages.list({
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
 * One labelled email: when it may be taken, downloaded with all its attachments and POSTed to the label's endpoint
 * (multipart). 'gone' = no longer carries a routed label; 'later' = not taken now and left in Gmail: its channel is OFF
 * or it came before the channel's start (PO intake, 2026-10-23), or a catch-up for other channels (`only`); a switch
 * on / an earlier start takes it then. 'stored' = POST_FG has it already (not downloaded again); 'sent' = sent now.
 * `known` = what gmail_messages says (no Gmail call is needed to decide 'later'). The outcome is written there.
 */
type Outcome = 'sent' | 'stored' | 'later' | 'gone';
interface PassContext { gate: IntakeGate; only?: Set<string>; known?: Seen }

export const forwardMessage = async (gmail: gmail_v1.Gmail, gmailId: string, routes: ResolvedRoute[], ctx: PassContext): Promise<{ outcome: Outcome; channel: string | null }> => {
  let seen = ctx.known;
  let full: gmail_v1.Schema$Message | undefined;
  // a known email: the pass's route (one label per pass); read now: its own label's
  let route = routes[0];
  if (!seen) {
    // a catch-up looks at the headers first (most emails are other channels'); Pub/Sub takes the whole email at once
    const msg = (await getMessage(gmail, gmailId, ctx.only ? 'metadata' : 'full')).data;
    seen = seenOf(msg);
    const labelled = routes.find((r) => msg.labelIds?.includes(r.labelId));
    if (labelled) route = labelled;
    else {
      await remember(gmailId, seen, true);
      return { outcome: 'gone', channel: seen.channel }; // label removed again before we got to it
    }
    if (!ctx.only) full = msg;
  }
  const { channel, subject } = seen;
  const leave = async (why?: string) => {
    if (why) log.info(LOG_SOURCE.APP, `[route] "${subject}": ${channel} ${why}: left in Gmail`, { gmailId });
    if (!ctx.known) await remember(gmailId, seen, false);
    return { outcome: 'later' as const, channel };
  };
  if (ctx.only && !(channel && ctx.only.has(channel))) return leave();
  if (channel) {
    const gate = ctx.gate(channel, seen.receivedAt);
    if (gate !== 'take') return leave(gate === 'off' ? 'is OFF' : 'start is later');
  }

  // Already in POST_FG: on the disk, or remembered in the DB after its local copy was removed (2026-10-23).
  if (seen.messageId) {
    const stored = await alreadyStored(route.label, seen.messageId || `gmail-${gmailId}`);
    if (stored) {
      // On the disk from an earlier run but never in the chain: in now (start / duplicate / switch / limit checks).
      if (stored.folder && (await admitToOcr(stored.folder)) && env.ocr.enabled) queueExtractPo(stored.folder);
      await remember(gmailId, seen, true);
      return { outcome: 'stored', channel };
    }
  }
  const msg = full ?? (await getMessage(gmail, gmailId, 'full')).data;
  const fullRoute = routes.find((r) => msg.labelIds?.includes(r.labelId));
  if (!fullRoute) {
    await remember(gmailId, seen, true);
    return { outcome: 'gone', channel };
  }
  const headers = toHeaderMap(msg.payload?.headers ?? []);
  if (!seen.messageId) {
    const stored = await alreadyStored(fullRoute.label, headers['message-id'] ?? `gmail-${gmailId}`);
    if (stored) {
      if (stored.folder && (await admitToOcr(stored.folder)) && env.ocr.enabled) queueExtractPo(stored.folder);
      await remember(gmailId, seen, true);
      return { outcome: 'stored', channel };
    }
  }
  await postToIntake(gmail, gmailId, msg, fullRoute, headers);
  await remember(gmailId, seen, true);
  return { outcome: 'sent', channel };
};

/** Downloads the attachments and POSTs the email to the route's endpoint; a 5xx throws (retried later). */
const postToIntake = async (gmail: gmail_v1.Gmail, gmailId: string, full: gmail_v1.Schema$Message, route: ResolvedRoute, headers: EmailHeaders): Promise<void> => {
  const subject = headers['subject'] ?? '';
  const { attachments, body } = readParts(full.payload);
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
  if (full.internalDate) form.append('receivedAt', new Date(Number(full.internalDate)).toISOString());
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
    return;
  }
  log.info(LOG_SOURCE.APP, `[route] "${subject}" (${route.label}, ${files.length} file(s)) -> ${url}: ${res.status}`, { gmailId });
};

/** Per channel: its emails looked at in this pass and how many were newly sent. */
export type PassCounts = Map<string, { found: number; sent: number }>;

/**
 * Sends each email not done before; its outcome is saved right after, so a stop in the middle loses nothing.
 * Stops at the first error (the rest is retried later). `only` = a catch-up of these channels.
 * Done = gmail_messages.done_at, or the old app_state forwardedIds list (read once, no longer written).
 */
const sendAll = async (gmail: gmail_v1.Gmail, ids: string[], routes: ResolvedRoute[], only?: Set<string>): Promise<PassCounts> => {
  const counts: PassCounts = new Map();
  if (!ids.length) return counts;
  const legacyDone = new Set((await readState()).forwardedIds ?? []);
  const [known, gate] = await Promise.all([knownMessages(ids), intakeGates()]);
  const todo = ids.filter((id) => !legacyDone.has(id) && !known.get(id)?.done);

  for (const [i, id] of todo.entries()) {
    // PIPELINE_LIMIT reached: stop here, nothing more is downloaded or stored; the rest stay unsent for the next start.
    if (pipelineFull()) {
      log.warn(LOG_SOURCE.APP, `[route] PIPELINE_LIMIT ${env.pipeline.limit} reached: intake stopped, ${todo.length - i} email(s) left in Gmail for the next start`);
      break;
    }
    const { outcome, channel } = await forwardMessage(gmail, id, routes, { gate, only, known: known.get(id) });
    if (channel && (!only || only.has(channel))) {
      const c = counts.get(channel) ?? { found: 0, sent: 0 };
      if (outcome !== 'gone') c.found++;
      if (outcome === 'sent') c.sent++;
      counts.set(channel, c);
    }
  }
  return counts;
};

const total = (counts: PassCounts) => [...counts.values()].reduce((n, c) => n + c.sent, 0);

/**
 * Catch-up of SEVERAL channels in one pass (catchup.service, 2026-10-29): each label listed once from the earliest
 * start, each email looked at once for all of them; emails already known need no Gmail call. Per-channel counts.
 */
export const catchUpChannels = async (froms: Map<string, Date>): Promise<PassCounts> => {
  const gmail = getGmail();
  const after = new Date(Math.min(...[...froms.values()].map((d) => d.getTime())));
  const out: PassCounts = new Map();
  for (const route of await resolveRoutes()) {
    for (const [channel, c] of await backfillLabel(gmail, route, after, new Set(froms.keys()))) {
      const o = out.get(channel) ?? { found: 0, sent: 0 };
      out.set(channel, { found: o.found + c.found, sent: o.sent + c.sent });
    }
  }
  return out;
};

/** Sends every email in the route's label (or only those after `after`; only these channels') not sent before. */
const backfillLabel = async (gmail: gmail_v1.Gmail, route: ResolvedRoute, after?: Date, only?: Set<string>): Promise<PassCounts> => {
  const ids = await labelMessageIds(gmail, route.labelId, after);
  const counts = await sendAll(gmail, ids, [route], only);
  log.info(LOG_SOURCE.GMAIL,
    `[backfill] ${route.label}${only ? ` (${[...only].join(', ')})` : ''}: ${ids.length} email(s) in label${after ? ` since ${after.toISOString()}` : ''}, ${total(counts)} newly sent`,
  );
  return counts;
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
    const profile = await gmailCall('getProfile', GMAIL_UNITS.GET_PROFILE, () => gmail.users.getProfile({ userId: 'me' }));
    for (const route of routes) await backfillLabel(gmail, route, since);
    if (pipelineFull()) return; // intake stopped: keep the old sync point (see below)
    await writeState({ historyId: profile.data.historyId ?? notifiedHistoryId, lastSyncAt: new Date().toISOString() });
    return;
  }

  await sendAll(gmail, changes.ids, routes);
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
