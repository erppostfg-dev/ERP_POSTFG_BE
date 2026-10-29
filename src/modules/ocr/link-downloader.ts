import fs from 'fs/promises';
import path from 'path';
import { ERROR_CODES, errorMessage, FILES } from '../../constants';
import { appError } from '../../utils/AppError';
import { LOG_SOURCE } from '../../constants/logging';
import { logCall } from '../../utils/log-call';
import { ChannelConfig } from './channels.config';

export interface DownloadedLink {
  name: string;
  filename?: string;
  size?: number;
  /** Host + path of the final file URL (no query string: it holds tokens). */
  source?: string;
  error?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_HOPS = 5;
const TIMEOUT_MS = 30_000;

const safeName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();

const decodeEntities = (s: string): string => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** <a href> targets in the HTML body, with their visible text. */
const anchors = (html: string): { href: string; text: string }[] => {
  const out: { href: string; text: string }[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ href: decodeEntities(m[1]), text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  return out;
};

const fileKind = (buf: Buffer): string | undefined => {
  if (buf.subarray(0, 2).toString() === 'PK') return '.xlsx';
  if (buf.subarray(0, 4).toString('hex') === 'd0cf11e0') return '.xls';
  if (buf.subarray(0, 5).toString() === '%PDF-') return '.pdf';
  return undefined;
};

/**
 * Fetches a link and follows HTTP redirects and the `window.location.href = '...'` page some
 * portals return, until a real file arrives. Every hop must be on an allowed host.
 */
const fetchFile = async (start: string, allowedHosts: string[]): Promise<{ buf: Buffer; url: URL }> => {
  let url = new URL(start);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (url.protocol !== 'https:' || !allowedHosts.includes(url.host)) {
      throw appError(ERROR_CODES.LINK_HOST_NOT_ALLOWED, url.protocol, url.host);
    }
    const target = url;
    const res = await logCall(LOG_SOURCE.HTTP, 'download link', () => fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }),
      { fields: { host: target.host, hop }, failedStatus: (r) => ((r as Response).status >= 400 ? (r as Response).status : undefined) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location') as string, url);
      continue;
    }
    if (!res.ok) throw appError(ERROR_CODES.LINK_HTTP_ERROR, res.status, url.host);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw appError(ERROR_CODES.LINK_FILE_TOO_LARGE, MAX_BYTES);
    if (fileKind(buf)) return { buf, url };

    const next = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(buf.subarray(0, 20_000).toString('utf8'));
    if (!next) throw appError(ERROR_CODES.LINK_NO_FILE, url.host);
    url = new URL(decodeEntities(next[1]), url);
  }
  throw appError(ERROR_CODES.LINK_TOO_MANY_REDIRECTS);
};

/**
 * Downloads the channel's links from the email body into the email folder. A file that is
 * already there (an earlier run) is kept: the links expire, so a re-run must not depend on them.
 */
export const downloadLinkedFiles = async (
  config: ChannelConfig,
  dir: string,
  existing: string[],
): Promise<{ downloaded: DownloadedLink[]; missingRequired: string[] }> => {
  const links = config.links;
  if (!links) return { downloaded: [], missingRequired: [] };

  const record = path.join(dir, FILES.LINKS);
  const previous: DownloadedLink[] = await fs
    .readFile(record, 'utf8')
    .then((s) => JSON.parse(s) as DownloadedLink[])
    .catch(() => []);

  const html = await fs.readFile(path.join(dir, FILES.BODY_HTML), 'utf8').catch(() => '');
  const found = anchors(html);
  const downloaded: DownloadedLink[] = [];

  for (const item of links.items) {
    const before = previous.find((p) => p.name === item.name && p.filename && existing.includes(p.filename));
    if (before) {
      downloaded.push(before);
      continue;
    }
    const link = found.find((a) => item.text.test(a.text));
    if (!link) {
      downloaded.push({ name: item.name, error: errorMessage(ERROR_CODES.LINK_NOT_FOUND, String(item.text)) });
      continue;
    }
    try {
      const { buf, url } = await fetchFile(link.href, links.allowedHosts);
      const base = safeName(decodeURIComponent(url.pathname.split('/').pop() || item.name));
      const filename = path.extname(base) ? base : `${base}${fileKind(buf)}`;
      await fs.writeFile(path.join(dir, filename), buf);
      downloaded.push({ name: item.name, filename, size: buf.length, source: `${url.host}${url.pathname}` });
    } catch (err) {
      downloaded.push({ name: item.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await fs.writeFile(record, JSON.stringify(downloaded, null, 2), 'utf8');
  const missingRequired = links.items
    .filter((i) => i.required && !downloaded.find((d) => d.name === i.name && d.filename))
    .map((i) => `${i.name}: ${downloaded.find((d) => d.name === i.name)?.error ?? errorMessage(ERROR_CODES.LINK_NOT_DOWNLOADED)}`);
  return { downloaded, missingRequired };
};
