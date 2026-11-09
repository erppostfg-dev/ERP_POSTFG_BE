/*
 * Create in Uniware (2026-11-09, user: "select multiple and create the sale order from here, no download / upload";
 * Uniware stays read-only EXCEPT this one call). From the Processed tab: ticked, verified POs -> their sale orders are
 * created through POST /services/rest/v1/oms/saleOrder/create (documentation.unicommerce.com/docs/saleorder-create.html),
 * from the SAME rows as the sale order CSV (the CSV in S3 is the verified copy), + the location's address.
 *   - OFF unless UNIWARE_CREATE_ENABLED=true (always off on a laptop); UNIWARE_ORDER_PHONE must be set (the API needs a
 *     phone on the address, the CSV never sent one);
 *   - a queue table (uniware_creates), worked CONCURRENCY at a time; restart-safe: a row left "creating" goes back to
 *     "queued", and every create first asks Uniware (saleorder/get) whether the code is already there, so a retry never
 *     makes a second order; an error / timeout is followed by the same read-back;
 *   - created (or already there) = the PO is marked uploaded (who asked, when), History says so, and the status sync
 *     reads it at once. Updates / cancels in Uniware: never.
 * TO CONFIRM with the Uniware admin before switching ON (message sent by the user 2026-11-09): permission, duplicate
 * code behaviour, items per order, address / phone with a customer code, the two verification flags below.
 */
export const UNIWARE_CREATE = {
  CREATE_SO: '/services/rest/v1/oms/saleOrder/create',
  /** Most POs in one click. */
  MAX_IDS: 50,
  /** POs created at a time, and the pause between calls (the API user is shared with in-transit / D2C). */
  CONCURRENCY: 2,
  CALL_GAP_MS: 500,
  /** A failed create is tried again by the worker up to this many times in all (each try reads back first). */
  MAX_ATTEMPTS: 3,
  /** The documented defaults are true; the CSV import does not verify: to confirm (question 3d to the admin). */
  VERIFICATION_REQUIRED: false,
  USE_VERIFIED_LISTINGS: false,
  /** The API has no quantity: one item per unit, item code <Sale Order Item Code>-<line>-<unit>. */
  ITEM_CODE: (sku: string, line: number, unit: number) => `${sku}-${line}-${unit}`,
  /** Address limits of the API. */
  MAX: { NAME: 100, LINE1: 500, CITY: 100, STATE: 45, PHONE: 100 },
  COUNTRY: 'IN',
  PAYMENT: 'CASH',
  ROUTE: '/uniware-create',
  /** Preview (2026-11-09): the same checks + request, nothing sent or written; works with Create off (laptop too). */
  PREVIEW_ROUTE: '/uniware-create/preview',
  /** Stands in for UNIWARE_ORDER_PHONE in a preview when it is not set (reported as phoneSet: false). */
  PREVIEW_PHONE: '(UNIWARE_ORDER_PHONE not set)',
  BODY_IDS: 'uploadIds',
  QUERY_IDS: 'uploadIds',
} as const;

export const UNIWARE_CREATE_STATUS = {
  QUEUED: 'queued',
  CREATING: 'creating',
  /** Created by this request. */
  CREATED: 'created',
  /** Uniware already had the code (created earlier, by hand or by a lost answer): nothing sent. */
  EXISTS: 'exists',
  FAILED: 'failed',
} as const;
export type UniwareCreateStatus = (typeof UNIWARE_CREATE_STATUS)[keyof typeof UNIWARE_CREATE_STATUS];
/** Still being worked on: a second request for the same PO is refused. */
export const UNIWARE_CREATE_OPEN: readonly UniwareCreateStatus[] = [UNIWARE_CREATE_STATUS.QUEUED, UNIWARE_CREATE_STATUS.CREATING];
