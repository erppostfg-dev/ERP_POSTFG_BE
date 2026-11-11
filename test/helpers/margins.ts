import { api, loginAs } from './auth';
import { rows } from './db';

/*
 * Two-layer margin approval in tests (2026-11-06): a margin / rate change or a new channel SKU is a request until an
 * Operations Manager (layer 1) and an Admin (layer 2), both other people than the requester, approve it. Since
 * 2026-11-10 a new channel SKU needs only the first approval (it comes back applied).
 */
const V = '/api/v1/approvals/margin-changes';

/** Approves one request until applied (fresh people each time: one approval for a new SKU, two for a change). */
export const approveMargin = async (id: string): Promise<Record<string, unknown>> => {
  const l1 = await loginAs('operations-manager');
  const l2 = await loginAs('admin');
  const first = (await api().post(`${V}/${id}/approve`).set('Cookie', l1.cookie).send({}).expect(200)).body.data as Record<string, unknown>;
  if (first.status === 'applied') return first;
  return (await api().post(`${V}/${id}/approve`).set('Cookie', l2.cookie).send({}).expect(200)).body.data as Record<string, unknown>;
};

/** Approves every open request until applied (oldest first). */
export const approveAllMargins = async (): Promise<number> => {
  const open = await rows<{ id: string }>("SELECT id FROM margin_change_requests WHERE status IN ('pending_l1', 'pending_l2') ORDER BY id");
  for (const r of open) await approveMargin(String(r.id));
  return open.length;
};
