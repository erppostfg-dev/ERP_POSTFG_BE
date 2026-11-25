import { UNIWARE_OUTSIDE, UNIWARE_OUTSIDE_KIND, UniwareOutsideKind, UPLOAD_STATUS } from '../../constants';

/*
 * Which Uniware B2B sale orders are POs punched outside POST_FG (2026-11-25, constants/uniware-outside.ts). Pure: no
 * database, no network (tested on its own).
 */

/** One element of saleOrder/search (the fields we use). */
export interface B2bOrder {
  code: string;
  displayOrderCode: string;
  channel: string;
  status: string | null;
  created: number | null;
}

/** A po_uploads row with that PO number (+ its saved PO's code and its channel's Uniware channel codes). */
export interface Candidate {
  uploadId: string;
  status: string;
  poNumber: string;
  /** Marked uploaded into Uniware (po_uploads.uniware_uploaded_at). */
  uploaded: boolean;
  /** Our sale order code (master_purchase_orders.orderNo1), null before a PO is saved. */
  orderNo1: string | null;
  /** details_channels.channel_code of every location of the PO's channel. */
  uniwareChannels: string[];
}

export interface Finding {
  order: B2bOrder;
  uploadId: string;
  kind: UniwareOutsideKind;
}

/** The PO number as matched (Uniware keeps what was typed): trimmed, upper case. */
export const poKey = (v: string | null | undefined): string => (v ?? '').trim().toUpperCase();

/** Where a PO is that a Uniware order would be a warning for, or null (anything else: nothing to warn about). */
export const kindOf = (c: Pick<Candidate, 'status' | 'uploaded'>): UniwareOutsideKind | null => {
  if (c.status === UPLOAD_STATUS.NEEDS_REVIEW) return UNIWARE_OUTSIDE_KIND.REVIEW;
  if (c.status === UPLOAD_STATUS.REJECTED) return UNIWARE_OUTSIDE_KIND.REJECTED;
  if (c.status === UPLOAD_STATUS.COMPLETED && !c.uploaded) return UNIWARE_OUTSIDE_KIND.PROCESSED;
  return null;
};

/**
 * The findings: a Uniware order whose channel is one of the PO channel's Uniware channels and whose displayOrderCode is
 * the PO number, for each upload of that PO that is In Review, Rejected, or Processed and not marked uploaded. Never:
 * a cancelled order, our own code (any upload's orderNo1), or a PO one of whose uploads is already marked uploaded
 * (that PO is in Uniware through us; another code there is a repeat for the team to see in Uniware, not here).
 */
export const findingsOf = (orders: B2bOrder[], candidates: Candidate[]): Finding[] => {
  const byPo = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = poKey(c.poNumber);
    byPo.set(k, [...(byPo.get(k) ?? []), c]);
  }
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const o of orders) {
    if (!o.code || !o.displayOrderCode) continue;
    if (o.status && UNIWARE_OUTSIDE.IGNORED_STATUSES.includes(o.status.toUpperCase())) continue;
    const channel = o.channel.trim().toUpperCase();
    const same = (byPo.get(poKey(o.displayOrderCode)) ?? []).filter((c) => c.uniwareChannels.some((u) => u.trim().toUpperCase() === channel));
    if (!same.length) continue;
    if (same.some((c) => c.orderNo1 && c.orderNo1.trim() === o.code.trim())) continue;
    if (same.some((c) => c.status === UPLOAD_STATUS.COMPLETED && c.uploaded)) continue;
    for (const c of same) {
      const kind = kindOf(c);
      const key = `${o.code}|${c.uploadId}`;
      if (!kind || seen.has(key)) continue;
      seen.add(key);
      out.push({ order: o, uploadId: c.uploadId, kind });
    }
  }
  return out;
};

/** saleOrder/search elements -> B2bOrder (anything without a code / PO number is left out). */
export const ordersOf = (elements: unknown): B2bOrder[] => {
  if (!Array.isArray(elements)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  return (elements as Record<string, unknown>[])
    .map((e) => ({
      code: str(e?.code).trim(),
      displayOrderCode: str(e?.displayOrderCode).trim(),
      channel: str(e?.channel).trim(),
      status: str(e?.status) || null,
      created: Number.isFinite(Number(e?.created)) && e?.created !== null ? Number(e.created) : null,
    }))
    .filter((o) => o.code && o.displayOrderCode && o.channel);
};
