import { In } from 'typeorm';
import { AppDataSource } from '../../config/data-source';
import {
  ERROR_CODES, MARGIN_APPROVAL, MARGIN_REQUEST_KIND, MARGIN_REQUEST_OPEN, MARGIN_REQUEST_STATUS, MarginRequestKind, MarginRequestSource,
  MarginRequestStatus, MASTER_LOG_SOURCE, MASTER_LOG_TYPE,
} from '../../constants';
import { LOG_SOURCE } from '../../constants/logging';
import { MarginChangeRequest, User } from '../../entities';
import { AppError, appError } from '../../utils/AppError';
import { log } from '../../utils/logger';
import { channelCodeTaken, insertChannelSku, recheckChannel } from './master-add.service';
import { NewChannelSku } from './margin-requests';
import { afterEdit, editRowIn } from './master-edit.service';

/*
 * Deciding margin change requests (2026-11-06, constants/margin-approval.ts; Approvals page, "Margin changes"):
 *   GET  /approvals/margin-changes?status=open|applied|rejected   newest first, with who / when per layer and canApprove
 *   POST /approvals/margin-changes/:id/approve { remark? }
 *        pending_l1 + a layer 1 person (Operations Manager / admin / developer)          -> pending_l2
 *        kind add (a new channel SKU, 2026-11-10): ONE approval by a layer 1 person -> applied (row added)
 *        pending_l2 + a layer 2 person (admin / developer), not the layer 1 approver       -> applied: the channel SKU
 *        row changed (Masters Edit with direct: true: conflict check, History rows) or added (insertChannelSku), in the
 *        same transaction; then that channel's POs in review are re-checked.
 *        The requester never approves their own request.
 *   POST /approvals/margin-changes/:id/reject { remark } (required) by a person who may decide at that layer.
 * A row changed by someone else since the request (or a channel code taken meanwhile) -> 409 MARGIN_REQUEST_STALE,
 * nothing applied: reject it and ask again.
 */

export interface MarginActor { id: number; email: string; roles: string[] }

export interface MarginPerson { id: number; name: string; email: string }

export interface MarginRequestView {
  id: string;
  kind: MarginRequestKind;
  source: MarginRequestSource;
  status: MarginRequestStatus;
  channelSkuId: string | null;
  channel: string;
  channelCode: string;
  pepCode: string;
  /** Margin as a percent of MRP (27 = 27%); null = not part of this change. */
  oldMarginPercent: number | null;
  newMarginPercent: number | null;
  oldRate: number | null;
  newRate: number | null;
  /** add: the row to be added (product name, brand, MRP, EAN). */
  row: Record<string, unknown> | null;
  remark: string | null;
  requestedBy: MarginPerson | null;
  requestedAt: string;
  l1: { by: MarginPerson | null; at: string; remark: string | null } | null;
  l2: { by: MarginPerson | null; at: string; remark: string | null } | null;
  rejected: { by: MarginPerson | null; at: string; reason: string | null } | null;
  /** 1 = a new channel SKU (the first approval adds it), 2 = a change to an existing row (layer 1 then layer 2). */
  approvalsNeeded: 1 | 2;
  /** The person asking may approve / reject it now (right layer, right role, not their own, not layer 1 again). */
  canDecide: boolean;
  /** Why not, when they may not (for the screen). */
  whyNot: string | null;
}

const MARGIN_LIST_FILTER = { OPEN: 'open', APPLIED: 'applied', REJECTED: 'rejected' } as const;

const pct = (v: string | null): number | null => (v === null ? null : Math.round(Number(v) * 10000) / 100);
const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));
const hasRole = (a: MarginActor, roles: readonly string[]) => a.roles.some((r) => roles.includes(r));

/** null = the actor may decide this request now; else why not. */
const whyNot = (r: MarginChangeRequest, a: MarginActor): string | null => {
  if (!(MARGIN_REQUEST_OPEN as readonly string[]).includes(r.status)) return `it is ${r.status}`;
  if (r.requestedBy === a.id) return 'you asked for this change';
  // a new channel SKU: one approval by a layer 1 person (also one asked before 2026-11-10, now waiting at layer 2)
  if (r.kind === MARGIN_REQUEST_KIND.ADD) return hasRole(a, MARGIN_APPROVAL.L1_ROLES) ? null : 'layer 1 is for Operations Manager';
  if (r.status === MARGIN_REQUEST_STATUS.PENDING_L1) return hasRole(a, MARGIN_APPROVAL.L1_ROLES) ? null : 'layer 1 is for Operations Manager';
  if (!hasRole(a, MARGIN_APPROVAL.L2_ROLES)) return 'layer 2 is for Admin';
  return r.l1By === a.id ? 'you approved layer 1: layer 2 must be someone else' : null;
};

const peopleOf = async (ids: (number | null)[]): Promise<Map<number, MarginPerson>> => {
  const unique = [...new Set(ids.filter((x): x is number => x !== null))];
  if (!unique.length) return new Map();
  const users = await AppDataSource.getRepository(User).find({ select: { id: true, name: true, email: true }, where: { id: In(unique) } });
  return new Map(users.map((u) => [u.id, { id: u.id, name: u.name, email: u.email }]));
};

const view = (r: MarginChangeRequest, people: Map<number, MarginPerson>, a: MarginActor): MarginRequestView => {
  const person = (id: number | null) => (id === null ? null : people.get(id) ?? { id, name: `User ${id}`, email: '' });
  const why = whyNot(r, a);
  return {
    id: String(r.id), kind: r.kind, source: r.source, status: r.status, channelSkuId: r.channelSkuId === null ? null : String(r.channelSkuId),
    channel: r.channelName, channelCode: r.channelCode, pepCode: r.pepCode, approvalsNeeded: MARGIN_APPROVAL.APPROVALS_NEEDED[r.kind],
    oldMarginPercent: pct(r.oldMargin), newMarginPercent: pct(r.newMargin), oldRate: numOrNull(r.oldRate), newRate: numOrNull(r.newRate),
    row: r.kind === MARGIN_REQUEST_KIND.ADD ? r.payload : null, remark: r.remark,
    requestedBy: person(r.requestedBy), requestedAt: r.requestedAt.toISOString(),
    l1: r.l1At ? { by: person(r.l1By), at: r.l1At.toISOString(), remark: r.l1Remark } : null,
    l2: r.l2At ? { by: person(r.l2By), at: r.l2At.toISOString(), remark: r.l2Remark } : null,
    rejected: r.rejectedAt ? { by: person(r.rejectedBy), at: r.rejectedAt.toISOString(), reason: r.rejectReason } : null,
    canDecide: why === null, whyNot: why,
  };
};

const filterOf = (raw: unknown): MarginRequestStatus[] => {
  const v = typeof raw === 'string' ? raw : MARGIN_LIST_FILTER.OPEN;
  if (v === MARGIN_LIST_FILTER.APPLIED) return [MARGIN_REQUEST_STATUS.APPLIED];
  if (v === MARGIN_LIST_FILTER.REJECTED) return [MARGIN_REQUEST_STATUS.REJECTED];
  if (v === MARGIN_LIST_FILTER.OPEN) return [...MARGIN_REQUEST_OPEN];
  throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'status', code: ERROR_CODES.FIELD_NOT_ONE_OF, message: `status must be one of ${Object.values(MARGIN_LIST_FILTER).join(', ')}` }]);
};

/** The list of one tab (open = waiting L1 or L2) + how many are open, waiting L1, waiting L2. */
export const listMarginRequests = async (status: unknown, a: MarginActor) => {
  const repo = AppDataSource.getRepository(MarginChangeRequest);
  const rows = await repo.find({ where: { status: In(filterOf(status)) }, order: { id: 'DESC' }, take: MARGIN_APPROVAL.LIST_MAX });
  const [l1, l2] = await Promise.all([repo.countBy({ status: MARGIN_REQUEST_STATUS.PENDING_L1 }), repo.countBy({ status: MARGIN_REQUEST_STATUS.PENDING_L2 })]);
  const people = await peopleOf(rows.flatMap((r) => [r.requestedBy, r.l1By, r.l2By, r.rejectedBy]));
  return { items: rows.map((r) => view(r, people, a)), counts: { waitingL1: l1, waitingL2: l2, open: l1 + l2 } };
};

const idOf = (raw: string): string => {
  if (!MARGIN_APPROVAL.ID_PATTERN.test(raw)) throw appError(ERROR_CODES.MARGIN_REQUEST_NOT_FOUND, raw);
  return raw;
};
const remarkOf = (raw: unknown, required: boolean): string | null => {
  const s = typeof raw === 'string' ? raw.trim().slice(0, MARGIN_APPROVAL.REMARK_MAX) : '';
  if (required && !s) throw appError(ERROR_CODES.VALIDATION_FAILED).withDetails([{ field: 'remark', code: ERROR_CODES.FIELD_REQUIRED, message: 'remark is required: say why it is rejected' }]);
  return s || null;
};

/** The request locked for this decision, checked against the actor (404 / 409 / 403 with why). */
const lockForDecision = async (m: import('typeorm').EntityManager, id: string, a: MarginActor): Promise<MarginChangeRequest> => {
  const r = await m.getRepository(MarginChangeRequest).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  if (!r) throw appError(ERROR_CODES.MARGIN_REQUEST_NOT_FOUND, id);
  if (!(MARGIN_REQUEST_OPEN as readonly string[]).includes(r.status)) throw appError(ERROR_CODES.MARGIN_REQUEST_NOT_OPEN, id, r.status);
  const why = whyNot(r, a);
  if (why) {
    const roleProblem = why.startsWith('layer');
    if (roleProblem) {
      const layer2 = r.status === MARGIN_REQUEST_STATUS.PENDING_L2 && r.kind !== MARGIN_REQUEST_KIND.ADD;
      throw appError(ERROR_CODES.MARGIN_APPROVER_ROLE, layer2 ? 'layer 2' : 'layer 1', (layer2 ? MARGIN_APPROVAL.L2_ROLES : MARGIN_APPROVAL.L1_ROLES).join(' / '));
    }
    throw appError(ERROR_CODES.MARGIN_APPROVER_SAME_PERSON, why);
  }
  return r;
};

/** Layer 1 -> waiting layer 2; layer 2 -> applied to the master (same transaction). */
export const approveMarginRequest = async (rawId: string, body: Record<string, unknown>, a: MarginActor) => {
  const id = idOf(rawId);
  const remark = remarkOf(body.remark, false);
  const now = new Date();
  let recheck: (() => void) | null = null;
  await AppDataSource.transaction(async (m) => {
    const r = await lockForDecision(m, id, a);
    const repo = m.getRepository(MarginChangeRequest);
    const single = r.kind === MARGIN_REQUEST_KIND.ADD; // a new channel SKU: this one approval adds it
    if (!single && r.status === MARGIN_REQUEST_STATUS.PENDING_L1) {
      await repo.update({ id: r.id }, { status: MARGIN_REQUEST_STATUS.PENDING_L2, l1By: a.id, l1At: now, l1Remark: remark });
      log.info(LOG_SOURCE.APP, `[margins] ${a.email} approved layer 1 of margin request #${id} (${r.channelName} ${r.channelCode})`);
      return;
    }
    // apply (layer 2 of a change, or the one approval of a new channel SKU). The History says who asked and who approved.
    const people = await peopleOf([r.requestedBy, r.l1By]);
    const nameOf = (uid: number | null) => (uid === null ? '-' : people.get(uid)?.email ?? `user ${uid}`);
    const approvedBy = single ? `approved by ${a.email}` : `layer 1 ${nameOf(r.l1By)}, layer 2 ${a.email}`;
    const why = `${single ? 'New channel SKU' : 'Margin change'} #${id}: asked by ${nameOf(r.requestedBy)}, ${approvedBy}${r.remark ? `. ${r.remark}` : ''}`.slice(0, 500);
    let channelSkuId = r.channelSkuId;
    try {
      if (r.kind === MARGIN_REQUEST_KIND.EDIT) {
        const changes: Record<string, number> = {};
        const original: Record<string, number | null> = {};
        if (r.newMargin !== null) { changes.marginPercent = pct(r.newMargin)!; original.marginPercent = pct(r.oldMargin); }
        if (r.newRate !== null) { changes.rateAfterMargin = Number(r.newRate); original.rateAfterMargin = numOrNull(r.oldRate); }
        const out = await editRowIn(m, MASTER_LOG_TYPE.CHANNEL_SKU, String(r.channelSkuId), { changes, original, remark: why }, a, MASTER_LOG_SOURCE.SCREEN, { direct: true });
        recheck = () => afterEdit(out);
      } else {
        const v = r.payload as unknown as NewChannelSku;
        if (await channelCodeTaken(m, v.channelId, v.channelCode)) throw appError(ERROR_CODES.MARGIN_REQUEST_STALE, id, `${v.channelName} ${v.channelCode} was added meanwhile`);
        channelSkuId = await insertChannelSku(m, a, v, why);
        recheck = () => recheckChannel(v.channelName);
      }
    } catch (err) {
      // someone changed the row since the request: nothing applied, say what
      if (err instanceof AppError && err.code === ERROR_CODES.MASTER_EDIT_CONFLICT) {
        throw appError(ERROR_CODES.MARGIN_REQUEST_STALE, id, 'the margin / rate was changed since it was asked');
      }
      throw err;
    }
    // the one approval of a new SKU is recorded as layer 1 (an old one already past layer 1 records it as layer 2)
    const decision = single && r.status === MARGIN_REQUEST_STATUS.PENDING_L1
      ? { l1By: a.id, l1At: now, l1Remark: remark }
      : { l2By: a.id, l2At: now, l2Remark: remark };
    await repo.update({ id: r.id }, { status: MARGIN_REQUEST_STATUS.APPLIED, ...decision, channelSkuId });
    log.info(LOG_SOURCE.APP, `[margins] ${a.email} approved ${single ? 'new channel SKU' : 'layer 2 of margin'} request #${id}: applied to ${r.channelName} ${r.channelCode}`);
  });
  (recheck as (() => void) | null)?.();
  return getOne(id, a);
};

export const rejectMarginRequest = async (rawId: string, body: Record<string, unknown>, a: MarginActor) => {
  const id = idOf(rawId);
  const reason = remarkOf(body.remark, true);
  await AppDataSource.transaction(async (m) => {
    const r = await lockForDecision(m, id, a);
    await m.getRepository(MarginChangeRequest).update({ id: r.id }, { status: MARGIN_REQUEST_STATUS.REJECTED, rejectedBy: a.id, rejectedAt: new Date(), rejectReason: reason });
    log.info(LOG_SOURCE.APP, `[margins] ${a.email} rejected margin request #${id} (${r.channelName} ${r.channelCode}): ${reason}`);
  });
  return getOne(id, a);
};

const getOne = async (id: string, a: MarginActor): Promise<MarginRequestView> => {
  const r = await AppDataSource.getRepository(MarginChangeRequest).findOneByOrFail({ id });
  return view(r, await peopleOf([r.requestedBy, r.l1By, r.l2By, r.rejectedBy]), a);
};
