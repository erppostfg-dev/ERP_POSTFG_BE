import { text } from './parse';

/*
 * For channels whose raw OCR field names are not fixed yet (the model may print "PO Qty", "PO  Qty" or "Qty"): a
 * table "our name -> the names the OCR may use", applied before the channel's mapping (2026-10-30, Avenue first).
 */

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9%]/g, '');

/** The raw fields with the OCR's names turned into ours (compared without case, spaces or punctuation); others kept. */
export const ourNames = (raw: Record<string, string>, names: Record<string, string[]>): Record<string, string> => {
  const ours = new Map<string, string>();
  for (const [name, aliases] of Object.entries(names)) for (const a of [name, ...aliases]) if (!ours.has(squash(a))) ours.set(squash(a), name);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = ours.get(squash(key)) ?? key;
    if (!(name in out) || !text(out[name])) out[name] = value;
  }
  return out;
};
