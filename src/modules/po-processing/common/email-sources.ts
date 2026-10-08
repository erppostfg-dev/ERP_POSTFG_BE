import fs from 'fs/promises';
import path from 'path';
import { FILES, PoWarning, poWarning, WARNING_CODES } from '../../../constants';
import { HeaderKey } from './apply-mapping';
import { pincodeFrom, text, toDate, toNumber } from './parse';
import { ProcessedPo } from './processed-po';

/*
 * The email body and subject as a second source (the user's rule, 2026-10-07):
 * - the raw OCR JSON is the main source;
 * - a field the raw JSON has AND the body/subject has is cross-checked: a mismatch is a warning;
 * - a field the raw JSON doesn't have is filled from the body/subject (field_sources says so);
 * - a field the body/subject doesn't have is left to the raw JSON alone.
 * Each channel lists in its mapping which body labels / subject parts hold which common field.
 */

/** How a value is compared: address = loose (same pincode, and one text inside the other). */
export type CheckKind = 'text' | 'date' | 'number' | 'address' | 'pincode';

/** A "Label: value" line in the email body that holds a common field. */
export interface BodyField {
  common: HeaderKey;
  label: string;
  kind: CheckKind;
}

/** A part of the subject (regex group 1) that holds a common field. */
export interface SubjectField {
  common: HeaderKey;
  pattern: RegExp;
  kind: CheckKind;
}

export interface EmailSourceMapping {
  body?: BodyField[];
  /** Values inside a sentence of the body (regex group 1), e.g. "You have received a purchase order IRA45550241". */
  bodyPatterns?: SubjectField[];
  /** Body labels with no common name: kept under unmapped as "body: <label>". */
  bodyExtras?: string[];
  subject?: SubjectField[];
}

/** The email body as plain text: body.txt, else body.html without its tags, else "". */
export const readBodyText = async (folder: string): Promise<string> => {
  try {
    return await fs.readFile(path.join(folder, FILES.BODY_TEXT), 'utf8');
  } catch {
    try {
      const html = await fs.readFile(path.join(folder, FILES.BODY_HTML), 'utf8');
      return html.replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    } catch {
      return '';
    }
  }
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The value of a "Label: value" line in the body (label at the start of a line, spaces allowed), or undefined. */
export const bodyValue = (body: string, label: string): string | undefined => {
  const m = new RegExp(`^[ \\t]*${escapeRegex(label)}[ \\t]*:[ \\t]*(.+)$`, 'mi').exec(body);
  const value = m ? text(m[1]) : '';
  return value || undefined;
};

/** A body/subject value in the same format as processed.json ("" when it can't be read). */
const normalize = (kind: CheckKind, raw: string, label: string, warnings: PoWarning[]): string | number => {
  if (kind === 'date') return toDate(raw, label, warnings);
  if (kind === 'number') return toNumber(raw, label, warnings);
  if (kind === 'pincode') return pincodeFrom(raw);
  return text(raw);
};

const loose = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const same = (kind: CheckKind, a: string | number, b: string | number): boolean => {
  if (kind === 'number') return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
  if (kind === 'address') {
    const pa = pincodeFrom(String(a));
    const pb = pincodeFrom(String(b));
    if (pa && pb && pa !== pb) return false;
    const la = loose(String(a));
    const lb = loose(String(b));
    return la.includes(lb) || lb.includes(la);
  }
  return loose(String(a)) === loose(String(b));
};

/** Compares (or fills) one field with a value from the body or subject. */
const check = (po: ProcessedPo, field: HeaderKey, kind: CheckKind, value: string | number, against: 'body' | 'subject'): void => {
  if (value === '') return;
  const current = po[field] as string | number;
  if (current === '') {
    (po as unknown as Record<string, unknown>)[field] = value;
    po.field_sources[field] = against;
    po.cross_checks.push({ field, against, raw: '', value, result: 'filled' });
    return;
  }
  const ok = same(kind, current, value);
  po.cross_checks.push({ field, against, raw: current, value, result: ok ? 'match' : 'mismatch' });
  if (!ok) po.warnings.push(poWarning(WARNING_CODES.CROSS_CHECK_MISMATCH, field, String(current), against, String(value)));
};

/** Cross-checks / fills the PO's header from the email body and subject, as the channel's mapping says. */
export const applyEmailSources = (po: ProcessedPo, body: string, subject: string, mapping: EmailSourceMapping): void => {
  for (const f of mapping.body ?? []) {
    const raw = bodyValue(body, f.label);
    if (raw !== undefined) check(po, f.common, f.kind, normalize(f.kind, raw, `body ${f.label}`, po.warnings), 'body');
  }
  for (const f of mapping.bodyPatterns ?? []) {
    const m = f.pattern.exec(body);
    if (m?.[1]) check(po, f.common, f.kind, normalize(f.kind, m[1], `body ${f.common}`, po.warnings), 'body');
  }
  for (const f of mapping.subject ?? []) {
    const m = f.pattern.exec(subject);
    if (m?.[1]) check(po, f.common, f.kind, normalize(f.kind, m[1], `subject ${f.common}`, po.warnings), 'subject');
  }
  for (const label of mapping.bodyExtras ?? []) {
    const raw = bodyValue(body, label);
    if (raw !== undefined) po.unmapped[`body: ${label}`] = raw;
  }
};
