import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { FILES, FOLDERS, Provider } from '../../constants';
import { knownEmail, messageKey, recordEmail } from './intake-emails.service';

export interface InboundEmail {
  /** Top folder under EMAIL_STORAGE_DIR: the Gmail label, or "manual". */
  group: string;
  messageId: string;
  provider: Provider;
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


/** Emails of a group that are not POs are moved to <group>-not-po/ (see email-sorter.service.ts). */
export const NOT_PO_SUFFIX = FOLDERS.NOT_PO_SUFFIX;

/** <EMAIL_STORAGE_DIR>/<group>/ */
export const groupDirFor = (group: string): string => path.resolve(env.storage.emailDir, safeName(group.toLowerCase()));

/** The folder already holding this key, in the group or its not-PO folder. */
const findStored = async (groupDir: string, key: string): Promise<string | undefined> => {
  for (const dir of [groupDir, `${groupDir}${NOT_PO_SUFFIX}`]) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const hit = names.find((d) => d.endsWith(`_${key}`));
    if (hit) return path.join(dir, hit);
  }
  return undefined;
};

/**
 * Saves one email to <EMAIL_STORAGE_DIR>/<group>/<received date>_<key>/.
 * The same Message-ID is stored once (also when it was moved to <group>-not-po/);
 * a repeat returns the existing folder with duplicate = true.
 */
/** The folder of an email already stored under a group or its -not-po group, if any (reads only). */
export const storedFolderOf = async (group: string, messageId: string): Promise<string | undefined> => {
  const key = messageKey(messageId);
  return (await findStored(groupDirFor(group), key)) ?? (await findStored(groupDirFor(`${group}${NOT_PO_SUFFIX}`), key));
};

/**
 * POST_FG already has this email: its folder is on the disk, or the DB remembers it (the local copy was removed after
 * the PO finished; 2026-10-23). The folder when it is still on the disk.
 */
export const alreadyStored = async (group: string, messageId: string): Promise<{ folder?: string } | null> => {
  const folder = await storedFolderOf(group, messageId);
  if (folder) return { folder };
  return (await knownEmail(messageId)) ? {} : null;
};

export const storeInboundEmail = async (email: InboundEmail): Promise<StoredEmail> => {
  const groupDir = groupDirFor(email.group);
  const key = messageKey(email.messageId);

  await fs.mkdir(groupDir, { recursive: true });
  const existing = await findStored(groupDir, key);
  if (existing) {
    const folder = existing;
    const meta = JSON.parse(await fs.readFile(path.join(folder, FILES.METADATA), 'utf8')) as {
      files?: { filename: string; size: number }[];
    };
    return { folder, duplicate: true, files: meta.files ?? [] };
  }
  // Not on the disk any more (finished, files in S3): the DB still knows it -> a repeat, nothing stored again.
  const known = await knownEmail(email.messageId);
  if (known) return { folder: `s3:${known.s3Folder ?? known.folderName}`, duplicate: true, files: (known.files ?? []).map((filename) => ({ filename, size: 0 })) };

  const prefix = (email.receivedAt ?? new Date().toISOString()).slice(0, 10);
  const folder = path.join(groupDir, `${safeName(prefix)}_${key}`);
  await fs.mkdir(folder, { recursive: true });

  const files: StoredEmail['files'] = [];
  for (const f of email.files) {
    const filename = safeName(f.filename);
    await fs.writeFile(path.join(folder, filename), f.content);
    files.push({ filename, size: f.content.length });
  }
  if (email.bodyText) await fs.writeFile(path.join(folder, FILES.BODY_TEXT), email.bodyText, 'utf8');
  if (email.bodyHtml) await fs.writeFile(path.join(folder, FILES.BODY_HTML), email.bodyHtml, 'utf8');

  const { files: _content, bodyText: _text, bodyHtml: _html, ...meta } = email;
  await fs.writeFile(
    path.join(folder, FILES.METADATA),
    JSON.stringify({ ...meta, files, storedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  await recordEmail(folder);

  return { folder, duplicate: false, files };
};
