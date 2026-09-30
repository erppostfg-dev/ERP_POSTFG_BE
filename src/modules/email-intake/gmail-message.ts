import { gmail_v1 } from 'googleapis';

/** Email headers by lower-case name. */
export type EmailHeaders = Record<string, string>;

export interface GmailAttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId?: string;
  data?: string;
}

export interface DownloadedFile {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface EmailBody {
  text: string;
  html: string;
}

export const toHeaderMap = (headers: gmail_v1.Schema$MessagePartHeader[] = []): EmailHeaders => {
  const map: EmailHeaders = {};
  for (const h of headers) {
    if (h.name && h.value !== undefined && h.value !== null) map[h.name.toLowerCase()] = h.value;
  }
  return map;
};

const decodeBase64Url = (data: string): Buffer => Buffer.from(data, 'base64url');

/** Plain text from an HTML-only email, keeping line breaks. */
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

/** Walks the MIME tree for attachments and the text / HTML body. */
export const readParts = (
  payload: gmail_v1.Schema$MessagePart | undefined,
): { attachments: GmailAttachmentPart[]; body: EmailBody } => {
  const attachments: GmailAttachmentPart[] = [];
  const text: string[] = [];
  const html: string[] = [];

  const walk = (part: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!part) return;
    if (part.filename) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        attachmentId: part.body?.attachmentId ?? undefined,
        data: part.body?.data ?? undefined,
      });
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      text.push(decodeBase64Url(part.body.data).toString('utf8'));
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      html.push(decodeBase64Url(part.body.data).toString('utf8'));
    }
    part.parts?.forEach(walk);
  };
  walk(payload);

  const htmlBody = html.join('\n');
  return { attachments, body: { text: text.length ? text.join('\n') : htmlToText(htmlBody), html: htmlBody } };
};

/** Downloads the attachments whose file name matches `keep`. */
export const downloadAttachments = async (
  gmail: gmail_v1.Gmail,
  gmailId: string,
  parts: GmailAttachmentPart[],
  keep: RegExp,
): Promise<DownloadedFile[]> => {
  const files: DownloadedFile[] = [];
  for (const a of parts.filter((p) => keep.test(p.filename))) {
    let data = a.data;
    if (!data && a.attachmentId) {
      const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: gmailId, id: a.attachmentId });
      data = res.data.data ?? undefined;
    }
    if (data) files.push({ filename: a.filename, mimeType: a.mimeType, content: decodeBase64Url(data) });
  }
  return files;
};

/** The real sender: the Google Group rewrites From, so prefer X-Original-Sender / Reply-To. */
export const originalSender = (headers: EmailHeaders): string => {
  const raw = headers['x-original-sender'] || headers['reply-to'] || headers['from'] || '';
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
};
