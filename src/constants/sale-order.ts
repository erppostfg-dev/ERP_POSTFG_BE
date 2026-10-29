/*
 * Saving a validated PO (step 2): the PO tables as PEPIMS fills them, the sale order code and the Uniware CSV.
 */

import { PO_ACTIVE_STATUS } from './db';

/**
 * Sale order code: erp_<yyyymmdd><serial>, e.g. erp_20261019001 (user, 2026-10-19: prefix erp_ instead of sf_; the
 * codes made before were renamed by migration SaleOrderPrefixErp + the sale-orders:prefix script for the CSVs).
 * The serial comes from sale_order_code_counter: one row per date; a new date starts at 1, the same date adds 1.
 */
export const SALE_ORDER_CODE = {
  PREFIX: 'erp_',
  /** The earlier prefix, only for renaming old codes (migration + script). */
  OLD_PREFIX: 'sf_',
  SERIAL_DIGITS: 3,
} as const;

export const saleOrderCode = (date: string, serial: number): string =>
  `${SALE_ORDER_CODE.PREFIX}${date.replace(/-/g, '')}${String(serial).padStart(SALE_ORDER_CODE.SERIAL_DIGITS, '0')}`;

/** master_purchase_orders status values of a new PO, as PEPIMS writes them (mcaff_inv, checked 2026-10-08). */
export const NEW_PO_STATUS = {
  ACTIVE: PO_ACTIVE_STATUS.ACTIVE,
  PLANNING: 'Confirmed',
} as const;

/**
 * Brand spelling in the PO tables, as PEPIMS writes it ("MCaffeine", "Hyphen"); master_skus has "mCaffeine", "HYPHEN".
 * Keys are lower case. A brand not listed is kept as master_skus has it; "0" / empty = no brand.
 */
export const BRAND_NAMES: Record<string, string> = {
  mcaffeine: 'MCaffeine',
  hyphen: 'Hyphen',
};
export const NO_BRAND = ['', '0'];

/** The Uniware sale order upload: one CSV per PO, columns as in the user's sample P5654534_final_2026-09-24.csv. */
export const UNIWARE_CSV = {
  HEADERS: [
    'Sales Order Code',
    'Display Sales Order Code',
    'COD',
    'Channel',
    'Sale Order Item Code',
    'Shipping Method',
    'Item SKU Code',
    'Channel Product Id',
    'Selling Price',
    'On Hold',
    'Quantity',
    'Customer Code',
    'Facility Code',
    'PO Date',
  ],
  COD: '0',
  SHIPPING_METHOD: 'STD',
  ON_HOLD: 'FALSE',
  /** PO Date is filled with the PO's date (YYYY-MM-DD) when the PO has one, else empty. <PO>_final_<yyyy-mm-dd>.csv, next to the PO's processed.json (and in its S3 folder). */
  FILE_NAME: (poNumber: string, date: string) => `${poNumber}_final_${date}.csv`,
} as const;

/** An old sale order code inside text (a CSV cell): sf_ + 8-digit date + serial. */
export const OLD_SALE_ORDER_CODE = /\bsf_(\d{8}\d{3,})\b/g;
