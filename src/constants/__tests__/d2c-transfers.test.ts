import { describe, expect, it } from 'vitest';
import {
  D2C_DEFAULT_SETTINGS, d2cFinancialYear, d2cInwardPoCode, d2cReferenceId, d2cSaleOrderCode, d2cTransferCode, d2cTransferMonth,
} from '../d2c-transfers';
import { SHIPMENT_LOG_ACTION, SHIPMENT_LOG_SOURCE } from '../db';

describe('d2c transfer codes', () => {
  it('financial year runs April to March', () => {
    expect(d2cFinancialYear('2026-11-05')).toBe('2627');
    expect(d2cFinancialYear('2027-03-31')).toBe('2627');
    expect(d2cFinancialYear('2027-04-01')).toBe('2728');
    expect(d2cFinancialYear('2099-12-01')).toBe('9900');
  });

  it('transfer code is IT-<FY>-<MM>-<NNN>, at least 3 digits', () => {
    expect(d2cTransferMonth('2026-11-05')).toBe('2627-11');
    expect(d2cTransferCode('2026-11-05', 4)).toBe('IT-2627-11-004');
    expect(d2cTransferCode('2027-01-31', 12)).toBe('IT-2627-01-012');
    expect(d2cTransferCode('2026-11-05', 1000)).toBe('IT-2627-11-1000');
  });

  it('reference ID is <facility>|<DD><Mon><YYYY>|<tag><serial>, serial not padded', () => {
    expect(d2cReferenceId('mCaff_Kolkata3', '2026-11-05', 'Regular', 12)).toBe('mCaff_Kolkata3|05Nov2026|12');
    expect(d2cReferenceId('mCaff_Kolkata3', '2026-11-05', 'Internal', 13)).toBe('mCaff_Kolkata3|05Nov2026|Int13');
    expect(d2cReferenceId('mCaff_Kolkata3', '2026-11-05', 'Freebee', 14)).toBe('mCaff_Kolkata3|05Nov2026|Freebee14');
    expect(d2cReferenceId('GGN_WAREHOUSE', '2027-01-09', 'Regular', 1)).toBe('GGN_WAREHOUSE|09Jan2027|1');
  });

  it('SO code is erp_it_<yyyymmdd><NNN> and the inward PO code is <SO code>-<n>', () => {
    expect(d2cSaleOrderCode('2026-11-03', 1)).toBe('erp_it_20261103001');
    expect(d2cSaleOrderCode('2026-11-03', 1234)).toBe('erp_it_202611031234');
    expect(d2cInwardPoCode('erp_it_20261103001', 2)).toBe('erp_it_20261103001-2');
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(() => d2cTransferCode('05-11-2026', 1)).toThrow();
    expect(() => d2cReferenceId('X', '2026/11/05', 'Regular', 1)).toThrow();
  });

  it('settings start switched off, on the test facility only', () => {
    expect(D2C_DEFAULT_SETTINGS.live).toBe(false);
    expect(D2C_DEFAULT_SETTINGS.testFacilities).toEqual(['TEST_FACILITY']);
    expect(D2C_DEFAULT_SETTINGS.channels).toHaveLength(5);
  });

  it('keeps every existing shipment_logs value (the new ones are only added)', () => {
    expect(Object.values(SHIPMENT_LOG_ACTION).slice(0, 8)).toEqual([
      'created', 'field_changed', 'bulk_update', 'line_qty_requested', 'line_qty_approved', 'line_qty_rejected', 'uniware_uploaded', 'uniware_upload_undone',
    ]);
    expect(Object.values(SHIPMENT_LOG_SOURCE)).toEqual(['screen', 'bulk_csv', 'pipeline', 'review', 'script', 'tool_api', 'uniware', 'system']);
  });
});
