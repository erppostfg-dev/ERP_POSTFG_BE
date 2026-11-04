import { describe, expect, it } from 'vitest';
import { isTestFacility, isTestLane, laneText, testCodesOf, testMasterEditBlock, testScopeSql } from '../test-mode';

/* Local TEST ONLY mode helpers (test-mode.ts), no database. */

describe('test facilities', () => {
  const s = { testFacilities: ['TEST_RECV'] };
  it('TEST_FACILITY always, plus d2c:settings.testFacilities, exact code', () => {
    expect(testCodesOf(s)).toEqual(['TEST_FACILITY', 'TEST_RECV']);
    expect(isTestFacility(s, 'TEST_FACILITY')).toBe(true);
    expect(isTestFacility(s, 'TEST_RECV')).toBe(true);
    expect(isTestFacility(s, 'test_facility')).toBe(false);
    expect(isTestFacility(s, null)).toBe(false);
    expect(isTestFacility({ testFacilities: [] }, 'TEST_FACILITY')).toBe(true);
  });
  it('a test lane needs both sides', () => {
    expect(isTestLane(s, 'TEST_FACILITY', 'TEST_FACILITY')).toBe(true);
    expect(isTestLane(s, 'TEST_FACILITY', 'Mcaff_Nagpur')).toBe(false);
    expect(isTestLane(s, 'MUM_WAREHOUSE2', 'TEST_RECV')).toBe(false);
    expect(laneText(null, 'X')).toBe('(no sender) -> X');
  });
  it('Sync now scope: nothing when off; sender or receiving a test facility when on', () => {
    expect(testScopeSql(s, 'p', false)).toEqual({ sql: '', args: [] });
    const on = testScopeSql(s, 'p', true);
    expect(on.sql).toMatch(/^ AND \(p\.facility IN \(\?\) OR EXISTS \(/);
    expect(on.args).toEqual([['TEST_FACILITY', 'TEST_RECV'], ['TEST_FACILITY', 'TEST_RECV']]);
  });
});

describe('D2C masters in local test mode (testMasterEditBlock)', () => {
  const s = { testFacilities: [] as string[] };
  it('off: nothing is refused', () => {
    expect(testMasterEditBlock(s, 'transfer_route', ['vendorCode'], ['MUM_WAREHOUSE2', 'mCaff_Kolkata3'], false)).toBeNull();
    expect(testMasterEditBlock(s, 'facility', ['allowInternalTransfer'], ['MUM_WAREHOUSE2'], false)).toBeNull();
  });
  it('transfer route: every edit and switch needs sender AND receiving test facilities', () => {
    expect(testMasterEditBlock(s, 'transfer_route', ['vendorCode'], ['TEST_FACILITY', 'TEST_FACILITY'], true)).toBeNull();
    expect(testMasterEditBlock(s, 'transfer_route', ['isActive'], ['TEST_FACILITY', 'Mcaff_Nagpur'], true)).toBe('this transfer route is not a TEST_FACILITY row (Mcaff_Nagpur)');
    expect(testMasterEditBlock(s, 'transfer_route', ['customerCode'], ['MUM_WAREHOUSE2', 'mCaff_Kolkata3'], true)).toMatch(/MUM_WAREHOUSE2, mCaff_Kolkata3/);
  });
  it('warehouse: allowInternalTransfer only on a test facility; other fields free', () => {
    expect(testMasterEditBlock(s, 'facility', ['allowInternalTransfer'], ['TEST_FACILITY'], true)).toBeNull();
    expect(testMasterEditBlock(s, 'facility', ['allowInternalTransfer', 'name'], ['MUM_WAREHOUSE2'], true)).toBe('this warehouse is not a TEST_FACILITY row (MUM_WAREHOUSE2)');
    expect(testMasterEditBlock(s, 'facility', ['name', 'stockBucket'], ['MUM_WAREHOUSE2'], true)).toBeNull();
  });
  it('location: transferFacilityId / transferPoPrefix only when its current and new transfer facility are test facilities', () => {
    expect(testMasterEditBlock(s, 'location', ['transferPoPrefix'], ['TEST_FACILITY'], true)).toBeNull();
    expect(testMasterEditBlock(s, 'location', ['transferPoPrefix'], [null], true)).toMatch(/\(\(none\)\)$/);
    expect(testMasterEditBlock(s, 'location', ['transferFacilityId'], ['TEST_FACILITY', 'Mcaff_Nagpur'], true)).toMatch(/Mcaff_Nagpur/);
    expect(testMasterEditBlock(s, 'location', ['consigneeName'], ['Mcaff_Nagpur'], true)).toBeNull();
    expect(testMasterEditBlock(s, 'channel', ['aliases'], [], true)).toBeNull();
  });
});
