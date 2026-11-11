import { round2, UNIWARE_CREATE, UNIWARE_CSV } from '../../constants';
import { parseCsv } from '../../utils/csv';

/*
 * The saleOrder/create request of one PO (2026-11-09, constants/uniware-create.ts), built from the PO's sale order CSV
 * (the verified copy in S3, the same rows a person would upload) + the delivery location's address. Pure: no database,
 * no network. Anything the API needs and the PO lacks is returned as `missing` (nothing is sent then).
 */

export interface OrderAddress {
  name: string | null;
  line1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
}

export interface CreateRequest {
  payload: { saleOrder: Record<string, unknown> };
  saleOrderCode: string;
  facility: string;
  items: number;
  value: number;
}

const H = UNIWARE_CSV.HEADERS;
const col = (name: (typeof H)[number]) => H.indexOf(name);
const cut = (v: string | null | undefined, max: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The CSV's rows (header checked) as cells by column name. */
export const csvLines = (text: string): Record<(typeof H)[number], string>[] => {
  const [header, ...rows] = parseCsv(text);
  if (!header || H.some((h, i) => (header[i] ?? '').trim() !== h)) throw new Error('the sale order CSV does not have the expected columns');
  return rows.map((r) => Object.fromEntries(H.map((h) => [h, (r[col(h)] ?? '').trim()])) as Record<(typeof H)[number], string>);
};

/** "2026-11-06" -> the PO date at 00:00 IST (displayOrderDateTime); anything else: not sent. */
const poDateTime = (d: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000+05:30` : null);

export const buildCreateRequest = (csvText: string, address: OrderAddress, phone: string): { request?: CreateRequest; missing: string[] } => {
  const lines = csvLines(csvText);
  const missing: string[] = [];
  if (!lines.length) missing.push('no lines in the sale order CSV');
  const first = lines[0];
  const one = (name: (typeof H)[number]) => {
    const values = [...new Set(lines.map((l) => l[name]))];
    if (values.length > 1) missing.push(`${name} differs between lines (${values.join(', ')})`);
    return values[0] ?? '';
  };
  const code = one('Sales Order Code');
  const facility = one('Facility Code');
  const customer = one('Customer Code');
  const channel = one('Channel');
  for (const [label, v] of [['sale order code', code], ['facility', facility], ['customer code', customer], ['Uniware channel', channel]] as const) {
    if (!v) missing.push(label);
  }
  const addr = {
    name: cut(address.name, UNIWARE_CREATE.MAX.NAME),
    line1: cut(address.line1, UNIWARE_CREATE.MAX.LINE1),
    city: cut(address.city, UNIWARE_CREATE.MAX.CITY),
    state: cut(address.state, UNIWARE_CREATE.MAX.STATE),
  };
  if (!addr.name) missing.push('address name (consignee name)');
  if (!addr.line1) missing.push('shipping address');
  if (!addr.city) missing.push('city');
  if (!addr.state) missing.push('state');
  if (!phone.trim()) missing.push('phone (UNIWARE_ORDER_PHONE)');

  // one item per unit (the API has no quantity)
  const items: Record<string, unknown>[] = [];
  let value = 0;
  lines.forEach((l, i) => {
    const qty = Number(l.Quantity);
    const price = Number(l['Selling Price']);
    const sku = l['Item SKU Code'];
    if (!sku) missing.push(`line ${i + 1}: SKU`);
    if (!Number.isInteger(qty) || qty <= 0) missing.push(`line ${i + 1}: quantity "${l.Quantity}"`);
    if (!Number.isFinite(price) || price < 0) missing.push(`line ${i + 1}: selling price "${l['Selling Price']}"`);
    if (!sku || !Number.isInteger(qty) || qty <= 0 || !Number.isFinite(price)) return;
    for (let u = 1; u <= qty; u++) {
      items.push({
        code: UNIWARE_CREATE.ITEM_CODE(l['Sale Order Item Code'] || sku, i + 1, u),
        itemSku: sku,
        shippingMethodCode: l['Shipping Method'] || UNIWARE_CSV.SHIPPING_METHOD,
        giftWrap: false,
        totalPrice: price,
        sellingPrice: price,
        prepaidAmount: price,
        discount: 0,
        shippingCharges: 0,
        packetNumber: 1,
      });
      value += price;
    }
  });
  if (missing.length) return { missing };

  const addressId = '1';
  const when = poDateTime(first['PO Date']);
  const saleOrder: Record<string, unknown> = {
    code,
    displayOrderCode: first['Display Sales Order Code'] || code,
    ...(when ? { displayOrderDateTime: when } : {}),
    channel,
    customerCode: customer,
    ...(address.gstin?.trim() ? { customerGSTIN: address.gstin.trim() } : {}),
    cashOnDelivery: false,
    paymentInstrument: UNIWARE_CREATE.PAYMENT,
    totalPrepaidAmount: round2(value),
    totalDiscount: 0,
    totalShippingCharges: 0,
    verificationRequired: UNIWARE_CREATE.VERIFICATION_REQUIRED,
    useVerifiedListings: UNIWARE_CREATE.USE_VERIFIED_LISTINGS,
    addresses: [{
      id: addressId, name: addr.name, addressLine1: addr.line1, city: addr.city, state: addr.state,
      country: UNIWARE_CREATE.COUNTRY, phone: cut(phone, UNIWARE_CREATE.MAX.PHONE),
      ...(/^\d{6}$/.test((address.pincode ?? '').trim()) ? { pincode: (address.pincode ?? '').trim() } : {}),
    }],
    billingAddress: { referenceId: addressId },
    shippingAddress: { referenceId: addressId },
    saleOrderItems: items,
  };
  return { request: { payload: { saleOrder }, saleOrderCode: code, facility, items: items.length, value: round2(value) }, missing };
};
