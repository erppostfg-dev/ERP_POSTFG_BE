import { MYNTRA_STR } from '../../../constants';

/*
 * The STR list of a Myntra "Request to Raise STRs" email (2026-11-03). Only the email's NEWEST part counts: a reply
 * quotes the earlier list again (27 Oct: the price-mismatch reply), and that quoted list must never be taken twice.
 * A forwarded email (someone forwards Myntra's reply to Po-Intake) is read from the forwarded message on.
 */

export interface StrRef {
  str: string;
  /** 1-based place in the email (the robot keeps this order). */
  order: number;
  /** NON TC / TC and P0 - P3 headers above it (labels only). */
  group: string;
  priority: string;
  /** Destination code (BP, FKME, BW, MW, MYNT ...) and the date in the code (YYYY-MM-DD). */
  destination: string;
  date: string;
}

/** The text before the first reply marker; a leading forward header block is skipped. */
export const newestPart = (body: string): string => {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  const fwd = lines.findIndex((l) => MYNTRA_STR.FORWARD.test(l.trim()));
  // a forward block near the top: skip it and its header lines (From / Date / Subject / To / Cc)
  if (fwd >= 0 && lines.slice(0, fwd).every((l) => !MYNTRA_STR.LIST_START.test(l))) {
    start = fwd + 1;
    while (start < lines.length && (MYNTRA_STR.FORWARD_HEADER.test(lines[start].trim()) || !lines[start].trim())) start++;
  }
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim();
    // "On Mon, Oct 26, 2026 at 2:57 PM Name <" + "x@y> wrote:" on the next line counts too
    const two = `${l} ${(lines[i + 1] ?? '').trim()}`;
    if (MYNTRA_STR.QUOTE_START.some((re) => re.test(l)) || (/^On\s/.test(l) && /wrote:\s*$/.test(two))) break;
    out.push(lines[i]);
  }
  return out.join('\n');
};

/** Whether this email is a Myntra STR list (subject + the list line in the newest part). */
export const isStrEmail = (subject: string | undefined, body: string): boolean =>
  MYNTRA_STR.SUBJECT.test(subject ?? '') && MYNTRA_STR.LIST_START.test(newestPart(body));

/** Every STR of the newest part, in order, each once, with its group / priority headers. */
export const strsOf = (body: string): StrRef[] => {
  const text = newestPart(body);
  const at = text.search(MYNTRA_STR.LIST_START);
  if (at < 0) return [];
  const out: StrRef[] = [];
  const seen = new Set<string>();
  let group = '';
  let priority = '';
  for (const raw of text.slice(at).split('\n')) {
    const l = raw.trim();
    if (MYNTRA_STR.GROUP.test(l)) { group = l.toUpperCase().replace(/\s+/g, ' '); priority = ''; continue; }
    if (MYNTRA_STR.PRIORITY.test(l)) { priority = l.toUpperCase(); continue; }
    for (const m of l.matchAll(new RegExp(MYNTRA_STR.CODE.source, 'g'))) {
      const str = m[0];
      if (seen.has(str)) continue;
      seen.add(str);
      const [, , dest, dd, mm, yy] = m;
      out.push({ str, order: out.length + 1, group, priority, destination: dest, date: `20${yy}-${mm}-${dd}` });
    }
  }
  return out;
};
