import { gmail_v1 } from 'googleapis';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import { env } from '../../config/env';
import { APPOINTMENT_CHANNELS, APPOINTMENT_FIRST_CHANNELS, APPOINTMENTS, GMAIL_UNITS } from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { AppState, PoAppointmentEmail } from '../../entities';
import { logError } from '../../utils/classify-error';
import { inBackground } from '../../utils/log-context';
import { log } from '../../utils/logger';
import { getGmail } from '../email-intake/gmail.client';
import { readParts } from '../email-intake/gmail-message';
import { gmailCall } from '../email-intake/gmail-pace';
import { announce, applyWaiting, InboundAppointmentEmail, ingestAppointmentEmail } from './appointment.service';

/*
 * Reads the Gmail label "Appointment Date" (2026-11-16, constants/appointments.ts). Its own timer, NOT the PO intake
 * (no Pub/Sub route, no channel switches, no OCR): every POLL_MINUTES it lists the label's emails of the last
 * POLL_LOOKBACK_DAYS, reads only the ones not stored yet (po_appointment_emails.gmail_id), oldest first, and applies
 * them; then the emails waiting for their PO are tried again. The first run on a database also reads the last
 * BACKFILL_DAYS through the two Gmail filters' own searches (the older emails never got the label).
 * Self-healing: a failed run changes nothing that is not saved per email; the next run picks up from Gmail again.
 * Off on a laptop (APPOINTMENT_EMAILS_ENABLED=false in laptop mode: the dev EC2 owns the shared database).
 */

const stateRepo = () => AppDataSource.getRepository(AppState);
const day = (d: number) => `newer_than:${d}d`;

const listIds = async (gmail: gmail_v1.Gmail, q: string): Promise<string[]> => {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = pageToken;
    const res = await gmailCall('messages.list', GMAIL_UNITS.MESSAGES_LIST, () => gmail.users.messages.list({ userId: 'me', q, maxResults: 500, pageToken: page }), { fields: { q } });
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
};

const readEmail = async (gmail: gmail_v1.Gmail, gmailId: string): Promise<InboundAppointmentEmail> => {
  const msg = (await gmailCall('messages.get', GMAIL_UNITS.MESSAGES_GET, () => gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' }), { fields: { gmailId } })).data;
  const subject = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '';
  const { body } = readParts(msg.payload);
  return { gmailId, subject, receivedAt: new Date(Number(msg.internalDate ?? Date.now())), text: body.text, html: body.html };
};

let running = false;

/** One run: new emails in, waiting ones retried. Returns counts (also for the logs). */
export const readAppointmentEmails = async (): Promise<{ read: number; applied: number; waiting: number; older: number; unreadable: number; retried: number }> => {
  const counts = { read: 0, applied: 0, waiting: 0, older: 0, unreadable: 0, retried: 0 };
  if (running) return counts;
  running = true;
  try {
    const gmail = getGmail();
    const state = (await stateRepo().findOneBy({ key: APPOINTMENTS.STATE_KEY }))?.value ?? {};
    // channels whose last BACKFILL_DAYS were read once (the first run of 2026-11-16 = Scootsy + Zepto; Blinkit added later)
    const done = new Set<string>(Array.isArray(state.backfilledChannels) ? (state.backfilledChannels as string[]) : state.backfilledAt ? APPOINTMENT_FIRST_CHANNELS : []);
    const todo = Object.keys(APPOINTMENT_CHANNELS).filter((c) => !done.has(c)) as (keyof typeof APPOINTMENT_CHANNELS)[];
    const backfill = todo.length > 0;
    const label = `label:"${APPOINTMENTS.LABEL}"`;
    const queries = [
      `${label} ${day(backfill ? APPOINTMENTS.BACKFILL_DAYS : APPOINTMENTS.POLL_LOOKBACK_DAYS)}`,
      ...todo.map((c) => `${APPOINTMENT_CHANNELS[c].search} ${day(APPOINTMENTS.BACKFILL_DAYS)}`),
    ];
    const ids = [...new Set((await Promise.all(queries.map((q) => listIds(gmail, q)))).flat())];

    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await AppDataSource.getRepository(PoAppointmentEmail).find({ select: { gmailId: true }, where: { gmailId: In(ids.slice(i, i + 500)) } });
      rows.forEach((r) => known.add(r.gmailId));
    }
    const fresh: InboundAppointmentEmail[] = [];
    for (const id of ids.filter((x) => !known.has(x))) fresh.push(await readEmail(gmail, id));
    // oldest first: a later email wins over an earlier one
    fresh.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    for (const e of fresh) {
      const outcome = await ingestAppointmentEmail(e);
      if (outcome === 'known') continue;
      counts.read++;
      counts[outcome]++;
    }
    counts.retried = await applyWaiting();
    if (counts.applied || counts.retried) await announce();

    await stateRepo().save({
      key: APPOINTMENTS.STATE_KEY,
      value: { ...state, ...(backfill ? { backfilledAt: new Date().toISOString(), backfilledChannels: [...done, ...todo] } : {}), lastRunAt: new Date().toISOString(), lastCounts: counts },
      updatedAt: new Date(),
    });
    if (counts.read || counts.retried) {
      log.info(LOG_SOURCE.APP, `[appointments] ${backfill ? `first run for ${todo.join(', ')} (last ${APPOINTMENTS.BACKFILL_DAYS} days)` : 'run'}: ${counts.read} new email(s): ${counts.applied} applied, ${counts.waiting} waiting for their PO, ${counts.older} older than the PO's last change, ${counts.unreadable} unreadable; ${counts.retried} waiting one(s) applied`, counts);
    }
    return counts;
  } finally {
    running = false;
  }
};

/** The timer (server.ts). First run a minute after the start, then every POLL_MINUTES. */
export const startAppointmentReader = (): { stop: () => void } | undefined => {
  if (!env.appointments.enabled) {
    log.info(LOG_SOURCE.APP, '[appointments] email reader off (APPOINTMENT_EMAILS_ENABLED=false)');
    return undefined;
  }
  const run = () => void inBackground('appointment-emails', () => readAppointmentEmails())
    .catch((err) => logError(LOG_SOURCE.GMAIL, '[appointments] run failed (tried again on the next run)', err));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, APPOINTMENTS.POLL_MINUTES * 60_000);
  first.unref();
  timer.unref();
  log.info(LOG_SOURCE.APP, `[appointments] email reader on: label "${APPOINTMENTS.LABEL}" every ${APPOINTMENTS.POLL_MINUTES} min`);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
};
