import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';

export interface InboundEmail {
  /** Top folder under EMAIL_STORAGE_DIR: the Gmail label, or "manual". */
  group: string;
  messageId: string;
  provider: 'gmail-pubsub' | 'manual';
  gmailId?: string;
  labels?: string[];
  from?: string;
  subject?: string;
  receivedAt?: string;
  bodyText?: string;
  bodyHtml?: string;
  files: { filename: string; content: Buffer }[];
}

export interface StoredEmail {
  folder: string;
  duplicate: boolean;
  files: { filename: string; size: number }[];
}

const safeName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();

/** Short, stable key for a Message-ID (Message-IDs are long and full of <>@). */
const messageKey = (messageId: string): string => crypto.createHash('sha1').update(messageId).digest('hex').slice(0, 16);

/**
 * Saves one email to <EMAIL_STORAGE_DIR>/<group>/<received date>_<key>/.
 * The same Message-ID is stored once; a repeat returns the existing folder with duplicate = true.
 */
export const storeInboundEmail = async (email: InboundEmail): Promise<StoredEmail> => {
  const groupDir = path.resolve(env.storage.emailDir, safeName(email.group.toLowerCase()));
  const key = messageKey(email.messageId);

  await fs.mkdir(groupDir, { recursive: true });
  const existing = (await fs.readdir(groupDir)).find((d) => d.endsWith(`_${key}`));
  if (existing) {
    const folder = path.join(groupDir, existing);
    const meta = JSON.parse(await fs.readFile(path.join(folder, 'metadata.json'), 'utf8')) as {
      files?: { filename: string; size: number }[];
    };
    return { folder, duplicate: true, files: meta.files ?? [] };
  }

  const prefix = (email.receivedAt ?? new Date().toISOString()).slice(0, 10);
  const folder = path.join(groupDir, `${safeName(prefix)}_${key}`);
  await fs.mkdir(folder, { recursive: true });

  const files: StoredEmail['files'] = [];
  for (const f of email.files) {
    const filename = safeName(f.filename);
    await fs.writeFile(path.join(folder, filename), f.content);
    files.push({ filename, size: f.content.length });
  }
  if (email.bodyText) await fs.writeFile(path.join(folder, 'body.txt'), email.bodyText, 'utf8');
  if (email.bodyHtml) await fs.writeFile(path.join(folder, 'body.html'), email.bodyHtml, 'utf8');

  const { files: _content, bodyText: _text, bodyHtml: _html, ...meta } = email;
  await fs.writeFile(
    path.join(folder, 'metadata.json'),
    JSON.stringify({ ...meta, files, storedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  return { folder, duplicate: false, files };
};
