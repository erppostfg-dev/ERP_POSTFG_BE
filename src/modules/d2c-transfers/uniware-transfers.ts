import { env } from '../../config/env';
import { D2C_PRICE, D2C_SO_ITEM_CANCELLED, D2C_SO_ITEM_DONE, D2C_UNIWARE, d2cSoUnitPrice, round2 } from '../../constants';
import { HttpError } from '../intransit/sources/http';
import { UniwareApi, uniwareCatalog } from '../intransit/sources/uniware';

/*
 * Typed Uniware calls of D2C internal transfers (plan 4; contract proven by the SO write tests of 2026-11-03 on
 * TEST_FACILITY). Every call goes through ONE client per process (one login shared by the actions and, later, the
 * sync). The in-transit fetch runs in its own worker process with its own client.
 *   createSaleOrder  POST /oms/saleOrder/create  + Facility = sender. Same code again -> refused DUPLICATE_SALE_ORDER.
 *   getSaleOrder     POST /oms/saleorder/get (lower case) { code } + Facility -> saleOrderDTO; unknown code -> refused
 *                    INVALID_SALE_ORDER_CODE (= not found; read-only probe 2026-11-03).
 *   cancelSaleOrderItems  POST /oms/saleOrder/cancel { saleOrderCode, saleOrderItemCodes, cancellationReason } +
 *                    Facility: whole items only (no quantity).
 *   stockAt          POST /inventory/inventorySnapshot/get { itemTypeSKUs } + Facility; refused INVENTORY_NOT_AVAILABLE
 *                    when none of the SKUs has stock there (= 0 each).
 * Errors (plan 4 "error classes"): UniwareApi.post throws a plain Error "<path> refused: <errors JSON>" when Uniware
 * answers successful:false (a REFUSAL: it looked at the request and said no), and HttpError / a network or timeout
 * error otherwise (UNKNOWN: we cannot tell whether it acted). classify() tells them apart.
 * What goes into logs is trimmed (trim()): never the token or the login, which only UniwareApi holds.
 */

let shared: UniwareApi | null = null;

/** The process-wide client (plan 4). Throws when the UNIWARE_* keys are missing. */
export const uniwareClient = (): UniwareApi => {
  shared ??= uniwareCatalog(env.intransit.uniware);
  return shared;
};

/** Tests swap the client. */
export const setUniwareClient = (api: UniwareApi | null): void => {
  shared = api;
};

/** The parts of the client the calls use (a fake in tests). */
export type UniwarePoster = Pick<UniwareApi, 'post'>;

// ---- error classes ---------------------------------------------------------------------------------------------------

export interface UniwareRefusal { codes: number[]; messages: string[]; text: string }

const REFUSED = ' refused: ';

/** The errors of a refusal (successful:false), or null when the error is anything else (HTTP, network, timeout). */
export const refusalOf = (err: unknown): UniwareRefusal | null => {
  if (!(err instanceof Error) || err instanceof HttpError) return null;
  const i = err.message.indexOf(REFUSED);
  if (i < 0) return null;
  const raw = err.message.slice(i + REFUSED.length);
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    list = raw;
  }
  const items = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  const codes = items.map((e) => Number(e?.code)).filter((c) => Number.isFinite(c));
  const messages = items.length
    ? items.map((e) => [e?.message, e?.description].filter((x) => typeof x === 'string' && x).join(': ')).filter(Boolean)
    : [typeof list === 'string' ? list : JSON.stringify(list)];
  return { codes, messages, text: messages.join('; ') || raw };
};

export type ErrorClass = 'refused' | 'duplicate' | 'unknown';

/**
 * refused   = Uniware said no (the request was looked at; nothing was created);
 * duplicate = refused because the SO code already exists (an earlier request got through): reconcile with get;
 * unknown   = HTTP error, timeout, network: Uniware may or may not have acted.
 */
export const classify = (err: unknown): ErrorClass => {
  const r = refusalOf(err);
  if (!r) return 'unknown';
  return r.messages.some((m) => m.includes(D2C_UNIWARE.DUPLICATE_SALE_ORDER)) ? 'duplicate' : 'refused';
};

export const errorText = (err: unknown): string => {
  const r = refusalOf(err);
  if (r) return r.text;
  return err instanceof Error ? err.message : String(err);
};

/** A request / response as it goes into a log remark: JSON, cut to LOG_MAX characters. */
export const trim = (v: unknown, max: number = D2C_UNIWARE.LOG_MAX): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const clean = s.replace(/bearer\s+\S+/gi, 'bearer ***').replace(/("?(?:password|access_token|token)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

// ---- create ----------------------------------------------------------------------------------------------------------

export interface SoLineInput {
  /** details_purchase_orders.id */
  lineId: string;
  skuCode: string;
  qty: number;
  /** MRP of one unit (frozen at save: gmv / qty). */
  mrp: number;
}

export interface SoInput {
  code: string;
  /** Reference ID (master_purchase_orders.poNumber); '|' is accepted by Uniware. */
  displayOrderCode: string;
  /** Uniware channel code of the route. */
  channel: string;
  customerCode: string;
  /** Sender (dispatch) facility code. */
  facility: string;
  lines: SoLineInput[];
}

export const itemCodeOf = (lineId: string): string => `${D2C_UNIWARE.ITEM_CODE_PREFIX}${lineId}`;

/**
 * The create-SO body: one item per transfer line with its quantity (user, 2026-11-03), price = 15% of MRP (tax
 * included), totalPrice = price x qty. No address: Uniware takes it from the customer.
 */
export const buildSaleOrderPayload = (o: SoInput) => ({
  saleOrder: {
    code: o.code,
    displayOrderCode: o.displayOrderCode,
    channel: o.channel,
    customerCode: o.customerCode,
    cashOnDelivery: false,
    saleOrderItems: o.lines.filter((l) => l.qty > 0).map((l) => {
      const sellingPrice = d2cSoUnitPrice(l.mrp);
      return {
        code: itemCodeOf(l.lineId),
        itemSku: l.skuCode,
        quantity: l.qty,
        shippingMethodCode: D2C_UNIWARE.SHIPPING_METHOD,
        sellingPrice,
        totalPrice: round2(sellingPrice * l.qty),
        facilityCode: o.facility,
      };
    }),
  },
});

export const createSaleOrder = async (api: UniwarePoster, o: SoInput): Promise<{ request: unknown; response: Record<string, unknown> }> => {
  const request = buildSaleOrderPayload(o);
  const response = await api.post<Record<string, unknown>>(D2C_UNIWARE.CREATE_SO, request, o.facility);
  return { request, response };
};

// ---- get -------------------------------------------------------------------------------------------------------------

export interface SoItem {
  code: string;
  itemSku: string;
  statusCode: string;
  totalQuantity: number | null;
  cancelledQuantity: number | null;
  completedQuantity: number | null;
  cancellable: boolean | null;
}

export interface SoView {
  code: string;
  displayOrderCode: string | null;
  status: string;
  items: SoItem[];
  packages: { code: string; status: string }[];
}

/** A scalar field of an answer as text ('' when missing or not a scalar). */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const soViewOf = (dto: Record<string, unknown>): SoView => ({
  code: str(dto.code),
  displayOrderCode: (dto.displayOrderCode as string | null | undefined) ?? null,
  status: str(dto.status),
  items: ((dto.saleOrderItems as Record<string, unknown>[] | undefined) ?? []).map((i) => ({
    code: str(i.code),
    itemSku: str(i.itemSku),
    statusCode: str(i.statusCode).toUpperCase(),
    totalQuantity: numOrNull(i.totalQuantity ?? i.quantity),
    cancelledQuantity: numOrNull(i.cancelledQuantity),
    completedQuantity: numOrNull(i.completedQuantity),
    cancellable: typeof i.cancellable === 'boolean' ? i.cancellable : null,
  })),
  packages: ((dto.shippingPackages as Record<string, unknown>[] | undefined) ?? []).map((p) => ({ code: str(p.code), status: str(p.status) })),
});

/** The SO, or null when Uniware says the code is unknown. Any other error is thrown (the caller must not decide on it). */
export const getSaleOrder = async (api: UniwarePoster, code: string, facility: string): Promise<{ so: SoView | null; raw: unknown }> => {
  try {
    const body = await api.post<{ saleOrderDTO?: Record<string, unknown> }>(D2C_UNIWARE.GET_SO, { code }, facility);
    return { so: body.saleOrderDTO ? soViewOf(body.saleOrderDTO) : null, raw: body.saleOrderDTO ?? body };
  } catch (err) {
    const r = refusalOf(err);
    if (r && r.messages.some((m) => m.includes(D2C_UNIWARE.INVALID_SALE_ORDER_CODE))) return { so: null, raw: r.text };
    throw err;
  }
};

/** An item that can still be cancelled from the tool: not shipped, not cancelled already. */
export const isOpenItem = (i: SoItem): boolean => !D2C_SO_ITEM_DONE.includes(i.statusCode);
export const isCancelledItem = (i: SoItem): boolean => i.statusCode === D2C_SO_ITEM_CANCELLED;

/** A short "STATUS: L1 CREATED, L2 CANCELLED" for shipment_logs.uniware_status (varchar 100). */
export const statusLine = (so: SoView): string => `${so.status}: ${so.items.map((i) => `${i.code} ${i.statusCode}`).join(', ')}`.slice(0, 100);

// ---- cancel ----------------------------------------------------------------------------------------------------------

export const cancelSaleOrderItems = async (
  api: UniwarePoster, o: { code: string; facility: string; itemCodes: string[]; reason: string },
): Promise<{ request: unknown; response: Record<string, unknown> }> => {
  const request = { saleOrderCode: o.code, saleOrderItemCodes: o.itemCodes, cancellationReason: o.reason };
  const response = await api.post<Record<string, unknown>>(D2C_UNIWARE.CANCEL_SO, request, o.facility);
  return { request, response };
};

// ---- stock -----------------------------------------------------------------------------------------------------------

export interface StockRow { sku: string; inventory: number; openSale: number; inventoryBlocked: number; available: number }

/**
 * Units that can still be given to a new order: available = inventory - openSale - inventoryBlocked, never below 0.
 * (inventory = good stock on the shelves; openSale = already promised to open orders; inventoryBlocked = held back.)
 */
export const availableOf = (s: { inventory?: unknown; openSale?: unknown; inventoryBlocked?: unknown }): number =>
  Math.max(0, Number(s.inventory ?? 0) - Number(s.openSale ?? 0) - Number(s.inventoryBlocked ?? 0));

/** Stock of SKUs at one facility (SKU -> row, case-insensitive key); SKUs Uniware does not list count as 0. */
export const stockAt = async (api: UniwarePoster, facility: string, skus: string[]): Promise<Map<string, StockRow>> => {
  const out = new Map<string, StockRow>();
  const unique = [...new Set(skus)];
  for (let i = 0; i < unique.length; i += D2C_UNIWARE.STOCK_BATCH) {
    const part = unique.slice(i, i + D2C_UNIWARE.STOCK_BATCH);
    let rows: Record<string, unknown>[] = [];
    try {
      const body = await api.post<{ inventorySnapshots?: Record<string, unknown>[] }>(D2C_UNIWARE.STOCK, { itemTypeSKUs: part }, facility);
      rows = body.inventorySnapshots ?? [];
    } catch (err) {
      const r = refusalOf(err);
      if (!r || !r.messages.some((m) => m.includes(D2C_UNIWARE.INVENTORY_NOT_AVAILABLE))) throw err;
    }
    for (const r of rows) {
      const sku = str(r.itemTypeSKU);
      out.set(sku.toLowerCase(), {
        sku, inventory: Number(r.inventory ?? 0), openSale: Number(r.openSale ?? 0), inventoryBlocked: Number(r.inventoryBlocked ?? 0), available: availableOf(r),
      });
    }
  }
  return out;
};

// ---- inward PO + GRN (phase 7) -----------------------------------------------------------------------------------------
/*
 * Contract (live tests on TEST_FACILITY 2026-11-03; read-only reads of PO MGGN1/2627/API/0051 and GRN G8221 at
 * GGN_WAREHOUSE, fixtures in __tests__/fixtures): every call with Facility = the RECEIVING facility.
 *   createPurchaseOrder  /purchase/purchaseOrder/create -> { successful, purchaseOrderCode }; same code again -> refused
 *                        30002 DUPLICATE_CODE.
 *   getPurchaseOrder     /purchaseOrder/getPurchaseOrderDetails { purchaseOrderCode } -> code, statusCode (CREATED /
 *                        APPROVED / COMPLETE ...), vendorCode, customFieldValues [{ fieldName, fieldValue }],
 *                        purchaseOrderItems [{ itemSKU, quantity, pendingQuantity, rejectedQuantity, receivedQuantity }];
 *                        unknown code -> refused 80060 INVALID_PURCHASE_ORDER_CODE (= not found).
 *   grnCodesOf           /inflowReceipt/getInflowReceipts { purchaseOrderCode } -> inflowReceiptCodes [] (empty when none).
 *   getGrn               /inflowReceipt/getInflowReceipt { inflowReceiptCode } -> inflowReceipt { code, statusCode, created,
 *                        grnReceivedTimestamp, qcCompletedOn, vendorInvoiceNumber, purchaseOrder { code, statusCode },
 *                        totalQuantity, totalRejectedQuantity, inflowReceiptItems [{ itemSKU, quantity, rejectedQuantity,
 *                        status }] }.
 */

export interface InwardPoItem { sku: string; qty: number }
export interface InwardPoInput {
  /** Our code: <SO code>-<n>. */
  code: string;
  vendorCode: string;
  /** Receiving facility code (Facility header). */
  facility: string;
  /** SO code -> custom field ReferenceNo. */
  soCode: string;
  /** Reference ID -> custom field ReferenceOrder. */
  reference: string;
  /** 'YYYY-MM-DD': "Receive by", picked in the dialog -> Uniware deliveryDate. */
  receiveBy: string;
  /** 'YYYY-MM-DD': PO date (the day it is created) + D2C_INWARD_PO.EXPIRY_DAYS -> Uniware expiryDate. */
  expiry: string;
  items: InwardPoItem[];
}

/** The create-PO body: qty per SKU = dispatched on that invoice (0 left out), unit price 1 (user, 2026-11-03). */
export const buildInwardPoPayload = (o: InwardPoInput) => ({
  purchaseOrderCode: o.code,
  vendorCode: o.vendorCode,
  expiryDate: o.expiry,
  deliveryDate: o.receiveBy,
  purchaseOrderItems: o.items.filter((i) => i.qty > 0).map((i) => ({ itemSKU: i.sku, quantity: i.qty, unitPrice: D2C_PRICE.INWARD_PO_UNIT_PRICE })),
  customFieldValues: [
    { name: D2C_UNIWARE.PO_FIELD_SO, value: o.soCode },
    { name: D2C_UNIWARE.PO_FIELD_REFERENCE, value: o.reference },
  ],
});

export const createPurchaseOrder = async (api: UniwarePoster, o: InwardPoInput): Promise<{ request: unknown; response: Record<string, unknown> }> => {
  const request = buildInwardPoPayload(o);
  const response = await api.post<Record<string, unknown>>(D2C_UNIWARE.CREATE_PO, request, o.facility);
  return { request, response };
};

/** duplicate = refused because the PO code exists (30002 DUPLICATE_CODE); else as classify(). */
export const classifyPo = (err: unknown): ErrorClass => {
  const r = refusalOf(err);
  if (!r) return 'unknown';
  return r.codes.includes(D2C_UNIWARE.DUPLICATE_CODE_NO) || r.messages.some((m) => m.includes(D2C_UNIWARE.DUPLICATE_CODE)) ? 'duplicate' : 'refused';
};

export interface PoDetail {
  code: string; status: string; vendorCode: string | null;
  /** custom field name -> value */
  fields: Record<string, string>;
  items: { sku: string; qty: number; pending: number; rejected: number; received: number }[];
}

const int0 = (v: unknown): number => Math.max(0, Math.round(numOrNull(v) ?? 0));

export const poDetailOf = (body: Record<string, unknown>): PoDetail => ({
  code: str(body.code ?? body.purchaseOrderCode),
  status: str(body.statusCode).toUpperCase(),
  vendorCode: str(body.vendorCode) || null,
  fields: Object.fromEntries(((body.customFieldValues as Record<string, unknown>[] | undefined) ?? [])
    .map((f) => [str(f.fieldName ?? f.name), str(f.fieldValue ?? f.value)] as [string, string]).filter(([k]) => k)),
  items: ((body.purchaseOrderItems as Record<string, unknown>[] | undefined) ?? []).map((i) => ({
    sku: str(i.itemSKU), qty: int0(i.quantity), pending: int0(i.pendingQuantity), rejected: int0(i.rejectedQuantity), received: int0(i.receivedQuantity),
  })),
});

/** The PO, or null when Uniware says the code is unknown. Any other error is thrown (the caller must not decide on it). */
export const getPurchaseOrder = async (api: UniwarePoster, code: string, facility: string): Promise<{ po: PoDetail | null; raw: unknown }> => {
  try {
    const body = await api.post<Record<string, unknown>>(D2C_UNIWARE.PO_DETAILS, { purchaseOrderCode: code }, facility);
    return { po: poDetailOf(body), raw: body };
  } catch (err) {
    const r = refusalOf(err);
    if (r && r.messages.some((m) => m.includes(D2C_UNIWARE.INVALID_PURCHASE_ORDER_CODE))) return { po: null, raw: r.text };
    throw err;
  }
};

export const grnCodesOf = async (api: UniwarePoster, poCode: string, facility: string): Promise<string[]> => {
  const body = await api.post<{ inflowReceiptCodes?: unknown[] }>(D2C_UNIWARE.GRN_LIST, { purchaseOrderCode: poCode }, facility);
  return (body.inflowReceiptCodes ?? []).map(str).filter(Boolean);
};

export interface GrnDetail {
  code: string; status: string; poCode: string | null; vendorInvoiceNumber: string | null;
  /** Done time: qcCompletedOn, else grnReceivedTimestamp, else created. */
  doneAt: Date | null;
  /** Per SKU (as Uniware spells it): accepted = quantity - rejectedQuantity. */
  items: { sku: string; qty: number; rejected: number; accepted: number }[];
  accepted: number; rejected: number;
}

const msTime = (v: unknown): Date | null => {
  const n = numOrNull(v);
  return n && n > 0 ? new Date(Math.floor(n / 1000) * 1000) : null;
};

export const grnDetailOf = (r: Record<string, unknown>): GrnDetail => {
  const items = ((r.inflowReceiptItems as Record<string, unknown>[] | undefined) ?? []).map((i) => {
    const qty = int0(i.quantity);
    const rejected = Math.min(qty, int0(i.rejectedQuantity));
    return { sku: str(i.itemSKU), qty, rejected, accepted: qty - rejected };
  });
  const po = (r.purchaseOrder as Record<string, unknown> | null | undefined) ?? null;
  return {
    code: str(r.code), status: str(r.statusCode).toUpperCase(), poCode: po ? str(po.code) || null : null,
    vendorInvoiceNumber: str(r.vendorInvoiceNumber) || null,
    doneAt: msTime(r.qcCompletedOn) ?? msTime(r.grnReceivedTimestamp) ?? msTime(r.created),
    items, accepted: items.reduce((s, i) => s + i.accepted, 0), rejected: items.reduce((s, i) => s + i.rejected, 0),
  };
};

export const getGrn = async (api: UniwarePoster, code: string, facility: string): Promise<GrnDetail> => {
  const body = await api.post<{ inflowReceipt?: Record<string, unknown> }>(D2C_UNIWARE.GRN_GET, { inflowReceiptCode: code }, facility);
  if (!body.inflowReceipt) throw new Error(`${D2C_UNIWARE.GRN_GET}: no inflowReceipt in the answer for ${code}`);
  return grnDetailOf(body.inflowReceipt);
};
