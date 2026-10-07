import { ProcessedPo } from './processed-po';

/*
 * PO amounts, the same meaning in every channel (user, 2026-10-07, option B):
 *   po_value      = before discount (the sum of the line totals)
 *   cart_discount = the discount
 *   net_amount    = payable, after discount
 */

/**
 * For channels whose PO format has no discount at all (Zepto, BigBasket): cart_discount = 0 and
 * net_amount = po_value, marked "calculated". Never used for channels that do have discounts (Blinkit, FirstCry):
 * there a missing value stays "" with a warning instead of being invented.
 */
export const noDiscountAmounts = (po: ProcessedPo): void => {
  if (po.po_value === '') return;
  po.cart_discount = 0;
  po.net_amount = po.po_value;
  po.field_sources.cart_discount = 'calculated';
  po.field_sources.net_amount = 'calculated';
};

/** a - b rounded to paise, or "" when either is missing. */
export const minus = (a: number | '', b: number | ''): number | '' =>
  typeof a === 'number' && typeof b === 'number' ? Math.round((a - b) * 100) / 100 : '';
