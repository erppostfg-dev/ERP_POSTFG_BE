import { describe, expect, it } from 'vitest';
import { findingsOf, ordersOf } from '../match';
import { windowsOf } from '../outside.service';

const o = (code: string, po: string, channel = 'BLINKIT_B2B', status = 'PROCESSING') => ({ code, displayOrderCode: po, channel, status, created: 1 });
const c = (uploadId: string, poNumber: string, status: string, extra: { uploaded?: boolean; orderNo1?: string | null } = {}) =>
  ({ uploadId, poNumber, status, uploaded: !!extra.uploaded, orderNo1: extra.orderNo1 ?? null, uniwareChannels: ['BLINKIT_B2B', 'blinkit_b2b_l'] });

describe('findingsOf (2026-11-25)', () => {
  it('another code for a PO In Review / Rejected / Processed not uploaded; never our code, an uploaded PO, a cancelled order or another channel', () => {
    const f = findingsOf(
      [o('sf_1', 'P1'), o('sf_8', 'P8'), o('sf_2', ' p2'), o('sf_3', 'P3'), o('erp_4', 'P4'), o('sf_5', 'P5'), o('sf_6', 'P6', 'ZEPTO_B2B'), o('sf_7', 'P1', 'BLINKIT_B2B', 'CANCELLED'), o('sf_1', 'P1')],
      [c('1', 'P1', 'needs_review'), c('8', 'P8', 'pending_approval'), c('2', 'P2', 'rejected'), c('3', 'P3', 'completed', { orderNo1: 'erp_3' }), c('4', 'P4', 'completed', { orderNo1: 'erp_4' }),
        c('5', 'P5', 'completed', { orderNo1: 'erp_5', uploaded: true }), c('55', 'P5', 'rejected'), c('6', 'P6', 'needs_review')],
    );
    expect(f.map((x) => `${x.order.code}>${x.uploadId}:${x.kind}`)).toEqual(['sf_1>1:review', 'sf_8>8:review', 'sf_2>2:rejected', 'sf_3>3:processed']);
  });
  it('ordersOf keeps only elements with a code, a PO number and a channel', () => {
    expect(ordersOf([{ code: 'a', displayOrderCode: 'P', channel: 'X', status: 'COMPLETE', created: 5 }, { code: 'b', channel: 'X' }, null]).map((x) => x.code)).toEqual(['a']);
    expect(ordersOf(undefined)).toEqual([]);
  });
  it('windowsOf: 30 days back the first time, then from the last end less 30 min, 48 h each', () => {
    const now = 100 * 86_400_000;
    expect(windowsOf(null, now)).toHaveLength(15);
    expect(windowsOf(now - 3_600_000, now)).toEqual([[now - 3_600_000 - 1_800_000, now]]);
  });
});
