import { describe, expect, it } from 'vitest';
import { UNIWARE_CSV } from '../../../constants';
import { buildCreateRequest } from '../payload';

/* The saleOrder/create request from a sale order CSV (2026-11-09): one item per unit, nothing sent when something is missing. */
const csv = (rows: string[][]) => [UNIWARE_CSV.HEADERS.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
const row = (o: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    'Sales Order Code': 'erp_20261109001', 'Display Sales Order Code': '"PO,1"', COD: '0', Channel: 'B2C_STN_FLIPKART',
    'Sale Order Item Code': 'MCaf41', 'Shipping Method': 'STD', 'Item SKU Code': 'MCaf41', 'Channel Product Id': 'FSN1',
    'Selling Price': '100.50', 'On Hold': 'FALSE', Quantity: '2', 'Customer Code': 'FLIPKART_X', 'Facility Code': 'MUM_WAREHOUSE2', 'PO Date': '2026-11-06',
  };
  return UNIWARE_CSV.HEADERS.map((h) => o[h] ?? base[h]);
};
const ADDRESS = { name: 'Flipkart', line1: 'Plot 1, Bhiwandi', city: 'Bhiwandi', state: 'Maharashtra', pincode: '421302', gstin: null };

describe('buildCreateRequest', () => {
  it('two lines -> one item per unit, totals, quoted cells, PO date in IST', () => {
    const r = buildCreateRequest(csv([row(), row({ 'Item SKU Code': 'MCaf42', 'Sale Order Item Code': 'MCaf42', Quantity: '1', 'Selling Price': '50' })]), ADDRESS, '9999999999');
    expect(r.missing).toEqual([]);
    const so = r.request!.payload.saleOrder;
    expect(so).toMatchObject({ code: 'erp_20261109001', displayOrderCode: 'PO,1', displayOrderDateTime: '2026-11-06T00:00:00.000+05:30', totalPrepaidAmount: 251 });
    expect((so.saleOrderItems as { code: string; itemSku: string }[]).map((i) => [i.code, i.itemSku])).toEqual([
      ['MCaf41-1-1', 'MCaf41'], ['MCaf41-1-2', 'MCaf41'], ['MCaf42-2-1', 'MCaf42'],
    ]);
    expect(r.request).toMatchObject({ facility: 'MUM_WAREHOUSE2', items: 3, value: 251 });
    expect(so).not.toHaveProperty('customerGSTIN');
  });

  it('anything missing: no request, every gap named', () => {
    const r = buildCreateRequest(csv([row({ 'Customer Code': '', Quantity: '0' }), row({ 'Facility Code': 'GGN_WAREHOUSE' })]), { ...ADDRESS, city: ' ', state: null }, '');
    expect(r.request).toBeUndefined();
    expect(r.missing).toEqual(expect.arrayContaining([
      expect.stringContaining('Facility Code differs'), expect.stringContaining('Customer Code differs'), 'city', 'state', 'phone (UNIWARE_ORDER_PHONE)', 'line 1: quantity "0"',
    ]));
  });

  it('a CSV with other columns is refused', () => {
    expect(() => buildCreateRequest('a,b\r\n1,2', ADDRESS, '1')).toThrow('expected columns');
  });
});
