import { api, loginAs } from './auth';
import { rows } from './db';

/*
 * Two-layer margin approval in tests (2026-11-06): a margin / rate change or a new channel SKU is a request until an
 * Operations Manager (layer 1) and an Admin (layer 2), both other people than the requester, approve it.
 */
const V = '/api/v1/approvals/margin-changes';

/** Approves one request at both layers (fresh people each time); returns the applied request. */
export const approveMargin = async (id: string): Promise<Record<string, unknown>> => {
  const l1 = await loginAs('operations-manager');
  const l2 = await loginAs('admin');
  await api().post(`${V}/${id}/approve`).set('Cookie', l1.cookie).send({}).expect(200);
  return (await api().post(`${V}/${id}/approve`).set('Cookie', l2.cookie).send({}).expect(200)).body.data as Record<string, unknown>;
};

/** Approves every open request at both layers (oldest first). */
export const approveAllMargins = async (): Promise<number> => {
  const open = await rows<{ id: string }>("SELECT id FROM margin_change_requests WHERE status IN ('pending_l1', 'pending_l2') ORDER BY id");
  for (const r of open) await approveMargin(String(r.id));
  return open.length;
};
