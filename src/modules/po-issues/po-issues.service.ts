import { AppDataSource } from '../../config/data-source';
import {
  CHANNEL_MASTER_IDS, CHANNEL_TOLERANCES, ChannelName, ISSUE_STATUS, ISSUE_TYPE, PO_ISSUES, PO_VERIFY_ACTION, REVIEW_SUBMISSION_STATUS, TABLES,
} from '../../constants';
import { MasterChannel } from '../../entities';
import { matchKey } from '../masters/master-match';
import { ChannelMasterData, MasterDataReader } from '../po-validation/master-data';

/*
 * PO issues per channel (user, 2026-10-22: "channel based: what kind of issues each channel has, and inside it every
 * kind of error, with counts", Users & Roles -> PO issues). NOTHING new is stored: everything comes from what the
 * chain already records, counted once per PO:
 *   po_uploads             the channel, date and where each PO ended (processed / in review / rejected / failed …)
 *   po_issues              each problem of a PO: type, and in original_values the channel SKU, PO value vs ours,
 *                          difference (the "item" of a problem: SKU, else the PO's value, else its text)
 *   po_review_submissions  rejections with the reason
 *   po_verifications       POs sent back at the Verify step, with the reason
 * A window of days on po_uploads.created_at (when the PO came in).
 *
 * Is it still a problem? (user, 2026-10-22: not by time, "even after 30 days unchanged it is still an issue") Checked
 * LIVE against today's master on every load, with the same rules as validation, no cache (a few lookups):
 *   SKU not mapped       exactly one master_channel_skus row for that channel SKU now -> fixed
 *   Location not mapped  one complete active location by code, else by pincode, now -> fixed
 *   MRP / Price mismatch the PO's latest value vs our master MRP / rate now, within the channel's tolerance -> fixed
 *   every other kind     a one-off problem of the PO: fixed when none of its issue rows is still open (resolved in review)
 *   Rejected / Sent back final outcomes, shown as they are.
 */

/** What a problem is about: the channel SKU, else the PO's own value (location, PO number, date), else its text. */
const ITEM = `COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(i.original_values, '$.channel_sku_code')), ''),
  NULLIF(JSON_UNQUOTE(JSON_EXTRACT(i.original_values, '$.po')), ''), LEFT(i.details, ${PO_ISSUES.ITEM_MAX}))`;

/** open = still a problem now; fixed = the cause is gone (master fixed / resolved in review); final = rejected, sent back. */
export type ItemState = 'open' | 'fixed' | 'final';
export interface IssueItem {
  item: string; pepCode: string | null; pos: number; lastSeen: string; avgDiff: number | null;
  state: ItemState;
  /** Why, in words: "In the SKU master now", "Master MRP ₹279 vs PO ₹329" … */
  note: string;
}
export interface IssueGroup { kind: string; pos: number; open: number; items: IssueItem[] }
export interface ChannelIssues {
  channel: string;
  pos: number;
  byStatus: Record<string, number>;
  withIssues: number;
  /** Items still a problem now, over all kinds. */
  open: number;
  groups: IssueGroup[];
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const iso = (v: unknown): string => new Date(v as string).toISOString();

export const poIssuesByChannel = async (days: number): Promise<{ days: number; since: string; channels: ChannelIssues[] }> => {
  const since = new Date(Date.now() - days * 864e5);
  const q = <T>(sql: string, params: unknown[]) => AppDataSource.query(sql, params) as Promise<T[]>;

  const [statuses, perType, items, withIssues, rejected, sentBack] = await Promise.all([
    q<{ channel: string; status: string; n: string }>(
      `SELECT channel, status, COUNT(*) n FROM ${TABLES.PO_UPLOADS} WHERE created_at >= ? AND channel IS NOT NULL GROUP BY channel, status`, [since]),
    q<{ channel: string; kind: string; n: string }>(
      `SELECT u.channel, i.issue_type kind, COUNT(DISTINCT i.upload_id) n FROM ${TABLES.PO_ISSUES} i JOIN ${TABLES.PO_UPLOADS} u ON u.id = i.upload_id
        WHERE u.created_at >= ? GROUP BY u.channel, i.issue_type`, [since]),
    q<{ channel: string; kind: string; item: string; pep: string | null; n: string; last: Date; diff: string | null; open_n: string; last_po: string | null }>(
      `SELECT u.channel, i.issue_type kind, ${ITEM} item, MAX(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(i.original_values, '$.pep_code')), '')) pep,
              COUNT(DISTINCT i.upload_id) n, MAX(i.created_at) last,
              AVG(CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(i.original_values, '$.difference')), 'null') AS DECIMAL(14,2))) diff,
              SUM(i.status = ?) open_n,
              SUBSTRING_INDEX(GROUP_CONCAT(JSON_UNQUOTE(JSON_EXTRACT(i.original_values, '$.po')) ORDER BY i.created_at DESC SEPARATOR 0x01), 0x01, 1) last_po
         FROM ${TABLES.PO_ISSUES} i JOIN ${TABLES.PO_UPLOADS} u ON u.id = i.upload_id
        WHERE u.created_at >= ? GROUP BY u.channel, i.issue_type, item ORDER BY n DESC, last DESC`, [ISSUE_STATUS.OPEN, since]),
    q<{ channel: string; n: string }>(
      `SELECT u.channel, COUNT(DISTINCT i.upload_id) n FROM ${TABLES.PO_ISSUES} i JOIN ${TABLES.PO_UPLOADS} u ON u.id = i.upload_id
        WHERE u.created_at >= ? GROUP BY u.channel`, [since]),
    q<{ channel: string; item: string; n: string; last: Date }>(
      `SELECT u.channel, COALESCE(NULLIF(s.decision_remark, ''), '-') item, COUNT(DISTINCT s.upload_id) n, MAX(s.decided_at) last
         FROM ${TABLES.PO_REVIEW_SUBMISSIONS} s JOIN ${TABLES.PO_UPLOADS} u ON u.id = s.upload_id
        WHERE s.status = ? AND u.created_at >= ? GROUP BY u.channel, item ORDER BY n DESC`, [REVIEW_SUBMISSION_STATUS.REJECTED, since]),
    q<{ channel: string; item: string; n: string; last: Date }>(
      `SELECT u.channel, COALESCE(NULLIF(v.remark, ''), '-') item, COUNT(DISTINCT v.upload_id) n, MAX(v.done_at) last
         FROM ${TABLES.PO_VERIFICATIONS} v JOIN ${TABLES.PO_UPLOADS} u ON u.id = v.upload_id
        WHERE v.action = ? AND u.created_at >= ? GROUP BY u.channel, item ORDER BY n DESC`, [PO_VERIFY_ACTION.SENT_BACK, since]).catch(() => []),
  ]);

  const checkOf = await liveChecks([...new Set(items.map((i) => i.channel))]);

  const channels = new Map<string, ChannelIssues>();
  const of = (channel: string) => {
    if (!channels.has(channel)) channels.set(channel, { channel, pos: 0, byStatus: {}, withIssues: 0, open: 0, groups: [] });
    return channels.get(channel)!;
  };
  for (const s of statuses) {
    const c = of(s.channel);
    c.byStatus[s.status] = num(s.n);
    c.pos += num(s.n);
  }
  for (const w of withIssues) of(w.channel).withIssues = num(w.n);
  for (const t of perType) {
    const check = checkOf(t.channel);
    const list = items.filter((i) => i.channel === t.channel && i.kind === t.kind).slice(0, PO_ISSUES.ITEMS_MAX).map((i): IssueItem => ({
      item: i.item ?? '-', pepCode: i.pep, pos: num(i.n), lastSeen: iso(i.last), avgDiff: i.diff === null ? null : Math.round(num(i.diff) * 100) / 100,
      ...check(t.kind, i.item ?? '', i.last_po, num(i.open_n)),
    }));
    // Still a problem first, then the most POs.
    list.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.pos - a.pos);
    of(t.channel).groups.push({ kind: t.kind, pos: num(t.n), open: list.filter((x) => x.state === 'open').length, items: list });
  }
  const extra = (rows: { channel: string; item: string; n: string; last: Date }[], kind: string) => {
    for (const ch of new Set(rows.map((r) => r.channel))) {
      const mine = rows.filter((r) => r.channel === ch);
      of(ch).groups.push({
        kind,
        pos: mine.reduce((s, r) => s + num(r.n), 0),
        open: 0,
        items: mine.slice(0, PO_ISSUES.ITEMS_MAX).map((r) => ({
          item: r.item, pepCode: null, pos: num(r.n), lastSeen: iso(r.last), avgDiff: null, state: 'final' as const, note: PO_ISSUES.NOTE.FINAL,
        })),
      });
    }
  };
  extra(rejected, PO_ISSUES.KIND.REJECTED);
  extra(sentBack, PO_ISSUES.KIND.SENT_BACK);
  for (const c of channels.values()) {
    c.groups.sort((a, b) => b.open - a.open || b.pos - a.pos);
    c.open = c.groups.reduce((s, g) => s + g.open, 0);
  }
  return {
    days,
    since: since.toISOString(),
    channels: [...channels.values()].sort((a, b) => b.open - a.open || b.withIssues - a.withIssues || b.pos - a.pos),
  };
};

// ---- Live check: is it still a problem with today's master? ---------------------------------------------------------

type Check = (kind: string, item: string, lastPo: string | null, openRows: number) => { state: ItemState; note: string };

const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** One master load per channel that has issues (the same reader validation uses), then a check per item in memory. */
const liveChecks = async (displayNames: string[]): Promise<(channel: string) => Check> => {
  const masters = await AppDataSource.getRepository(MasterChannel).find();
  const reader = new MasterDataReader(AppDataSource);
  const loaded = new Map<string, { data: ChannelMasterData | null; slug: ChannelName | null }>();
  for (const name of displayNames) {
    const id = masters.find((m) => m.displayName === name)?.id;
    const slug = (Object.entries(CHANNEL_MASTER_IDS).find(([, v]) => v === id)?.[0] ?? null) as ChannelName | null;
    loaded.set(name, { slug, data: slug ? await reader.forChannel(slug) : null });
  }
  const N = PO_ISSUES.NOTE;
  return (channel) => (kind, item, lastPo, openRows) => {
    const byReview = () => (openRows > 0 ? { state: 'open' as const, note: N.OPEN_IN_REVIEW } : { state: 'fixed' as const, note: N.RESOLVED_IN_REVIEW });
    const m = loaded.get(channel);
    if (!m?.data) return byReview();
    const master = m.data;
    const tol = m.slug ? CHANNEL_TOLERANCES[m.slug] : undefined;
    const rows = master.skusByCode.get(matchKey(item)) ?? [];
    switch (kind) {
      case ISSUE_TYPE.SKU_NOT_MAPPED:
        return rows.length === 1 ? { state: 'fixed', note: N.SKU_IN_MASTER }
          : rows.length > 1 ? { state: 'open', note: N.SKU_AMBIGUOUS(rows.length) } : { state: 'open', note: N.SKU_MISSING };
      case ISSUE_TYPE.LOCATION_NOT_MAPPED: {
        const key = matchKey(item);
        let found = master.locations.filter((l) => matchKey(l.channelLocationCode) === key);
        if (!found.length) found = master.locations.filter((l) => matchKey(l.consigneePinCode) === key);
        if (found.length > 1) return { state: 'open', note: N.LOCATION_MANY(found.length) };
        if (!found.length) return { state: 'open', note: N.LOCATION_MISSING };
        const [l] = found;
        const complete = !!(l.uniwareCustomerCode?.trim() && l.facilityCode?.trim() && l.channelCode?.trim());
        return complete ? { state: 'fixed', note: N.LOCATION_FOUND } : { state: 'open', note: N.LOCATION_INCOMPLETE };
      }
      case ISSUE_TYPE.MRP_MISMATCH:
      case ISSUE_TYPE.PRICE_MISMATCH: {
        if (rows.length !== 1) return { state: 'open', note: N.SKU_MISSING };
        const isMrp = kind === ISSUE_TYPE.MRP_MISMATCH;
        const ours = isMrp ? rows[0].mrp : rows[0].rateAfterMargin;
        const po = Number(lastPo);
        if (ours === null || ours === undefined || !Number.isFinite(po)) return byReview();
        const limit = (isMrp ? tol?.mrpPerSku : tol?.pricePerSku) ?? 0;
        return Math.abs(po - Number(ours)) <= limit
          ? { state: 'fixed', note: N.MATCHES_NOW(isMrp ? 'MRP' : 'rate') }
          : { state: 'open', note: N.STILL_DIFFERS(isMrp ? 'MRP' : 'rate', rupees(Number(ours)), rupees(po)) };
      }
      default:
        return byReview();
    }
  };
};

export interface IssuePo { uploadId: string; poNumber: string | null; status: string; createdAt: string }

/** The POs behind one count (a channel, a kind, an item), newest first. */
export const poIssuePos = async (channel: string, kind: string, item: string, days: number): Promise<IssuePo[]> => {
  const since = new Date(Date.now() - days * 864e5);
  const sql =
    kind === PO_ISSUES.KIND.REJECTED
      ? `SELECT DISTINCT u.id, u.po_number, u.status, u.created_at FROM ${TABLES.PO_REVIEW_SUBMISSIONS} s JOIN ${TABLES.PO_UPLOADS} u ON u.id = s.upload_id
          WHERE u.channel = ? AND s.status = '${REVIEW_SUBMISSION_STATUS.REJECTED}' AND COALESCE(NULLIF(s.decision_remark, ''), '-') = ? AND u.created_at >= ?`
      : kind === PO_ISSUES.KIND.SENT_BACK
        ? `SELECT DISTINCT u.id, u.po_number, u.status, u.created_at FROM ${TABLES.PO_VERIFICATIONS} v JOIN ${TABLES.PO_UPLOADS} u ON u.id = v.upload_id
            WHERE u.channel = ? AND v.action = '${PO_VERIFY_ACTION.SENT_BACK}' AND COALESCE(NULLIF(v.remark, ''), '-') = ? AND u.created_at >= ?`
        : `SELECT DISTINCT u.id, u.po_number, u.status, u.created_at FROM ${TABLES.PO_ISSUES} i JOIN ${TABLES.PO_UPLOADS} u ON u.id = i.upload_id
            WHERE u.channel = ? AND i.issue_type = ? AND ${ITEM} = ? AND u.created_at >= ?`;
  const params = kind === PO_ISSUES.KIND.REJECTED || kind === PO_ISSUES.KIND.SENT_BACK ? [channel, item, since] : [channel, kind, item, since];
  const rows = (await AppDataSource.query(`${sql} ORDER BY u.id DESC LIMIT ${PO_ISSUES.POS_MAX}`, params)) as {
    id: string | number; po_number: string | null; status: string; created_at: Date;
  }[];
  return rows.map((r) => ({ uploadId: String(r.id), poNumber: r.po_number, status: r.status, createdAt: iso(r.created_at) }));
};
