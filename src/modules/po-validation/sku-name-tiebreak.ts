import { SKU_NAME_MATCH } from '../../constants';
import { MasterChannelSku, MasterSku } from '../../entities';
import { matchKey } from './master-data';

/*
 * One channel code on rows of several of our codes (user 2026-11-05, First Club SKU263395202 -> 4 of our codes): the PO's
 * item description decides. A row matches when every word of its product name (the channel row's, else our SKU
 * master's), sizes / units and joiners left out, is in the description. Exactly one of our codes must match; none or
 * several -> undefined (the line goes to review as before). Only for SKU_NAME_TIEBREAK channels (validate-po.ts).
 */

/** The words of a name: lower case, "&" = "and", punctuation and sizes left out. */
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w && !(SKU_NAME_MATCH.IGNORE_WORDS as readonly string[]).includes(w) && !SKU_NAME_MATCH.IGNORE_WORD_RE.test(w));

/** Does this name fit the description (all of its words in it)? Names too short to tell are never used. */
const fits = (name: string | null | undefined, description: Set<string>): boolean => {
  const w = words(name ?? '');
  return w.length >= SKU_NAME_MATCH.MIN_WORDS && w.every((x) => description.has(x));
};

/**
 * The one row (of the one pep code) whose product name fits the PO line's description, else undefined.
 * `rows` = the channel's rows for the line's code (several pep codes); `skus` = our SKU master by pep code.
 */
export const pickByDescription = (
  rows: MasterChannelSku[],
  description: string,
  skus: Map<string, MasterSku>,
): MasterChannelSku | undefined => {
  const desc = new Set(words(description));
  if (!desc.size) return undefined;
  const hits = rows.filter((r) => fits(r.productName, desc) || fits(skus.get(matchKey(r.pepCode))?.productName, desc));
  const peps = new Set(hits.map((r) => matchKey(r.pepCode)));
  if (peps.size !== 1) return undefined;
  return hits.find((r) => r.rateAfterMargin !== null) ?? hits[0];
};
