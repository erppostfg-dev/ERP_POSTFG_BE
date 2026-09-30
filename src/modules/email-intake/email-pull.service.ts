import fs from 'fs/promises';
import path from 'path';
import { gmail_v1 } from 'googleapis';
import { env } from '../../config/env';
import { ChannelEmailFilter, EmailHeaders } from './channel-filters/channel-filter.types';
import { getGmail } from './gmail.client';

const METADATA_HEADERS = ['From', 'Reply-To', 'X-Original-Sender', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'List-Id'];

export interface PullOptions {
  /** Pull only the email with this exact subject. */
  subject?: string;
  /** Only emails newer than this many days. */
  newerThanDays?: number;
  /** Stop after this many Gmail search results. */
  maxResults?: number;
}

export type PullStatus = 'saved' | 'already_saved' | 'ignored' | 'missing_required_attachment';

export interface PulledEmail {
  gmailId: string;
  subject: string;
  status: PullStatus;
  reason?: string;
  poNumber?: string;
  folder?: string;
  files?: string[];
}

interface Attachment {
  filename: string;
  mimeType: string;
  attachmentId?: string;
  data?: string;
}

const toHeaderMap = (headers: gmail_v1.Schema$MessagePartHeader[] = []): EmailHeaders => {
  const map: EmailHeaders = {};
  for (const h of headers) {
    if (h.name && h.value !== undefined && h.value !== null) map[h.name.toLowerCase()] = h.value;
  }
  return map;
};

const decodeBase64Url = (data: string): Buffer => Buffer.from(data, 'base64url');

interface Body {
  text: string[];
  html: string[];
}

/** Walks the MIME tree for attachments and the text / HTML body. */
const walkParts = (part: gmail_v1.Schema$MessagePart | undefined, attachments: Attachment[], body: Body): void => {
  if (!part) return;
  if (part.filename) {
    attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      attachmentId: part.body?.attachmentId ?? undefined,
      data: part.body?.data ?? undefined,
    });
  } else if (part.mimeType === 'text/plain' && part.body?.data) {
    body.text.push(decodeBase64Url(part.body.data).toString('utf8'));
  } else if (part.mimeType === 'text/html' && part.body?.data) {
    body.html.push(decodeBase64Url(part.body.data).toString('utf8'));
  }
  part.parts?.forEach((p) => walkParts(p, attachments, body));
};

/** Plain text from an HTML-only email (e.g. Zepto), keeping line breaks. */
const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const safeName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

const buildQuery = (filter: ChannelEmailFilter, opts: PullOptions): string => {
  const parts = [filter.gmailQuery];
  if (opts.subject) parts.push(`subject:"${opts.subject.replace(/"/g, '')}"`);
  if (opts.newerThanDays) parts.push(`newer_than:${opts.newerThanDays}d`);
  return parts.join(' ');
};

const listMessageIds = async (gmail: gmail_v1.Gmail, q: string, max: number): Promise<string[]> => {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(100, max - ids.length),
      pageToken,
    });
    res.data.messages?.forEach((m) => m.id && ids.push(m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  return ids;
};

const saveEmail = async (
  gmail: gmail_v1.Gmail,
  filter: ChannelEmailFilter,
  gmailId: string,
  headers: EmailHeaders,
  poNumber: string,
): Promise<PulledEmail> => {
  const subject = headers['subject'] ?? '';
  const folder = path.resolve(env.storage.emailDir, filter.channel.toLowerCase(), `${safeName(poNumber)}_${gmailId}`);

  if (await exists(path.join(folder, 'metadata.json'))) {
    return { gmailId, subject, poNumber, folder, status: 'already_saved' };
  }

  const full = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
  const attachments: Attachment[] = [];
  const body: Body = { text: [], html: [] };
  walkParts(full.data.payload, attachments, body);

  const kept = attachments.filter((a) => filter.attachments.keep.test(a.filename));
  const missing = filter.attachments.required.filter((re) => !kept.some((a) => re.test(a.filename)));

  await fs.mkdir(folder, { recursive: true });
  const files: string[] = [];
  for (const a of kept) {
    let data = a.data;
    if (!data && a.attachmentId) {
      const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: gmailId, id: a.attachmentId });
      data = res.data.data ?? undefined;
    }
    if (!data) continue;
    const fileName = safeName(a.filename);
    await fs.writeFile(path.join(folder, fileName), decodeBase64Url(data));
    files.push(fileName);
  }

  const html = body.html.join('\n');
  const text = body.text.length ? body.text.join('\n') : htmlToText(html);
  await fs.writeFile(path.join(folder, 'body.txt'), text, 'utf8');
  if (html) await fs.writeFile(path.join(folder, 'body.html'), html, 'utf8');
  await fs.writeFile(
    path.join(folder, 'metadata.json'),
    JSON.stringify(
      {
        channel: filter.channel,
        gmailId,
        threadId: full.data.threadId,
        messageId: headers['message-id'],
        from: headers['from'],
        replyTo: headers['reply-to'],
        originalSender: headers['x-original-sender'],
        subject,
        date: headers['date'],
        internalDate: full.data.internalDate ? new Date(Number(full.data.internalDate)).toISOString() : undefined,
        poNumber,
        files,
        missingRequired: missing.map(String),
        pulledAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  if (missing.length) {
    return {
      gmailId,
      subject,
      poNumber,
      folder,
      files,
      status: 'missing_required_attachment',
      reason: `missing ${missing.map(String).join(', ')}`,
    };
  }
  return { gmailId, subject, poNumber, folder, files, status: 'saved' };
};

/**
 * Finds emails for one channel and saves the matching ones (attachments + body + metadata).
 * Headers are checked first; attachments are downloaded only for emails that pass the filter.
 */
export const pullEmails = async (filter: ChannelEmailFilter, opts: PullOptions = {}): Promise<PulledEmail[]> => {
  const gmail = getGmail();
  const q = buildQuery(filter, opts);
  console.log(`[${filter.channel}] Gmail search (${env.gmail.mailbox}): ${q}`);

  const ids = await listMessageIds(gmail, q, opts.maxResults ?? 20);
  console.log(`[${filter.channel}] ${ids.length} candidate email(s)`);

  const results: PulledEmail[] = [];
  for (const gmailId of ids) {
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: gmailId,
      format: 'metadata',
      metadataHeaders: METADATA_HEADERS,
    });
    const headers = toHeaderMap(meta.data.payload?.headers ?? []);
    const subject = headers['subject'] ?? '';

    if (opts.subject && subject.trim().toLowerCase() !== opts.subject.trim().toLowerCase()) {
      results.push({ gmailId, subject, status: 'ignored', reason: 'subject is not an exact match' });
      continue;
    }

    const check = filter.matchHeaders(headers);
    if (!check.matched) {
      results.push({ gmailId, subject, status: 'ignored', reason: check.reason });
      continue;
    }

    results.push(await saveEmail(gmail, filter, gmailId, headers, check.extracted?.poNumber ?? 'unknown'));
  }
  return results;
};
