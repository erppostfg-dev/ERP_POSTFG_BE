import { PO_UNIWARE_SYNC, round2 } from '../../constants';
import { refusalMessages, UniwarePoster } from './uniware-client';

/*
 * One sale order as Uniware's saleorder/get answers it (saleOrderDTO), reduced to what the channel PO sync reads.
 * Our own copy (2026-11-06, the same parsing as D2C's soDetailOf, proven on the read-only probes of 2026-11-03).
 */

export interface SoDetailItem {
  code: string; itemSku: string; statusCode: string;
  /** Uniware gave the quantities (false on a cancelled SO, seen live: counts null; then the status decides). */
  counted: boolean;
  total: number; cancelled: number; completed: number; sellingPrice: number | null;
}
export interface SoDetailPackage {
  code: string; status: string; dispatchedAt: Date | null;
  invoiceCode: string | null; invoiceDisplayCode: string | null; invoiceDate: Date | null;
  /** Invoice value: collectableAmount, else qty x the item's selling price. */
  value: number | null;
}
export interface SoDetail { code: string; status: string; items: SoDetailItem[]; packages: SoDetailPackage[] }

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strOrNull = (v: unknown): string | null => (str(v) ? str(v) : null);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v: unknown): number => Math.max(0, Math.round(numOrNull(v) ?? 0));
/** Uniware epoch milliseconds -> Date (whole seconds). */
const timeOf = (v: unknown): Date | null => {
  const n = numOrNull(v);
  return n && n > 0 ? new Date(Math.floor(n / 1000) * 1000) : null;
};

/** saleOrderDTO -> SoDetail. */
export const soDetailOf = (dto: Record<string, unknown>): SoDetail => {
  const items: SoDetailItem[] = ((dto.saleOrderItems as Record<string, unknown>[] | undefined) ?? []).map((i) => {
    const counted = numOrNull(i.totalQuantity) !== null;
    return {
      code: str(i.code), itemSku: str(i.itemSku), statusCode: str(i.statusCode).toUpperCase(), counted,
      total: counted ? int(i.totalQuantity) : 0, cancelled: counted ? int(i.cancelledQuantity) : 0, completed: int(i.completedQuantity),
      sellingPrice: numOrNull(i.sellingPrice),
    };
  });
  const priceOf = (sku: string) => items.find((i) => i.itemSku.toLowerCase() === sku.toLowerCase())?.sellingPrice ?? null;
  const packages: SoDetailPackage[] = ((dto.shippingPackages as Record<string, unknown>[] | undefined) ?? []).map((p) => {
    const lines = Object.entries((p.items as Record<string, Record<string, unknown>> | undefined) ?? {}).map(([key, v]) => ({ sku: str(v?.itemSku) || key, qty: int(v?.quantity) }));
    const collectable = numOrNull(p.collectableAmount);
    const priced = lines.length && lines.every((x) => priceOf(x.sku) !== null) ? round2(lines.reduce((s, x) => s + x.qty * (priceOf(x.sku) as number), 0)) : null;
    return {
      code: str(p.code), status: str(p.status).toUpperCase(), dispatchedAt: timeOf(p.dispatched),
      invoiceCode: strOrNull(p.invoiceCode), invoiceDisplayCode: strOrNull(p.invoiceDisplayCode), invoiceDate: timeOf(p.invoiceDate),
      value: collectable !== null && collectable > 0 ? round2(collectable) : priced,
    };
  });
  return { code: str(dto.code), status: str(dto.status).toUpperCase(), items, packages };
};

/** saleorder/get: the sale order, or null when Uniware does not know the code (not uploaded yet). Other errors throw. */
export const readSaleOrder = async (api: UniwarePoster, code: string, facility: string): Promise<SoDetail | null> => {
  try {
    const body = await api.post<{ saleOrderDTO?: Record<string, unknown> }>(PO_UNIWARE_SYNC.GET_SO, { code }, facility);
    return body.saleOrderDTO ? soDetailOf(body.saleOrderDTO) : null;
  } catch (err) {
    if (refusalMessages(err)?.some((m) => m.includes(PO_UNIWARE_SYNC.INVALID_SALE_ORDER_CODE))) return null;
    throw err;
  }
};
