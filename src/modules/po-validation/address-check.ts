import { ADDRESS_CHECK, ChannelName, ISSUE_FIELDS, ISSUE_TYPE, OUR_PAN, ValidationIssue, validationIssue } from '../../constants';
import { ProcessedPo } from '../po-processing/common/processed-po';
import { ChannelMasterData, matchKey } from './master-data';

/*
 * Address Mismatch (2026-11-06, constants/validation.ts ADDRESS_CHECK): the PO is billed to one of our warehouses (the
 * GSTIN it prints for us, vendor_gstin) but its location is mapped to another warehouse (details_channels.facility_code).
 * Not checked: Amazon / Flipkart / Myntra (B2C), a PO without our GSTIN, a warehouse whose GSTIN we don't know.
 */

const gstinOf = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '').toUpperCase();

/** The warehouse's GSTIN: master_facilities.bill_to_gstin when filled, else ADDRESS_CHECK.WAREHOUSE_GSTIN. */
const warehouseGstin = (facilityCode: string, master: ChannelMasterData): string => {
  const fromMaster = gstinOf(master.facilities.find(facilityCode)?.billToGstin);
  if (fromMaster) return fromMaster;
  const key = Object.keys(ADDRESS_CHECK.WAREHOUSE_GSTIN).find((k) => matchKey(k) === matchKey(facilityCode));
  return key ? ADDRESS_CHECK.WAREHOUSE_GSTIN[key] : '';
};

const labelOf = (gstin: string, facilityCode?: string): string =>
  ADDRESS_CHECK.GSTIN_LABEL[gstin] ?? (facilityCode ? `${facilityCode}` : `GSTIN ${gstin}`);

/** The ADDRESS_MISMATCH issue for this PO and its matched location, or null (same warehouse, or nothing to compare). */
export const addressMismatch = (
  po: ProcessedPo, channel: ChannelName, location: { locationCode: string; facilityCode: string }, master: ChannelMasterData,
): ValidationIssue | null => {
  if (ADDRESS_CHECK.SKIP_CHANNELS.includes(channel)) return null;
  const billed = gstinOf(po.vendor_gstin);
  // only our own GSTIN says which warehouse the PO is for (an OCR may put the buyer's there)
  if (!billed.includes(OUR_PAN) || !location.facilityCode) return null;
  const mapped = warehouseGstin(location.facilityCode, master);
  if (!mapped || mapped === billed) return null;
  return validationIssue(
    ISSUE_TYPE.ADDRESS_MISMATCH, { field: ISSUE_FIELDS.BILLED_TO, actual: billed },
    billed, labelOf(billed), location.locationCode || '-', `${location.facilityCode} (${labelOf(mapped, location.facilityCode)})`,
  );
};
